#!/usr/bin/env bash
#
# Prepares the files that the production compose file (ops/compose.prod.yaml) refers to, and nothing else: it does
# not touch a running container, does not read or change the production .env, and never overwrites a file that
# exists. Safe to run while the room is in use. Run it on the server.
#
# Creates:
#   /home/debian/.config/mirotalksfu-prod/features.env   the switches of the new features, all of them off (comments only)
#   /home/debian/.config/mirotalksfu-prod/replay.env     the secret the SFU and the replay recorder share
#   /home/debian/mirotalksfu/data/health, data/replays   where the health meter and the recorder write (owned by uid 1000)

set -euo pipefail

CONF=/home/debian/.config/mirotalksfu-prod
PROD=/home/debian/mirotalksfu

random_hex() { openssl rand -hex 32 2> /dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

install -d -m 700 "$CONF"
umask 077

if [ ! -f "$CONF/features.env" ]; then
    cat > "$CONF/features.env" << 'EOF'
# The switches of the new features of the room. A line without a # turns that feature on; the room behaves as it
# did before any of this while every line has a # in front. After changing this file, apply it with
#   cd /home/debian/mirotalksfu && docker compose up -d --force-recreate mirotalksfu     (see docs/PRODUCTION-ROLLOUT.md)

# The health meter: every browser reports how its screens are doing (frames, freezes, losses) every 10 s.
# Switch it on first, a few nights before the others, to have a "before" to compare with.
#HEALTH_METER_ENABLED=true
#HEALTH_INTERVAL_S=10
#HEALTH_RETENTION_DAYS=14

# At most one request for a full picture per second to each sender (a viewer with losses can ask 5 times a second).
#KEYFRAME_REQUEST_DELAY_MS=1000

# Every viewer asks the server for fewer frames of a screen only when THAT viewer cannot keep up (SELECTIVE_MODE=adaptive,
# the default) or by the size of the tile, never below 24 fps (SELECTIVE_MODE=tile). Nothing is ever paused.
#SELECTIVE_RECEPTION=true
#SELECTIVE_MODE=adaptive

# The sender guard: a screen its sender cannot hold at 60 fps (saturated encoder, weak uplink) gets a smaller picture and a lower
# bitrate, back up when there is room. observe = only report what it would do, apply = do it. docs/SCREEN-QUALITY-STRATEGY.md
#SEND_GUARD=observe

# Replay: the last minutes of a shared screen as a clip. Needs the recorder container (it is in the compose file)
# and net.core.rmem_max raised on the host (docs/PRODUCTION-ROLLOUT.md).
#REPLAY_ENABLED=true
#REPLAY_UI_ENABLED=true
EOF
    echo "created $CONF/features.env (every switch off)"
else
    echo "kept    $CONF/features.env"
fi

if [ ! -f "$CONF/replay.env" ]; then
    echo "REPLAY_INTERNAL_SECRET=$(random_hex)" > "$CONF/replay.env"
    echo "created $CONF/replay.env"
else
    echo "kept    $CONF/replay.env"
fi

for dir in "$PROD/data" "$PROD/data/health" "$PROD/data/replays"; do
    install -d -m 755 -o 1000 -g 1000 "$dir" 2> /dev/null || sudo install -d -m 755 -o 1000 -g 1000 "$dir"
done

ls -la "$CONF" "$PROD/data"
