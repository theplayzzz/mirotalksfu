#!/usr/bin/env bash
#
# Deploys a MiroTalk image to the development or production instance of THIS server. Run it on the server.
#
#   ops/deploy.sh dev  ghcr.io/theplayzzz/mirotalksfu@sha256:<digest>
#   ops/deploy.sh dev  sha-1a2b3c4              a tag; what gets deployed is the digest it points to
#   ops/deploy.sh prod <image> [--force] [--accept-drift]
#   ops/deploy.sh prod <image> --check          only reports what would happen, changes nothing
#
# It checks the situation, backs up the compose file, pulls the image, points the compose file at the image
# digest, recreates the container, waits until it is healthy and checks that the browser files it serves are
# the ones inside the image. If anything fails after the container was touched, it puts the previous compose
# file back and recreates the container again.
#
# Production is protected:
#   - it aborts while people are connected (--force overrides);
#   - it aborts when the container that is running does not use the image the compose file names, because
#     "docker compose up" would silently swap the image (--accept-drift is the deliberate way out of that).

set -euo pipefail

REGISTRY=ghcr.io/theplayzzz/mirotalksfu
MIN_FREE_GB=10

usage() { sed -n '3,20p' "$0"; exit 2; }
die() { echo "!! $*" >&2; exit 1; }
docker() { sudo docker "$@"; }

ENVIRONMENT=${1:-}
IMAGE_ARG=${2:-}
[ -n "$ENVIRONMENT" ] && [ -n "$IMAGE_ARG" ] || usage
shift 2
FORCE=0
DRIFT=0
CHECK=0
for flag in "$@"; do
    case "$flag" in
        --force) FORCE=1 ;;
        --accept-drift) DRIFT=1 ;;
        --check) CHECK=1 ;;
        *) usage ;;
    esac
done

case "$ENVIRONMENT" in
    dev) DIR=/home/debian/mirotalk-dev; PROJECT=mirotalksfu-join-ui; SERVICE=mirotalksfu-dev; PORT=3013 ;;
    prod) DIR=/home/debian/mirotalksfu; PROJECT=mirotalksfu; SERVICE=mirotalksfu; PORT=3012 ;;
    *) usage ;;
esac
CONTAINER=$SERVICE
COMPOSE=$DIR/compose.yaml
[ -f "$COMPOSE" ] || die "$COMPOSE does not exist (copy ops/compose.$ENVIRONMENT.yaml there first)"

case "$IMAGE_ARG" in
    *@sha256:*) REF=$IMAGE_ARG ;;
    "$REGISTRY":*) REF=$IMAGE_ARG ;;
    sha-* | main | develop) REF=$REGISTRY:$IMAGE_ARG ;;
    *) die "image must be $REGISTRY@sha256:..., or a tag such as sha-1a2b3c4 / main / develop" ;;
esac

echo "== $ENVIRONMENT: $REF"

# ---- 1. is it safe to touch this instance? -------------------------------------------------------------------
CONNECTIONS=$(ss -Htn state established "( dport = :$PORT )" | wc -l)
RUNNING_ID=$(docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null || true)
COMPOSE_IMAGE=$(grep -m1 -E '^[[:space:]]+image:' "$COMPOSE" | awk '{print $2}')
COMPOSE_ID=$(docker image inspect -f '{{.Id}}' "$COMPOSE_IMAGE" 2>/dev/null || true)

echo "connections to the room: $CONNECTIONS"
echo "running container image: ${RUNNING_ID:-none}"
echo "compose file names:      $COMPOSE_IMAGE (${COMPOSE_ID:-not present on this server})"
PROBLEMS=0
if [ "$CONNECTIONS" -gt 0 ]; then
    if [ "$ENVIRONMENT" = prod ] && [ "$FORCE" -ne 1 ]; then
        echo "!! people are connected to production; deploying would drop them (--force to deploy anyway)"
        PROBLEMS=1
    else
        echo "(warning: people are connected, they will be dropped)"
    fi
fi

if [ "$ENVIRONMENT" = prod ] && [ -n "$RUNNING_ID" ] && [ "$RUNNING_ID" != "$COMPOSE_ID" ] && [ "$DRIFT" -ne 1 ]; then
    echo "!! the running container is not the image the compose file names: 'docker compose up' would swap it."
    echo "   Look at 'docker diff $CONTAINER' first; --accept-drift deploys anyway"
    PROBLEMS=1
fi

FREE_GB=$(df --output=avail -BG / | tail -1 | tr -dc '0-9')
if [ "$FREE_GB" -lt "$MIN_FREE_GB" ]; then
    echo "!! only ${FREE_GB} GB free on /, need $MIN_FREE_GB GB"
    PROBLEMS=1
fi

if [ "$CHECK" -eq 1 ]; then
    echo "free disk: ${FREE_GB} GB"
    [ "$PROBLEMS" -eq 0 ] && echo "== check: nothing in the way, a real run would go ahead" || echo "== check: a real run would stop at the lines marked with !!"
    exit "$PROBLEMS"
fi
[ "$PROBLEMS" -eq 0 ] || exit 1

# ---- 2. get the image and pin its digest ---------------------------------------------------------------------
docker pull --quiet "$REF" > /dev/null
if [[ $REF == *@sha256:* ]]; then
    DIGEST=$REF
else
    DIGEST=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$REF" | grep "^$REGISTRY@" | head -1)
fi
[ -n "$DIGEST" ] || die "could not resolve the digest of $REF"
IMAGE_ID=$(docker image inspect -f '{{.Id}}' "$DIGEST")
echo "digest: $DIGEST"
echo "image id: $IMAGE_ID"

# ---- 3. switch ------------------------------------------------------------------------------------------------
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP=$COMPOSE.pre-deploy-$STAMP
cp -a "$COMPOSE" "$BACKUP"

awk -v img="$DIGEST" '
    !done && /^[[:space:]]+image:[[:space:]]/ { sub(/image:[[:space:]].*/, "image: " img); done = 1 }
    { print }
' "$BACKUP" > "$COMPOSE.new"
mv "$COMPOSE.new" "$COMPOSE"

compose() { docker compose -p "$PROJECT" -f "$COMPOSE" "$@"; }

rollback() {
    echo "!! $1 - putting the previous compose file back"
    cp -a "$BACKUP" "$COMPOSE"
    compose up -d --no-build --force-recreate "$SERVICE" || true
    echo "$STAMP $ENVIRONMENT FAILED $DIGEST ($1)" >> "$DIR/deploy-history.log"
    exit 1
}

compose config --quiet || { cp -a "$BACKUP" "$COMPOSE"; die "the new compose file is not valid, nothing was changed"; }
compose up -d --no-build --force-recreate "$SERVICE"

# ---- 4. wait and verify --------------------------------------------------------------------------------------
HEALTH=starting
for _ in $(seq 1 60); do
    HEALTH=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo missing)
    [ "$HEALTH" = healthy ] && break
    sleep 3
done
[ "$HEALTH" = healthy ] || rollback "the container is '$HEALTH' after 3 minutes"

NOW_ID=$(docker inspect -f '{{.Image}}' "$CONTAINER")
[ "$NOW_ID" = "$IMAGE_ID" ] || rollback "the container runs $NOW_ID instead of $IMAGE_ID"

for file in js/RoomClient.js js/Room.js; do
    INSIDE=$(docker exec "$CONTAINER" sha256sum "/src/public/$file" | cut -d' ' -f1)
    SERVED=$(curl -fsS --max-time 15 "http://127.0.0.1:$PORT/$file" | sha256sum | cut -d' ' -f1) || SERVED=failed
    [ "$INSIDE" = "$SERVED" ] || rollback "/$file served by the app differs from the file in the image"
done

echo "$STAMP $ENVIRONMENT OK $DIGEST (previous: ${COMPOSE_IMAGE:-none}, backup: $BACKUP)" >> "$DIR/deploy-history.log"
echo "== done: $ENVIRONMENT is healthy on $DIGEST"
echo "   previous compose file: $BACKUP   (ops/rollback.sh $ENVIRONMENT goes back to it)"
