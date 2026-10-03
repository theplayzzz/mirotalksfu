#!/usr/bin/env bash
#
# One-time preparation of the development instance on the server. Safe to run again: it never overwrites a
# file that exists. Run it on the server, then copy ops/compose.dev.yaml to /home/debian/mirotalk-dev/compose.yaml
# and deploy with ops/deploy.sh dev <image>.
#
# Creates:
#   /home/debian/.config/mirotalksfu-dev/dev.env        the settings of production with its own signing secrets
#   /home/debian/.config/mirotalksfu-dev/test-room.env  the test room id and the key that signs its tokens
#   /home/debian/mirotalk-dev/data/health               where the health meter writes (owned by uid 1000)

set -euo pipefail

CONF=/home/debian/.config/mirotalksfu-dev
DEV=/home/debian/mirotalk-dev
PROD_ENV=/home/debian/mirotalksfu/.env

random_hex() { openssl rand -hex 32 2> /dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

install -d -m 700 "$CONF"
install -d -m 755 "$DEV" "$DEV/data"
install -d -m 755 -o 1000 -g 1000 "$DEV/data/health" 2> /dev/null || sudo install -d -m 755 -o 1000 -g 1000 "$DEV/data/health"

umask 077

if [ ! -f "$CONF/dev.env" ]; then
    # Same settings as production, but its own signing secrets: a token or API key from one instance
    # must never work on the other.
    grep -v -E '^(JWT_SECRET|API_KEY_SECRET)=' "$PROD_ENV" > "$CONF/dev.env"
    {
        echo "JWT_SECRET=$(random_hex)"
        echo "API_KEY_SECRET=$(random_hex)"
    } >> "$CONF/dev.env"
    echo "created $CONF/dev.env"
else
    echo "kept    $CONF/dev.env"
fi

if [ ! -f "$CONF/test-room.env" ]; then
    {
        echo "DEV_TEST_ROOM_ID=teste"
        echo "DEV_TEST_ROOM_KEY=$(random_hex)"
    } > "$CONF/test-room.env"
    echo "created $CONF/test-room.env"
else
    echo "kept    $CONF/test-room.env"
fi

if [ ! -f "$CONF/replay.env" ]; then
    echo "REPLAY_INTERNAL_SECRET=$(random_hex)" > "$CONF/replay.env"
    echo "created $CONF/replay.env"
else
    echo "kept    $CONF/replay.env"
fi

install -d -m 755 -o 1000 -g 1000 "$DEV/data/replays" 2> /dev/null || sudo install -d -m 755 -o 1000 -g 1000 "$DEV/data/replays"

ls -la "$CONF" "$DEV/data"
