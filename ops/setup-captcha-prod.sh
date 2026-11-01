#!/usr/bin/env bash
# Prepare the explicitly requested CAPTCHA production activation. Does not restart services.
# Keeps an existing private key, never copies development settings/history, backs up feature flags.
set -euo pipefail
CONF=/home/debian/.config/mirotalksfu-prod
DATA=/home/debian/mirotalksfu/data/captcha
FEATURES=$CONF/features.env
[ -f "$FEATURES" ] || { echo 'Production features.env is missing' >&2; exit 1; }
sudo -n install -d -m 700 -o 1000 -g 1000 "$DATA"
sudo -n python3 - "$DATA/admin-key" "$FEATURES" <<'PY'
import os, re, secrets, shutil, sys
from datetime import datetime, timezone
key, features = sys.argv[1:]
if not os.path.exists(key):
    with open(key, 'x') as handle:
        handle.write(secrets.token_urlsafe(32) + '\n')
    os.chown(key, 1000, 1000)
    os.chmod(key, 0o600)
with open(key) as handle:
    if len(handle.read().strip()) < 24:
        raise SystemExit('Existing key is too short; nothing enabled')
with open(features) as handle:
    previous = handle.read()
updated = re.sub(r'^CAPTCHA_ENABLED=.*\n?', '', previous, flags=re.M).rstrip() + '\nCAPTCHA_ENABLED=true\n'
if updated != previous:
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    shutil.copy2(features, features + '.pre-captcha-' + stamp)
    temporary = features + '.captcha-new'
    shutil.copy2(features, temporary)
    with open(temporary, 'w') as handle:
        handle.write(updated)
    os.replace(temporary, features)
print('Production CAPTCHA prepared; private key retained, history isolated, services unchanged.')
PY
