#!/usr/bin/env bash
#
# Prints a token that opens the development test room for N minutes (default 120, at most 24 hours).
# Run it on the server. Use it as the room password in a direct join URL:
#
#   https://mirotalk-dev.40-160-143-32.sslip.io/join?room=teste&roomPassword=<token>&name=Teste&audio=0&video=0&screen=0&notify=0
#
# The token is signed with the key in test-room.env; nothing is stored, it just stops working when it expires.

set -euo pipefail

MINUTES=${1:-120}
[[ $MINUTES =~ ^[0-9]+$ ]] || { echo "minutes must be a number" >&2; exit 2; }

sudo docker exec mirotalksfu-dev node -e \
    "console.log(require('/src/app/src/SingleRoomPolicy').mintTestToken(Number(process.argv[1]) * 60))" "$MINUTES"
