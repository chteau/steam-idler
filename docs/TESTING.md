# Testing

## Unit tests

```bash
npm test
```

The tests use an EventEmitter-based fake Steam client (`tests/helpers.ts`), so they never touch the network.

| Area | File |
|---|---|
| Valid and invalid config, missing variables, every problem reported at once | `tests/config.test.ts` |
| Presence: activation, confirmation, no duplicate sends, restore after reconnect, blocked state, bounded retries, stop | `tests/presence.test.ts` |
| Backoff math and jitter, error classification, duplicate logon prevention, transient/throttled/replaced/fatal handling, stop | `tests/reconnect.test.ts` |
| Atomic writes, 0600 permissions, failed rename keeps the old file, corrupt-file quarantine, token source selection | `tests/session-store.test.ts` |
| QR login success, timeout, denial and start failure; token pre-checks; headless Steam Guard | `tests/auth.test.ts` |
| SIGTERM/SIGINT/SIGHUP handling, cleanup deadline, second-signal force exit | `tests/shutdown.test.ts` |
| Discord reminder: fixed-slot schedule, mention scoping, bounded retries, URL never logged | `tests/reminder.test.ts` |
| End-to-end wiring: rotation save and save failure, corrupt file fallback, parking on fatal errors, stop/logoff, no token in logs | `tests/app.test.ts` |

## Manual integration checklist (real Steam account)

This checks the one thing unit tests can't: whether Steam actually credits play time.

Preparation:
- [ ] Note the current hours for the game on your profile (**Library**, or `steamcommunity.com/id/<you>/games`).
      Make sure the account owns App 2200, or set `STEAM_APP_ID` to a game you own.
- [ ] Set your profile's **Game details** privacy to Public or Friends, so a friend or second account can check the
      status.

Run:
- [ ] `npm run auth`: the QR code appears, the login is approved in the mobile app, and the terminal says
      `Logged in as SteamID …`. The token is **not** printed. `ls -l data/session.json` shows `-rw-------`.
- [ ] `npm start`: the logs show `Logged on to Steam`, then `Steam confirmed: now playing` with `appId:2200`.
- [ ] A friend, a second account, or the mobile app shows you as **In-Game: Quake III Arena**.
- [ ] Leave it running for at least 1 hour. Then compare the profile hours. *Steam can take a while to update this
      figure; check again after several hours if it hasn't moved.*

Reconnect:
- [ ] Turn the network off for about 1 minute, then back on. The logs show `Disconnected from Steam; steam-user is
      reconnecting`, then `Logged on to Steam` and `Setting playing state`. The in-game status comes back.
- [ ] Stop with Ctrl+C. The logs show `Shutting down` and `Stopped`. The status goes back to Online within a few
      seconds.
- [ ] Start again. The in-game status comes back without a new QR login.

Blocked state (optional):
- [ ] While idling, launch any game from the desktop Steam client on the same account. Steam may ask whether to
      continue playing on this computer; accept. The daemon logs `A game is running on another session …` and
      **does not** fight back.
- [ ] Quit that game. The daemon logs `Other session stopped playing; restoring presence`, and the idle game comes
      back.

Failure handling:
- [ ] Set `STEAM_REFRESH_TOKEN=garbage` with `SESSION_FILE=none`. The process exits 78 with an actionable message
      and never contacts Steam.
- [ ] Set `STEAM_APP_ID=abc`. The process exits 78 and lists the problem.

Record the result (credited / not credited, how long it took) in the issue tracker, **without** any token, QR code
or session file.
