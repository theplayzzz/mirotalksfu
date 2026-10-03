#!/usr/bin/env bash
#
# Goes back to the compose file that was in place before the last ops/deploy.sh. Run it on the server.
#
#   ops/rollback.sh dev
#   ops/rollback.sh prod [--force]       aborts while people are connected unless --force
#
# The images stay on the server, so going back only recreates the container (about 10 seconds of downtime).

set -euo pipefail

usage() { sed -n '3,9p' "$0"; exit 2; }
die() { echo "!! $*" >&2; exit 1; }
docker() { sudo docker "$@"; }

ENVIRONMENT=${1:-}
[ -n "$ENVIRONMENT" ] || usage
shift
FORCE=0
for flag in "$@"; do
    case "$flag" in
        --force) FORCE=1 ;;
        *) usage ;;
    esac
done

case "$ENVIRONMENT" in
    dev) DIR=/home/debian/mirotalk-dev; PROJECT=mirotalksfu-join-ui; SERVICE=mirotalksfu-dev; PORT=3013 ;;
    prod) DIR=/home/debian/mirotalksfu; PROJECT=mirotalksfu; SERVICE=mirotalksfu; PORT=3012 ;;
    *) usage ;;
esac
COMPOSE=$DIR/compose.yaml

CONNECTIONS=$(ss -Htn state established "( dport = :$PORT )" | wc -l)
if [ "$ENVIRONMENT" = prod ] && [ "$CONNECTIONS" -gt 0 ] && [ "$FORCE" -ne 1 ]; then
    die "people are connected to production (--force to roll back anyway)"
fi

PREVIOUS=$(ls -1t "$COMPOSE".pre-deploy-* 2>/dev/null | grep -v '\.used$' | head -1 || true)
[ -n "$PREVIOUS" ] || die "no earlier compose file found next to $COMPOSE"

echo "== $ENVIRONMENT: back to $PREVIOUS"
grep -m1 -E '^[[:space:]]+image:' "$PREVIOUS"

cp -a "$COMPOSE" "$COMPOSE.rolled-back-from"
cp -a "$PREVIOUS" "$COMPOSE"
mv "$PREVIOUS" "$PREVIOUS.used"

docker compose -p "$PROJECT" -f "$COMPOSE" up -d --no-build --force-recreate "$SERVICE"

HEALTH=starting
for _ in $(seq 1 60); do
    HEALTH=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$SERVICE" 2>/dev/null || echo missing)
    [ "$HEALTH" = healthy ] && break
    sleep 3
done
echo "$(date -u +%Y%m%dT%H%M%SZ) $ENVIRONMENT ROLLBACK to $PREVIOUS ($HEALTH)" >> "$DIR/deploy-history.log"
[ "$HEALTH" = healthy ] || die "the container is '$HEALTH' after the rollback, look at: sudo docker logs $SERVICE"
echo "== done: $ENVIRONMENT is healthy again"
