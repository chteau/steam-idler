# Deploying to DIGITALY Cloud (Background Worker, Free plan)

## What is verified and what is not

DIGITALY Cloud's public material is thin. Everything below comes from either the operator's public source
repository ([DIGITALYCompany/DIGITALYCloud](https://github.com/DIGITALYCompany/DIGITALYCloud): `packages/shared/src/catalog.ts`,
`apps/frontend/data/docs/*.tsx`, `apps/backend/src/runtime/docker-driver.ts`), or the project owner's own
experience. Anything not confirmed is labeled. **Check every dashboard step against what you actually see.** If a
label differs, trust the dashboard.

| Topic | Status | Source |
|---|---|---|
| Free Background Worker: 256 MB RAM, 0.25 vCPU, 1 GB storage | documented | `catalog.ts` |
| Workers need no port. Health check = "process stays up" | documented | `platform.tsx` |
| Node.js 22 LTS selectable (24 LTS is the default) | documented | `catalog.ts` |
| Start command field (default `node worker.js`) | documented | project overview doc |
| Separate build command field | **not documented**. Docs say "we install dependencies, start your process" | `guides.tsx` |
| GitHub App integration | documented in source, but **currently unavailable**, per the project owner. Deploy from a public repository by name | owner |
| Env vars encrypted at rest, masked in logs, restart on change | documented | `platform.tsx` |
| Runtime files survive restart/redeploy | **not documented**. No volumes in the container spec, so assume **no** | `docker-driver.ts` |
| Automatic restart after a crash on Free | **contradictory**. Docs say workers restart; the code marks auto-restart as paid and runs containers with restart policy `no` | `catalog.ts`, `docker-driver.ts` |
| Logs: live stdout/stderr, Free keeps the current deployment's logs for 24 h | documented | `platform.tsx` |
| Stop = SIGTERM, then up to 10 s grace | documented | `platform.tsx` |
| Free services hosted in France (Lyon/Paris) | documented | `catalog.ts` |
| Acceptable use: no explicit rule about game idlers | documented (silence) | `legal.ts` |

## Storage strategy (decided from the table above)

- **`STEAM_REFRESH_TOKEN` is the only durable credential.** It lives in DIGITALY's environment variables.
- **`STEAM_RENEW_REFRESH_TOKENS=false`** (the default). Steam never rotates the token, so the environment value
  stays valid for its whole life, about 200 days. Turning renewal on here would brick the service on the first
  restart after a rotation: the new token is lost with the container, and the old one in the environment is
  already dead.
- **`SESSION_FILE=none`** is recommended on DIGITALY. Leaving the default path also works: the file is written only
  on rotation, which is off. Either way, nothing on disk is relied upon.
- **Manual recovery** before the token expires: watch for the `Refresh token expires soon` warning in the logs (it
  starts 30 days before expiry), or put a calendar reminder at the expiry date logged at startup. Then follow
  [README → Recovery](../README.md#recovery).

## Memory

Measured on Node 22.23, idle after logon attempts. The figures are peak RSS.

| Start command | RSS |
|---|---|
| `npm start` | about 185 MB in total: npm about 63 MB, plus the daemon about 121 MB |
| `node --optimize-for-size --max-old-space-size=128 --max-semi-space-size=2 start.mjs` | **about 121 MB** |
| plain `node dist/index.js`, no flags | about 159 MB |

Both supported commands fit in 256 MB. The direct `node` command leaves twice the headroom, so use it if the start
command field accepts it.

Most of the baseline comes from loading steam-user's protocol definitions (about 50 MB of heap). The app itself
holds almost nothing.

## Steps

### 1. Authenticate the Steam account (on your computer)

```bash
git clone <your public repo URL> steam-idler && cd steam-idler
npm ci
npm run auth
```

Scan the QR code with the Steam mobile app (**Steam Guard → QR scan icon**) and approve. The token is written to
`data/session.json`. That path is ignored by git, so never move the file anywhere tracked.

### 2. Publish the repository (public)

DIGITALY deploys by repository name, so the repository must be public. Run the
[pre-publish checklist](#pre-publish-checklist) first.

### 3. Create the Background Worker

In the DIGITALY dashboard, create a new service of type **Background Worker** on the **Free** plan, and point it at
the public repository and the branch to deploy. *The exact form labels are not documented publicly; follow the
dashboard.*

### 4. Runtime, build and start

- **Node.js version:** 22 LTS.
- **Build command:** if the dashboard has one, use `npm ci && npm run build`. If it has none, that's fine:
  `start.mjs` compiles the TypeScript at startup. TypeScript is a regular dependency for that reason.
- **Start command:** `npm start` works. If the field accepts a full command, prefer this lighter one:
  ```
  node --optimize-for-size --max-old-space-size=128 --max-semi-space-size=2 start.mjs
  ```
- **Port:** none. Workers have no port.

### 5. Environment variables

Add these in the service's environment-variable settings:

| Name | Value |
|---|---|
| `STEAM_REFRESH_TOKEN` | the `refreshToken` value from your local `data/session.json` |
| `STEAM_APP_ID` | `2200` |
| `LOG_LEVEL` | `info` |
| `SESSION_FILE` | `none` |

Do not set `STEAM_RENEW_REFRESH_TOKENS`, or set it to `false`.

### 6. Deploy and read the logs

Deploy, then open the service's **Logs** tab. A healthy start looks like this (JSON lines):

```
"msg":"Starting Steam idler"  tokenSource:"env" tokenExpiresAt:"…"
"msg":"Logging on to Steam"
"msg":"Logged on to Steam"
"msg":"Session ready"  rssMb:…
"msg":"Setting playing state"  appId:2200
"msg":"Steam confirmed: now playing"
```

Messages that need action:

| Log message | Meaning | Action |
|---|---|---|
| `Invalid configuration` / `Cannot start` (exit 78) | A variable is missing or malformed | Fix the variable. The service restarts. |
| `Steam rejected the logon; not retrying` | The token is expired, revoked or invalid | [Recovery](../README.md#recovery) |
| `Steam Guard code … headless worker` | Steam wants a code | [Recovery](../README.md#recovery) |
| `A game is running on another session` | You are playing on another device | Nothing to do. Idling resumes when that game stops. |
| `Steam did not confirm the playing state` | Wrong App ID, or the account doesn't own the game | Check `STEAM_APP_ID` |
| `Steam logon failed; retrying later` | Network or Steam trouble | Nothing to do. Backoff is automatic. |

Free plans keep logs for only 24 hours.

### 7. Restart and recovery

- **Restart:** use the dashboard's Restart button. Stop sends SIGTERM. The daemon clears the playing state, logs
  off, and exits within the 10 s grace period.
- **New token:** update `STEAM_REFRESH_TOKEN`. Changing a variable restarts the service.
- **After a crash:** the Free plan may **not** restart a crashed worker (see the table above). The daemon avoids
  exiting on recoverable errors, but check the dashboard status now and then, and restart by hand if it shows the
  worker as stopped.

## Pre-publish checklist

Run these in the repository before making it public, and before every push:

```bash
git status --ignored            # data/, .env must appear only under "Ignored files"
git ls-files | grep -Ei '(^|/)(\.env($|\.)|data/|.*session.*\.json$)' | grep -v '^\.env\.example$'   # must print nothing
git log --all -p | grep -nE 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.' # must print nothing (no JWTs in history)
git log --format='%an <%ae>' | sort -u   # the author identity that will become public
```

If a token was ever committed, **rotating it is mandatory**: sign out of all other devices in Steam, then run
`npm run auth` again. Rewriting history alone isn't enough, because public commits get cached and mirrored.
