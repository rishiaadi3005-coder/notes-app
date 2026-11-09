# Ten Days Moments server

A small Cloudflare Worker that stores the photos, reactions, replies and ten-day chapters
you share with your circle (you and your brother, later a few friends).

- **Photos** go to R2 (Cloudflare's file storage). **Everything else** goes to D1 (Cloudflare's database).
- **Access:** every member has their own secret key. The server keeps only a SHA-256 hash of it.
- **Joining:** someone new joins with an invite code. Each code works once and expires after 7 days.
- **History:** a new member sees moments from the 10 days before they joined onward, never older ones.
- **Deleting:** only the person who posted a moment can delete it. Deleting removes the photo from storage.
- **Leaving:** leaving a circle can also delete everything you shared.
- **Size and file types:** photos are limited to 3 MB, and only JPEG, PNG or WebP files are accepted. The app shrinks photos to 1280 px first.

Your private reminder photos in Ten Days are never sent here.
Tasks, check-ins, "I need you" alerts, urges and notes never reach this server either.

## Deploy (about 10 minutes, once)

You need a free Cloudflare account and Node.js on a computer.

> **Before you start:** R2 has a free tier, but Cloudflare may ask you to add a payment method before you can turn it on.

1. Open a terminal in this `worker` folder and sign in:
   ```bash
   npx wrangler login
   ```
2. Create the database:
   ```bash
   npx wrangler d1 create ten-days-moments
   ```
   The command prints a `database_id`. Paste it into `wrangler.toml` in place of `PASTE-THE-ID-FROM-wrangler-d1-create`.
3. Create the tables:
   ```bash
   npx wrangler d1 execute ten-days-moments --remote --file=schema.sql
   ```
4. Create the photo bucket:
   ```bash
   npx wrangler r2 bucket create ten-days-moments-photos
   ```
5. In `wrangler.toml`, set `ALLOWED_ORIGINS` to the address you open Ten Days from.
   It's already set to `https://rishiaadi3005-coder.github.io`. Then deploy:
   ```bash
   npx wrangler deploy
   ```
   The command prints an address like `https://ten-days-moments.<your-name>.workers.dev`.

## Connect the app

1. In Ten Days, open **You → You and Audi → Moments**.
2. Paste the server address and tap **Start our circle**.
3. Tap **Invite someone** and send the link.

On iPhone, links open in Safari, not in the Ten Days icon on the Home Screen, so the person you invite should:

1. Copy the link.
2. Open Ten Days from the Home Screen.
3. Paste the link in **You → Moments**.

## API (v1)

Every call except creating and joining a circle needs `Authorization: Bearer <member key>`.

| Method | Path | What it does |
|---|---|---|
| POST | `/v1/circles` | `{memberName}` → start a circle; returns your key |
| POST | `/v1/join` | `{code, name}` → join with an invite; returns your key |
| GET | `/v1/circle` | members |
| POST | `/v1/invites` | new single-use invite code (7 days) |
| GET | `/v1/sync?since=ms` | moments (with reactions and replies), chapters and members changed since a time |
| POST | `/v1/moments` | body = photo bytes; headers `x-moment-id`, `x-caption` (URI-encoded), `x-for-story` |
| GET | `/v1/moments/:id/photo` | the photo |
| PATCH | `/v1/moments/:id` | `{caption, forStory}` (author only) |
| DELETE | `/v1/moments/:id` | delete for everyone (author only) |
| PUT / DELETE | `/v1/moments/:id/reaction` | `{kind}`: `respect`, `seeyou`, `prove`, `brother` or `saving`; one per person |
| POST | `/v1/moments/:id/replies` | `{id, text}` |
| DELETE | `/v1/replies/:id` | your own reply |
| PUT | `/v1/chapters/:period` | `{title, body, momentIds}` |
| POST | `/v1/leave` | `{deleteMine}` |

## Tests

`node tests/worker.test.js` runs this code under Node with in-memory stand-ins for D1 (`node:sqlite`) and R2.
The app's own tests (`tests/app.test.js`) run two phones against it end to end.
