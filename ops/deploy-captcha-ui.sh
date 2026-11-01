#!/usr/bin/env bash
# Development only: publish allowlisted CAPTCHA browser files from a built image.
# No server code, environment, data, media, container restart or production changes.
# Usage: bash ops/deploy-captcha-ui.sh sha-<commit>
set -euo pipefail
docker() { sudo -n docker "$@"; }
REF=${1:?provide a built image tag}
[[ $REF =~ ^sha-[a-f0-9]{7,40}$ ]] || { echo 'Expected sha-<commit>' >&2; exit 2; }
REGISTRY=ghcr.io/theplayzzz/mirotalksfu
CONTAINER=mirotalksfu-dev
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
STAGE=/home/debian/mirotalk-dev/frontend-rollouts/$STAMP-$REF
mkdir -p "$STAGE/new" "$STAGE/backup"
BEFORE=$(docker inspect -f '{{.Id}} {{.State.StartedAt}}' "$CONTAINER")
docker pull --quiet "$REGISTRY:$REF" >/dev/null
DIGEST=$(docker image inspect -f '{{index .RepoDigests 0}}' "$REGISTRY:$REF")
SOURCE=$(docker create --entrypoint /bin/true "$DIGEST")
trap 'docker rm "$SOURCE" >/dev/null 2>&1 || true' EXIT
for FILE in public/js/RoomCaptcha.js public/css/RoomCaptcha.css app/captcha-admin/CaptchaAdmin.html app/captcha-admin/admin.js app/captcha-admin/admin.css app/captcha-player/room.html; do
    mkdir -p "$STAGE/new/$(dirname "$FILE")" "$STAGE/backup/$(dirname "$FILE")"
    docker cp "$SOURCE:/src/$FILE" "$STAGE/new/$FILE"
    docker cp "$CONTAINER:/src/$FILE" "$STAGE/backup/$FILE"
done
docker cp "$SOURCE:/src/app/captcha-player/assets" "$STAGE/new/assets"
for file in app/src/CaptchaControl.js app/src/CaptchaRoutes.js; do
    docker cp "$SOURCE:/src/$file" "$STAGE/new/$(basename "$file")"
    expected=$(sha256sum "$STAGE/new/$(basename "$file")" | cut -d' ' -f1)
    actual=$(docker exec "$CONTAINER" sha256sum "/src/$file" | cut -d' ' -f1)
    [ "$expected" = "$actual" ] || { echo "Server protocol differs ($file); use a normal deploy when the room is empty" >&2; exit 1; }
done
# Keep old hashed assets so already-open player windows can finish their round.
docker cp "$STAGE/new/assets/." "$CONTAINER:/src/app/captcha-player/assets/"
publish() {
    local root=$1 file=$2 target=/src/$2
    docker cp "$root/$file" "$CONTAINER:$target.$REF"
    docker exec -u 0 "$CONTAINER" node -e 'require("node:fs").renameSync(process.argv[1],process.argv[2])' "$target.$REF" "$target"
}
FILES=(app/captcha-player/room.html app/captcha-admin/admin.css app/captcha-admin/admin.js app/captcha-admin/CaptchaAdmin.html public/css/RoomCaptcha.css public/js/RoomCaptcha.js)
rollback() {
    for file in "${FILES[@]}"; do publish "$STAGE/backup" "$file" || true; done
    echo "$STAMP FAILED $DIGEST restored=$STAGE/backup" >> /home/debian/mirotalk-dev/frontend-history.log
    exit 1
}
for file in "${FILES[@]}"; do publish "$STAGE/new" "$file" || rollback; done
for pair in 'public/js/RoomCaptcha.js|/js/RoomCaptcha.js' 'public/css/RoomCaptcha.css|/css/RoomCaptcha.css' 'app/captcha-player/room.html|/dev/captcha/play/room.html' 'app/captcha-admin/CaptchaAdmin.html|/dev/captcha/' 'app/captcha-admin/admin.js|/dev/captcha/ui/admin.js'; do
    file=${pair%%|*}; url=${pair#*|}
    expected=$(sha256sum "$STAGE/new/$file" | cut -d' ' -f1)
    actual=$(curl -fsS --max-time 15 "http://127.0.0.1:3013$url" | sha256sum | cut -d' ' -f1) || rollback
    [ "$expected" = "$actual" ] || rollback
done
AFTER=$(docker inspect -f '{{.Id}} {{.State.StartedAt}}' "$CONTAINER")
[ "$BEFORE" = "$AFTER" ] || { echo 'Unexpected container restart' >&2; exit 1; }
echo "$STAMP OK $DIGEST base=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER") backup=$STAGE/backup" >> /home/debian/mirotalk-dev/frontend-history.log
echo "CAPTCHA UI published from $DIGEST; container and calls were not restarted. Backup: $STAGE/backup"
