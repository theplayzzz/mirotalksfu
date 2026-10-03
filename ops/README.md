# Operation: LinkDoNotle screen sharing

How the two instances run, how to change them and how to measure them. Everything here runs on the OVH server
(`ssh ovh-mirotalk`, user `debian`) unless it says otherwise.

## The two instances

| | production | development |
|---|---|---|
| address | https://livestream.grupogrowon.com.br | https://mirotalk-dev.40-160-143-32.sslip.io |
| container | `mirotalksfu` | `mirotalksfu-dev` |
| directory | `/home/debian/mirotalksfu` | `/home/debian/mirotalk-dev` |
| compose file | `ops/compose.prod.yaml` | `ops/compose.dev.yaml` |
| image | `ghcr.io/theplayzzz/mirotalksfu` built from `main` | the same repository, built from `develop` |
| app port / media ports | 3012 / 40000-40100 | 3013 / 40200-40300 |
| CPU | high weight, all cores | core 4, low weight |
| secrets | `.env`, `~/.config/mirotalksfu-prod/*.env` | `~/.config/mirotalksfu-dev/*.env` (its own signing secrets) |

Caddy (on the host) terminates TLS and proxies to the app ports. Note that it redirects the exact path `/join` to
`/join/link`; a direct join URL needs the trailing slash (`/join/?room=...`).

Everything goes through the development instance first. Production changes only when someone asks for it.

## Where the code comes from

`github.com/theplayzzz/mirotalksfu` (a fork of the MiroTalk SFU project, `upstream` remote).

- `main` is what runs in production. `develop` is what runs in development; it is merged into `main` once it was
  validated.
- Every push to `main` or `develop` runs the tests and builds the image (`.github/workflows/ci.yml`), published as
  `ghcr.io/theplayzzz/mirotalksfu:sha-<commit>`, `:main` and `:develop`. The server never compiles anything.
- `prod-2026-09-26` is the tag of the release that was in production on that day.

## Deploying

Run the scripts that are in `/home/debian/mirotalk-dev/ops/` (copy them from this directory when they change).

```bash
ops/deploy.sh dev  sha-1a2b3c4                      # or ghcr.io/theplayzzz/mirotalksfu@sha256:...
ops/deploy.sh prod sha-1a2b3c4                      # aborts if people are connected (--force) or if the
                                                    # running container is not the image of the compose file
ops/rollback.sh dev|prod                            # back to the compose file from before the last deploy
```

`deploy.sh` pins the image by digest, recreates the container (about 10 seconds without service), waits for it to
be healthy, checks that the served `RoomClient.js` and `Room.js` are the ones in the image and puts the previous
compose file back if anything fails. `deploy-history.log` in the instance directory records every deploy.

Production protection: `docker compose up` silently swaps the image when the compose file names another one than the
running container. `deploy.sh prod` refuses to run in that state unless `--accept-drift` is given.

**The first change of production** (a new compose file with the recorder container, a new image, and a rollback that
`deploy.sh` cannot do on its own because the compose file changes too) was done on 2026-10-03 and is recorded in
`docs/PRODUCTION-ROLLOUT.md`, with the one command that goes back to the system of 01/10 (`compose.rollback.yaml`, which
is not what `ops/rollback.sh` restores that first time). From now on `ops/deploy.sh prod ...` and `ops/rollback.sh prod`
work as described above. `ops/deploy.sh prod main --check` can be run at any time: it only reports.

## Test room (development only)

The test room `teste` of the development instance is entered with a token that expires by itself, so automated tests
never need a password:

```bash
ops/dev-test-token.sh 30        # a token valid for 30 minutes
# https://mirotalk-dev.40-160-143-32.sslip.io/join/?room=teste&roomPassword=<token>&name=Teste&audio=0&video=0&screen=0&notify=0
```

The server refuses to start if `DEV_TEST_ROOM_ID` is set without `APP_ENV=dev`, and a test fails if the production
files ever mention it. `ops/setup-dev.sh` creates the development settings (idempotent).

## Tests

- `npm test`: unit tests (CI runs them on every push).
- `tests/e2e/*.mjs`: end-to-end tests with a headless Chrome against the development test room, run from a PC with
  Chrome and Node 22+. See the header of each file. `audio-guard.mjs` protects the window-audio rule,
  `guest-can-click.mjs` the dialog bug of 2026-10-01, `keyframe-delay.mjs` measures the key frame request limit.

## Measuring the room

The health meter (on in development: `HEALTH_METER_ENABLED=true`) records, for every browser every 10 seconds, how the
screens it sends and receives are doing. Files: `/home/debian/mirotalk-dev/data/health/health-YYYY-MM-DD.jsonl`
(gzipped after the day ends, kept 14 days).

```bash
python3 ops/health-summary.py /home/debian/mirotalk-dev/data/health --hours 6
```

For the server side see `ops/tools/`: `sample-health.sh` (CPU of every mediasoup worker, network and UDP errors, once
per second) and `peer-traffic.py` (upload and download of every participant, needs root).

## Settings that matter

| variable | meaning | default |
|---|---|---|
| `SINGLE_ROOM_ID`, `SINGLE_ROOM_PASSWORD` | the only room and its password | none |
| `KEYFRAME_REQUEST_DELAY_MS` | minimum time between two key frame requests to the same sender | 0 (no limit) |
| `SELECTIVE_RECEPTION` | every browser asks the server for the layer its tile needs (frame rates of a one-size screen, or sizes if `SCREEN_SIMULCAST_LAYERS` > 1). It never pauses a screen because the window is hidden or the tile is out of sight (people did not want screens stopped when they come back) | off |
| `SELECTIVE_PAUSE_HIDDEN` | `true`: the server accepts the requests to pause a screen nobody looks at (an old browser tab may still send them; no current page does). A paused screen needs a new full picture from the sender to start again, 1-10 s | off (ignored) |
| `SCREEN_SIMULCAST_LAYERS` | sizes a screen is sent in, 1-3. Keep 1: Chrome's bandwidth estimate collapses with 2-3 (`docs/MEASUREMENTS.md`) | 1 |
| `SCREEN_CODEC` | `vp8`, `h264` or `auto` (H.264 where the browser encodes it in hardware) | vp8 |
| `DEV_LOAD_ENABLED` | development only: `/dev/load`, virtual viewers to measure the worker (`tests/e2e/worker-load.mjs`) | off |
| `HEALTH_METER_ENABLED`, `HEALTH_DIR`, `HEALTH_INTERVAL_S`, `HEALTH_RETENTION_DAYS` | the health meter | off |
| `APP_ENV`, `DEV_TEST_ROOM_ID`, `DEV_TEST_ROOM_KEY` | development test room | off |

## Rules that came from bugs

- Never add an `animationend` listener to a SweetAlert2 popup: SweetAlert2 11.4.8 then never removes the closed
  dialog and its invisible layer swallows every click (bug of 2026-10-01).
- Sharing a window must send only that application's audio: every `getDisplayMedia()` call passes
  `windowAudio: 'window'` and `systemAudio: 'include'` (`tests/test-AudioCaptureGuard.js`).
- `maxIncomingBitrate` in `config.template.js` limits the whole send transport of a person, not one track.
