# Ten Days server

A small Cloudflare Worker that stores the photos, reactions, replies and ten-day chapters
you share with your circle (you and your brother, later a few friends).

- **Photos** go to R2 (Cloudflare's file storage). **Everything else** goes to D1 (Cloudflare's database).
- **Access:** every member has their own secret key. The server keeps only a SHA-256 hash of it.
- **Joining:** someone new joins with a 6-character code (no O/0 or I/1). Each code works once, expires after 15 minutes, and guessing is rate-limited.
- **History:** a new member sees moments from the 10 days before they joined onward, never older ones.
- **Deleting:** only the person who posted a moment can delete it. Deleting removes the photo from storage.
- **Leaving:** leaving a circle can also delete everything you shared.
- **Size and file types:** photos are limited to 3 MB, and only JPEG, PNG or WebP files are accepted. The app shrinks photos to 1280 px first.

Your private reminder photos in Ten Days are never sent here.
Tasks, check-ins, "I need you" alerts, urges and notes never reach this server either.

## Deploy

See the deployment checklist in the top-level `README.md`. The same Worker serves the app and this server, with a cron every minute for "I need you" alerts and reminders.

## API (v1)

Every call except creating and joining a circle needs `Authorization: Bearer <member key>`.

| Method | Path | What it does |
|---|---|---|
| POST | `/v1/circles` | `{memberName}` → start a circle; returns your key |
| POST | `/v1/join` | `{code, name}` → join with a 6-character code (15 minutes, once); returns your key |
| GET | `/v1/push/key` | the public VAPID key |
| POST / DELETE | `/v1/push/subscribe` | register or remove this phone for push |
| PUT | `/v1/push/schedule` | `{items:[{key, at, title, body, kind, url}]}`: reminders for the next week |
| POST | `/v1/push/test` | a test notification to your phones |
| POST | `/v1/alerts` | `{wait, title, body, call, ntfy}`: "I need you", fired by the cron after the wait |
| GET / DELETE | `/v1/alerts/:id` | its state / cancel it |
| POST | `/v1/alerts/:id/fire` | `{ntfyDone}`: send now |
| POST | `/v1/signal` | `{kind: notgreat \| message, text}` |
| PUT | `/v1/word` | `{word, day}` |
| PUT | `/v1/capsules/:period` | a time capsule, first three days of a run |
| POST / DELETE | `/v1/breathe` | breathe together (shared start time) |
| POST | `/v1/challenges`, `/v1/challenges/:id/progress` | a challenge and your count |
| POST / GET | `/v1/transfer`, `/v1/transfer/:id` | the encrypted move bundle (24 hours, one download) |
| GET | `/v1/circle` | members |
| POST | `/v1/invites` | a new 6-character join code |
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
