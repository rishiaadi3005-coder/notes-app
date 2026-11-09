# Ten Days

A calm daily companion for one phone, shared with a brother or a few friends. It covers tasks, reading, support when you need it, Moments, notifications and the ten-day chapter.

The whole app is one file, `index.html`, with a service worker (`sw.js`), a manifest and icons. Its server is a single Cloudflare Worker in `worker/`. The same Worker also serves the app, so the app and its server share one HTTPS address.

> **Why a Worker and not Cloudflare Pages?** Pages can't run scheduled jobs. Ten Days needs one every minute, so that "I need you" fires on time with the app closed and reminders reach the lock screen. A Worker with static assets serves the app files exactly like Pages does, on a fixed `https://` address, on the same free plan.

## Deployment checklist (in order)

You need a free Cloudflare account and Node.js 18 or newer. Run every command from the `worker/` folder.

### 1. Sign in

- **On your own computer:** run `npx wrangler login`, click Allow, then run `npx wrangler whoami` to check.
- **From a cloud session:** use an API token made from the "Edit Cloudflare Workers" template. The token needs edit access to Workers, D1 and R2.

### 2. Create the database and the photo storage

```bash
npx wrangler d1 create ten-days
```

Copy the `database_id` the command prints into `wrangler.toml`. Then:

```bash
npx wrangler d1 execute ten-days --remote --file=schema.sql
npx wrangler r2 bucket create ten-days-photos
```

R2 is free up to 10 GB, but Cloudflare may ask for a card before turning it on.

### 3. Make the VAPID keys (for push notifications)

```bash
node vapid.mjs
```

1. Put the printed `VAPID_PUBLIC` value into `wrangler.toml`.
2. Run the command below. When it asks, paste the private key (the JSON line the script printed).

```bash
npx wrangler secret put VAPID_PRIVATE_JWK
```

The private key never goes into a file or into git.

### 4. Deploy the app and the server together

```bash
npx wrangler deploy
```

The command prints the address, for example `https://ten-days.<your-subdomain>.workers.dev`. That's the app.

Check that the server is running:

```bash
curl https://ten-days.<your-subdomain>.workers.dev/v1
```

It should answer with `"service":"ten-days-moments"` and `"push":true`.

### 5. Point the old copy at the new home (optional)

If you still use the GitHub Pages copy:

1. Set `var TD_HOME = "https://ten-days.<your-subdomain>.workers.dev";` in `index.html`.
2. Push to GitHub.

The old app then shows "Ten Days has a new home" with a button that makes a move code.

### 6. Redeploying after a change

```bash
npx wrangler deploy
```

If `schema.sql` changed, run `npx wrangler d1 execute ten-days --remote --file=schema.sql` first. The tables use `CREATE … IF NOT EXISTS`, so a new table gets added safely. A new column on an existing table needs an `ALTER TABLE`.

## Phone setup

### Rishi's phone

1. Open the app address in Safari.
2. Tap Share → Add to Home Screen → Add.
3. Close Safari and open **Ten Days from the new icon**. From now on, always use the icon.
4. Moving from the old app?
   1. In the old app, go to You → Your data → Move your data → **Make a move code**.
   2. In the new app, tap "Moving from the old app?" and type the code. Tasks, notes, books, PDFs, photos and cards all come over.
   3. The code works once, within 24 hours.
5. In You → You and Aadi:
   1. Tap **Start our circle**. A 6-character code appears, with a QR code. It lasts 15 minutes.
   2. Tap **Turn on notifications** and choose Allow.
   3. Tap **Send a test**. A notification should arrive within seconds.

### Aadi's phone

1. Open the same address in Safari, then Add to Home Screen, and open Ten Days from the icon.
2. Go to You → You and Rishi → **Or join one**. Type the 6-character code from Rishi's phone. Lowercase or spaces are fine.
3. Tap **Turn on notifications** and choose Allow, then **Send a test**.
4. Optional: in ntfy, keep the alert channel too. It's the fallback when push is off.

### Then check, with both phones

| Check | What should happen |
|---|---|
| Rishi taps "I need you" (wait 1 minute), then swipes Ten Days closed | About a minute later, Aadi's lock screen shows the alert. Tapping it opens a Call button. |
| Rishi posts a moment | Aadi gets a notification. |
| Aadi reacts to it | Rishi gets a notification, and the app icon shows a badge. |
| A check-in with a learned time | A nudge on the lock screen at that time. Dismiss it twice and it goes quiet for a week. |

## Privacy

- **Book text:** PDF text stays on the phone. The AI only sees what its consent areas allow (You → AI helper).
- **Labels:** everything the AI writes is labeled as AI.
- **On the server:** only the circle's moments, reactions, replies, chapters, time capsules, challenges, push subscriptions and scheduled reminder texts.
- **Keys:** member keys and join codes are stored as SHA-256 hashes. Move bundles are encrypted on the phone with the move code, which the server never sees in full.
- **Never on the server:** tasks, notes, urges, check-ins and AI conversations.

## Tests

Run these from `tests/`:

```bash
node worker.test.js
```

```bash
node app.test.js
```

- `worker.test.js` runs the server code with D1 and R2 replaced by in-memory stand-ins. It covers codes, push encryption and VAPID signatures, server-side "I need you", reminders and the extras.
- `app.test.js` drives the app in Chromium with Playwright. It includes two phones, real code joins, the push subscription flow (with a stubbed browser push service), offline start, moving data, the slideshow and video export.

### What these tests can't prove

- **Real iPhone behavior:** scroll smoothness, the aurora's frame rate, haptics, Safari's push service and Add to Home Screen. Check those on a real iPhone with the checks above.
- **Delivery by Apple's or Google's push service:** the tests check the encrypted push that's sent, not the delivery.
- **Speech in the video export:** web apps can't record the spoken voice, so exported videos are silent. The app says so.
