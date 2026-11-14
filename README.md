# Steam Idler

A small Node.js daemon that logs one Steam account in through the Steam client protocol and reports one game as
being played, with no GUI and no game installed. It reconnects on its own and puts the game back after a reconnect
or restart.

The default game is **Quake III Arena (App ID 2200)**. Set `STEAM_APP_ID` to idle a different one.

> **Playtime is not guaranteed.** The daemon tells Steam "playing App 2200" and checks that Steam acknowledged it
> (the `playingState` echo). Whether Steam then credits hours on your profile is up to Steam. Verify it yourself with
> the [manual checklist](docs/TESTING.md) before relying on it.

## How it works

```
src/
  index.ts                 entry point: config, logger, signal handling
  app.ts                   lifecycle wiring (token selection, events, parking on fatal errors, stop)
  config.ts                validated environment configuration
  cli/auth.ts              `npm run auth`: QR login, saves the refresh token (never prints it)
  steam/client.ts          steam-user construction (low-memory options)
  steam/auth.ts            QR login, token pre-checks, Steam Guard handling
  steam/presence.ts        gamesPlayed state machine (confirm, blocked, restore, bounded retries)
  steam/reconnect.ts       logon attempts, error classification, backoff with jitter
  storage/session-store.ts atomic 0600 JSON file store, env bootstrap, token rotation
  utils/logger.ts          pino with secret redaction
  utils/shutdown.ts        SIGTERM/SIGINT/SIGHUP with a cleanup deadline
start.mjs                  production launcher: compile, then run in the same process
```

- **Connection.** steam-user's built-in `autoRelogin` handles ordinary drops. The app only steps in when steam-user
  gives up (its `error` event):
  - Transient errors retry with exponential backoff and jitter: 2.5 s at first, capped at 15 min.
  - `LoggedInElsewhere` and `LogonSessionReplaced` wait at least 5 min.
  - `RateLimitExceeded` waits at least 30 min.
  - Errors a retry can't fix stop the retries for good (`AccessDenied`, `Expired`, `Revoked`, `InvalidPassword`,
    `Banned`, ...). The process then stays up and does nothing, so a restart loop can't hammer Steam's logon
    servers. It logs a reminder every hour.
  - It never makes more than one logon attempt at a time, and it never reconnects on a timer while connected.
- **Presence.** The daemon sends `gamesPlayed([appId])` once per logon session, and waits up to 15 s for Steam to
  confirm it.
  - If a game is running on another session of the account (your PC, say), it waits. It never kicks that session.
    When the other game stops, it restores the presence.
  - If Steam never confirms, it gives up after 3 tries until the next logon.
  - On shutdown it sends `gamesPlayed([])`, then logs off.
- **Memory.** It disables the PICS app cache and steam-user's data directory, and runs with V8 size flags. It uses
  about 120 MB RSS on Node 22, or about 185 MB when started through `npm start`, because npm's own process stays
  resident. See [deployment notes](docs/DEPLOYMENT.md#memory).

## Requirements

- Node.js 22 LTS (22.12 or newer). Node 24 also works.
- A Steam account that owns the game, with the Steam mobile app for the QR login.

## Local usage

```bash
npm ci
npm run auth          # shows a QR code; scan it with the Steam mobile app
npm start             # builds and runs the daemon (Ctrl+C to stop)
```

Other commands:

```bash
npm test              # unit tests (Vitest)
npm run typecheck     # strict type check of src + tests
npm run build         # compile to dist/
npm run check         # all three
```

Configuration comes from environment variables. A local `.env` file is read if present (copy `.env.example`).

| Variable | Default | Meaning |
|---|---|---|
| `STEAM_REFRESH_TOKEN` | *(empty)* | SteamClient refresh token from `npm run auth`. Optional locally if `SESSION_FILE` holds one. |
| `STEAM_APP_ID` | `2200` | App ID to report as played. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `SESSION_FILE` | `./data/session.json` | Local token store. `none` disables it (memory only). |
| `STEAM_RENEW_REFRESH_TOKENS` | `false` | Ask Steam to rotate the token on logon. Leave `false` unless `SESSION_FILE` is durable storage. |

Bad configuration stops the daemon at startup with exit code 78. It lists every problem it found.

## Authentication

### First login: QR code

1. On your own computer, in the project folder: `npm ci`, then `npm run auth`.
2. A QR code appears in the terminal. It is valid for 3 minutes.
3. In the Steam mobile app, open **Steam Guard**, tap the **QR scan** icon, scan the code and **approve** the
   sign-in.
4. The terminal prints `Logged in as SteamID …` and saves the token to `data/session.json`. The file has mode
   0600, and the token is never printed.
5. To run locally, run `npm start`. It reads the token from that file.

The QR login asks for a **SteamClient** token, which is the kind steam-user needs, and your password is never
entered or stored. The process fails clearly if the code is not approved in time, if the login is denied, or if
Steam can't be reached.

### Later logins

The daemon logs on with the stored refresh token. Steam client refresh tokens last about 200 days. The daemon logs
the expiry date at startup, and warns when fewer than 30 days remain.

Steam Guard codes are not normally needed with a refresh token. If Steam still asks for one:
- In a terminal, the daemon prompts for the code.
- On a headless worker, it logs a fatal error and stops retrying. Follow the recovery steps below.

### Token renewal and rotation

When `STEAM_RENEW_REFRESH_TOKENS=true`, Steam may issue a new token at logon. Once it does, **the old token stops
working.** The daemon saves the new token atomically to `SESSION_FILE`, together with a fingerprint of the
environment token it came from. That fingerprint tells a later start which token is the newest:
- If the file came from the current `STEAM_REFRESH_TOKEN`, the file wins, because it holds the rotated token.
- If you change `STEAM_REFRESH_TOKEN`, the environment wins.

If the save fails, the daemon logs an explicit error and keeps working with the new token in memory. It never
discards a rotated token without saying so.

Renewal is **off by default** because hosts without durable storage, such as DIGITALY Cloud, lose the file on
restart, and the token in the environment would by then be invalid.

### Recovery

These steps apply to an expired, revoked or rejected token, or a Steam Guard prompt on the server:

1. On your computer, run `npm run auth` again.
2. Open `data/session.json` yourself and copy the value of `"refreshToken"`.
3. Replace `STEAM_REFRESH_TOKEN` in the host's environment variables. The service restarts with the new token.

To invalidate a token you think was exposed, use **Manage Steam Guard → Deauthorize all other devices** in your
Steam account settings, then run `npm run auth` again.

## Security

This repository is meant to be **public**: DIGITALY Cloud deploys from a public repository. Credentials therefore
never live in the repository. They live only in the host's environment variables and on your own computer.

- **Where the token goes on DIGITALY Cloud:** open the service's environment-variable settings and add
  `STEAM_REFRESH_TOKEN` there. Paste the value straight from your local `data/session.json`. Per DIGITALY's
  platform docs, variables are encrypted at rest and secret values are masked in build and runtime logs. Changing a
  variable restarts the service.
- **What is never committed:** `.env`, `.env.*` (except `.env.example`), `data/`, session files, `*.corrupt-*`
  copies and temporary files are all in `.gitignore`. `.env.example` holds placeholders only.
- **What is never printed:** the refresh token, the QR challenge URL and machine auth tokens.
  - The QR code is drawn in the terminal and is never written to a file.
  - Logs pass through pino redaction for `refreshToken`, `token`, `accessToken`, `password` and `qrChallengeUrl`,
    as a safety net.
  - The code never logs secrets on purpose, and the tests check that no token appears in the log output.
- **Your password is never used.** Login uses the QR flow only.
- **Local files** are written with mode 0600, inside a 0700 directory.
- **Treat the refresh token like a password.** It grants a Steam client login to your account until it expires or
  you sign out other devices. Don't paste it into issues, chats or screenshots, and don't share your QR code.
- **Before every push**, run `git status` and check that no `data/` or `.env` file is staged.
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#pre-publish-checklist) has a pre-publish checklist.

## Deployment

- **alwaysdata (Free plan, recommended):** [docs/ALWAYSDATA.md](docs/ALWAYSDATA.md). It has a persistent disk, so
  token renewal works.
- **DIGITALY Cloud:** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), including what is and is not verified about the
  platform.

## Known limitations

- Steam decides whether reported play time counts toward profile hours. The daemon can only verify that Steam
  acknowledged the playing state.
- Only one account and one App ID. Change the App ID through configuration, then restart.
- Running a game on another device of the same account pauses idling until that game stops. This is deliberate:
  the daemon never force-kicks the other session.
- Two copies of the daemon logging into the same account from the same public IP replace each other, and both back
  off for 5+ minutes. Run only one copy.
- Automated Steam clients may conflict with the Steam Subscriber Agreement. Use this on your own account, at your
  own risk.
- DIGITALY Cloud's free plan has no documented persistent storage, and auto-restart appears to be a paid feature.
  See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
