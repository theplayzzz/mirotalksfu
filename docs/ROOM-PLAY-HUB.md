# Room games and utilities

The gamepad button in the call toolbar opens a modeless window with Games, Ranking,
Boiolômetro and Dice. No game is attached to a video or to the pinned layout. The
maximum window size reserves space for the existing call toolbar, including its
vertical position and microphone menus. Minimizing keeps
one restore/close dock on the left; closing ends the current assignment and any
verification waiting behind it. Neither action touches media transports.

## Match and verification lifecycle

`RoomPlayControl` extends the existing private CAPTCHA service. Each stable room
identity has at most one current assignment, including an unstarted or paused game.
Duplicate tabs share voting eligibility, game ownership and the target cooldown.

- Manual: assigned → playing ↔ paused → result → next game or close.
- Verification while idle: assigned; blur only the target's participant images and
  avatars, including pinned tiles. One invitation opens the game even without any
  tiles; small tile icons are secondary entry points. Nothing starts before a click.
  A video-specific fullscreen exits before the game opens; app fullscreen is retained.
- Verification during manual play (including a paused match): one pending request,
  no blur and no focus change. The manual result remains visible. Verification
  becomes available after that result, and starts only on another click.
- Closing the window or dock cancels both assignments. Unfinished attempts are
  `abandoned`, not losses. Natural results, ratings and scores already recorded stay.
- Pending requests expire after two minutes. Assignments fail open after five
  minutes, on disconnection or on a player load error. No call privileges change.
- Direct leader requests skip voting but follow the same waiting/exit rules.
  Automated requests skip occupied identities.

Switching hub tabs suspends the iframe without destroying it. A manually paused
game does not auto-resume on restore. Both entry points use identical pause rules
and a fixed logical canvas. Replies have assignment IDs, a bridge nonce and an
origin/source check; closure generations prevent late replies from reopening a game.
Mutating hub commands also carry idempotency keys. An accepted assignment is resumable
even when its start acknowledgment timed out before the iframe was created. A player
that fails to become ready within 18 seconds is closed server-side, removes blur
permanently for that assignment and leaves a message in the library.

## Votes

Public proposals use `floor(onlineIdentities × .30) + 1` yes votes: strictly more
than 30%, including proposer and target in the snapshot. Only identities present
when the ballot opens can vote once. New joins do not enter that ballot; departures
never reduce its threshold. “Propor e votar Sim” explicitly includes the author's
yes, registered only when a queued ballot actually opens.

There is one open ballot per room, up to three queued targets, 25 seconds per ballot,
a five-second gap, and a 90-second queue expiry. Same-target proposals merge. An
author has one outstanding proposal and a 90-second proposal cooldown. Target
availability and author presence are rechecked at activation. Closing/completing a
game protects the target for at least three minutes; a longer configured room
cooldown is honored. The private panel can disable participant proposals.

Only a newly opened ballot requests a short local sound. Vote updates, queue entries
and reconnect snapshots do not replay it. Sound/volume preferences are local and
never modify meeting audio. A ballot lives above the hub content while the hub is
open, or in a compact room notice when it is closed, without covering a game arena.

## Ranking and feedback

Natural wins and losses automatically record a mark; incomplete attempts do not.
Both manual and CAPTCHA matches use one board per game, rule revision, duration
and intensity. Configuration changes leave prior records intact, while the current
board compares only the current configuration. Each identity contributes its best
mark; ties share a rank. Initials are optional profile labels and cannot edit a
mark. New labels must contain exactly three letters A–Z;
existing stored labels and marks remain readable. The chosen label is remembered.

Survival games rank by seconds; defense/count games by successful actions. Course
games put completed courses first, ordered by time; unfinished courses use progress.
The server validates ownership, elapsed wall time and metric ranges. These private
room scores are client-reported gameplay, not an anti-cheat tournament system.
The existing append-only CAPTCHA store persists attempts, latest game ratings and
initials. The private panel keeps wins, losses, retries, abandonment and rating means.

The library shows names and icons; the active game collapses the navigation to icons.
Continue is available from every tab and the minimized dock. Ranking initially shows
the top five plus the player's position, with the complete board on demand. The result
prioritizes the mark and next action, asks for initials only when needed and keeps
rating behind “Avaliar jogo”. A participant proposal uses one target selector and one
“Propor e votar Sim” button; optional game selection and rules are collapsed.

## Dice

The room server owns randomness, roll IDs, sequence, names and the reveal timestamp.
The shared last-50 history deduplicates acknowledgment/broadcast delivery. A stable
identity can roll every 1.2 seconds; different people roll independently. Closing the
hub cannot cancel a roll already accepted by the server. Reconnect fetches history
without replaying old animations.
Only admitted room peers receive roll broadcasts; lobby peers and other rooms cannot
receive them. The initial history shows three recent rolls, with the rest on demand.

The 3D scene uses pinned MIT `@3d-dice/dice-box-threejs` 0.0.12 (Three.js + Cannon ES),
which supports predetermined physical outcomes. It is built as a separate, lazy
`/captcha/play/dice.js` module, about 142 kB gzip; no CDN, textures or audio downloads
are needed. One renderer handles up to four simultaneous throws. Additional results
remain in history rather than building an unbounded animation queue. No animation
appears over the game arena. Results stay masked until the server reveal time;
WebGL failure falls back to the same recorded result, never a new roll.

## Validation

- `npx mocha tests/test-RoomPlayControl.js tests/test-RoomUtilities.js tests/test-CaptchaControl.js`
- `npm run build --prefix captcha` and `npm test --prefix captcha`
- `node tests/e2e/dice-renderer.mjs`: actual WebGL, all four predetermined outcomes.
- `node tests/e2e/room-play.mjs`: independent Socket.IO clients, private panel, tile
  blur, natural results, stars/initials/ranking, manual/pending/close, quorum/queue,
  simultaneous real 3D rolls, all 14 iframe games, and mobile/callbar geometry.
- `tests/e2e/captcha.mjs` and `room-utilities.mjs` delegate to that current suite.
- `node tests/e2e/room-play-layouts.mjs`: grid, pinned video/avatar, small tiles,
  no tiles, video/app fullscreen, vertical callbar and microphone dropdown, manual
  game with a pending verification, delayed start acknowledgment, failed player
  loading and recovery from proposal cooldown/full-queue errors with independent peers.
- `tests/e2e/captcha-dev.mjs`: opt-in development SFU test using only named synthetic
  peers in the isolated `teste` room. It checks live video/audio under local blur,
  game completion and persisted feedback without changing global game settings.

Deployment follows `ops/deploy.sh dev <CI image>`; production is a separate action.
