# Deploying to Bot-Hosting.net (Free plan)

The Free plan is enough to run the daemon: 256 MB RAM, 25% CPU, 512 MB of storage and one deployment, with no
sleep mode and no card required. The catch is that the free plan has to be **renewed by hand every 4 days**. The
renew button unlocks 3 days before the due date. If you miss it, there's a 3-day grace period, after which the
deployment is suspended. The free plan also has no uptime commitment. Sources:
[pricing](https://bot-hosting.net/pricing), [terms](https://bot-hosting.net/legal).

Their terms forbid "anything that breaches the terms of a platform you connect to". Whether idling breaks Steam's
terms is unclear, so you run this at your own risk.

In practice the daemon uses about 120 MB.

## 1. Get a Steam token (on your computer)

```bash
git clone https://github.com/chteau/steam-idler.git && cd steam-idler
npm ci
npm run auth
```

When the QR code appears, open the Steam mobile app, go to **Steam Guard**, tap the scan icon, scan the code and
approve the login. The token is saved to `data/session.json`.

## 2. Create the deployment

1. Sign in with GitHub or Discord, then create a deployment from the GitHub repository `chteau/steam-idler`.
2. Set the **start command**:
   ```
   [ -d node_modules ] || npm ci --omit=dev; exec node --optimize-for-size --max-old-space-size=128 --max-semi-space-size=2 start.mjs
   ```
   This installs dependencies on first boot only, then compiles the code and runs the daemon in a single process.
   Node 22 or newer is required. The panel's version 24 is fine.
3. Add these **environment variables**:

| Name | Value |
|---|---|
| `STEAM_REFRESH_TOKEN` | the `refreshToken` value from your local `data/session.json` |
| `STEAM_APP_ID` | `2200` |
| `SESSION_FILE` | `none` |
| `DISCORD_WEBHOOK` | *(optional)* a Discord webhook URL for renewal reminders |
| `DISCORD_ID` | *(optional)* your Discord user ID, so the reminder mentions you |

Leave token renewal off, which is the default. The token then stays valid for about 200 days, after which you
redo step 1 and paste the new value.

## 3. Check the console

A healthy start looks like this:

```
"msg":"Logged on to Steam"
"msg":"Session ready"  persona:"online"
"msg":"Setting playing state"  appId:2200
"msg":"Steam confirmed: now playing"
"msg":"Discord renewal reminder enabled"  nextReminderAt:"…"   (only when DISCORD_WEBHOOK is set)
```

Steam's profile page can lag by a few minutes. Your friends list updates faster.

## Renewal reminder

With `DISCORD_WEBHOOK` set, the daemon posts a reminder every 72 hours (`RENEW_REMINDER_HOURS`) that mentions
`DISCORD_ID`.

- **Schedule:** the slots are fixed in time. Restarting the daemon neither resets the countdown nor sends an extra
  ping. The first reminder can come at any point in the first 3 days, so renew by hand once when you set it up.
- **Delivery:** the reminder pings only that user, never `@everyone` or roles. A failed delivery is retried twice
  (after 1 and 5 minutes).
- **Setup:**
  - To create a webhook: Discord channel settings → **Integrations** → **Webhooks** → **New Webhook** → copy URL.
  - To find your user ID: turn on Developer Mode, right-click your name, then **Copy User ID**.
- **Security:** treat the webhook URL as a secret, because anyone holding it can post in that channel.

The reminder only notifies you: renewing is still a manual click.

## Updating

Pull the latest commit through the panel's GitHub sync, then restart. `start.mjs` recompiles on every start. If a
dependency changed, delete `node_modules` once in the file manager before restarting.
