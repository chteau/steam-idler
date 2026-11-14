# Deploying to alwaysdata

> **The Free plan does not allow services.** Tested 2026-11-14: the service form answers "Your Free (1GB disk,
> 256MB RAM, 0.25 CPU) subscription does not allow for services." This guide therefore needs a paid plan. For a
> free host, see [BOT-HOSTING.md](BOT-HOSTING.md).

alwaysdata's Free plan is "for personal needs": 256 MB RAM, ¼ CPU and 1 GB of SSD, for life
([offers](https://www.alwaysdata.com/en/offers/)). The daemon runs as a **Service**, alwaysdata's name for a 24/7
process. The home directory is a real disk, so the session file survives restarts, and token renewal can be turned
on: no 200-day manual refresh.

> Exact form labels below may differ slightly from what you see. The facts come from alwaysdata's help pages
> ([services](https://help.alwaysdata.com/en/docs/web-hosting/services/),
> [Node.js](https://help.alwaysdata.com/en/docs/web-hosting/languages/nodejs/configuration/),
> [SSH](https://help.alwaysdata.com/en/docs/web-hosting/remote-access/ssh/)).
> Their plan table ticks "Services" for the Free plan, but one footnote says "from the Small plan". If the
> Services menu is missing or locked on your account, that is why.

Replace `ACCOUNT` below with your alwaysdata account name.

## 1. Account settings

1. Create the account and pick the **Free** plan.
2. Go to **Environment → Node.js** and set the default version to **22**. (The service below also sets
   `NODEJS_VERSION=22`, so this is a belt-and-braces step.)
3. Go to **Remote access → SSH/SFTP** and create or enable an SSH user, with a password or, better, your SSH
   public key. The host is `ssh-ACCOUNT.alwaysdata.net`, port 22.

## 2. Install the code (over SSH)

```bash
ssh ACCOUNT@ssh-ACCOUNT.alwaysdata.net
node --version                      # expect v22.x; otherwise prefix commands with NODEJS_VERSION=22
git clone https://github.com/chteau/steam-idler.git ~/steam-idler
cd ~/steam-idler
npm ci --omit=dev
npm run build
mkdir -p -m 700 data
exit
```

## 3. Upload the Steam token (from your computer)

If you haven't yet, run `npm run auth` on your computer in your local clone, and approve the QR code in the Steam
app. Then copy the session file over SSH:

```bash
scp data/session.json ACCOUNT@ssh-ACCOUNT.alwaysdata.net:steam-idler/data/session.json
ssh ACCOUNT@ssh-ACCOUNT.alwaysdata.net 'chmod 600 ~/steam-idler/data/session.json'
```

The token is never pasted into a web form or an environment variable. It goes straight from your disk to theirs,
over SSH. Afterwards you can delete your local copy (`rm data/session.json`) if you want only one copy to exist.

## 4. Create the service

Go to **Advanced → Services → Add a service** and fill in:

| Field | Value |
|---|---|
| Command | `node --optimize-for-size --max-old-space-size=128 --max-semi-space-size=2 start.mjs` |
| Working directory | `/home/ACCOUNT/steam-idler` |
| Monitoring command | *(leave empty)* |
| Environment variables | see below |

The environment variables go one per line (`NAME=value`):

```
NODEJS_VERSION=22
SKIP_BUILD=1
STEAM_APP_ID=2200
LOG_LEVEL=info
SESSION_FILE=/home/ACCOUNT/steam-idler/data/session.json
STEAM_RENEW_REFRESH_TOKENS=true
```

`STEAM_REFRESH_TOKEN` is **not** set: the daemon reads the token from the session file. `SKIP_BUILD=1` skips
recompiling on every restart, because you already built in step 2. That saves time and memory.

Save. alwaysdata starts the service and restarts it if it exits.

## 5. Check the logs

Open **Logs** in the admin panel, or run this over SSH:

```bash
tail -f ~/admin/logs/services/*.log
```

A healthy start ends with `Logged on to Steam`, `Setting playing state` and then `Steam confirmed: now playing`.
The table in [DEPLOYMENT.md](DEPLOYMENT.md#6-deploy-and-read-the-logs) explains the messages that need action.

## Day-to-day

- **Restart:** use the restart action for the service. alwaysdata sends SIGHUP. The daemon clears its playing
  state, logs off, exits, and alwaysdata starts it again.
- **Update the code:**
  ```bash
  ssh ACCOUNT@ssh-ACCOUNT.alwaysdata.net
  cd ~/steam-idler && git pull && npm ci --omit=dev && npm run build
  ```
  Then restart the service. The account has 256 MB in total, so if `npm ci` gets killed, stop the service first and
  start it again afterwards.
- **Token rotation:** with `STEAM_RENEW_REFRESH_TOKENS=true`, the daemon saves new tokens into the session file
  atomically. The log line is `Steam issued a new refresh token; saved it`. Nothing to do.
- **Recovery** (`Steam rejected the logon` or a Steam Guard message in the logs): run `npm run auth` on your
  computer, repeat step 3, then restart the service.
- **Service disabled:** alwaysdata disables a service that keeps failing within a short time, for example when
  configuration is missing (exit 78). Read the log, fix the cause, and re-enable the service. A rejected token does
  not cause this: the daemon stays up and waits instead of crash-looping.
