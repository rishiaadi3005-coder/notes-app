-- Ten Days Moments: a small shared space ("circle") for you and the people you invite.
-- Photos live in R2; everything else lives here. Tokens and invite codes are stored only as SHA-256 hashes.

CREATE TABLE IF NOT EXISTS circles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  circle TEXT NOT NULL REFERENCES circles(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  joined INTEGER NOT NULL,
  left_at INTEGER,
  seen INTEGER,
  unread INTEGER DEFAULT 0,
  word TEXT,
  word_day TEXT
);
CREATE INDEX IF NOT EXISTS members_circle ON members(circle);

CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  circle TEXT NOT NULL REFERENCES circles(id),
  by_member TEXT NOT NULL,
  expires INTEGER NOT NULL,
  used_by TEXT
);

CREATE TABLE IF NOT EXISTS moments (
  id TEXT PRIMARY KEY,
  circle TEXT NOT NULL REFERENCES circles(id),
  author TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  for_story INTEGER NOT NULL DEFAULT 1,
  photo_key TEXT,
  photo_type TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS moments_sync ON moments(circle, updated);

CREATE TABLE IF NOT EXISTS reactions (
  moment TEXT NOT NULL,
  member TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (moment, member)
);

CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY,
  moment TEXT NOT NULL,
  member TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS replies_moment ON replies(moment);

CREATE TABLE IF NOT EXISTS chapters (
  circle TEXT NOT NULL,
  period INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  moment_ids TEXT NOT NULL DEFAULT '[]',
  by_member TEXT NOT NULL,
  updated INTEGER NOT NULL,
  by_ai INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (circle, period)
);

-- rate limiting for join codes and moves (hashed addresses only)
CREATE TABLE IF NOT EXISTS attempts (k TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS attempts_k ON attempts(k, at);

-- push notifications: one row per phone
CREATE TABLE IF NOT EXISTS push_subs (
  id TEXT PRIMARY KEY,
  member TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subs_member ON push_subs(member);

-- reminders the cron sends: hard-hour heads-ups, nudges at learned times, start times
CREATE TABLE IF NOT EXISTS push_sched (
  member TEXT NOT NULL,
  k TEXT NOT NULL,
  at INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT './',
  PRIMARY KEY (member, k)
);
CREATE INDEX IF NOT EXISTS push_sched_at ON push_sched(at);

-- "I need you": staged on the server so it fires even when the app is closed
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  circle TEXT NOT NULL,
  member TEXT NOT NULL,
  fire_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  call TEXT,
  who TEXT,
  ntfy TEXT,
  created INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS alerts_due ON alerts(state, fire_at);

CREATE TABLE IF NOT EXISTS capsules (
  circle TEXT NOT NULL,
  period INTEGER NOT NULL,
  member TEXT NOT NULL,
  text TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (circle, period, member)
);

CREATE TABLE IF NOT EXISTS breathe (
  circle TEXT PRIMARY KEY,
  start INTEGER NOT NULL,
  until INTEGER NOT NULL,
  by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  circle TEXT NOT NULL,
  title TEXT NOT NULL,
  target INTEGER NOT NULL,
  starts INTEGER NOT NULL,
  ends INTEGER NOT NULL,
  by TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chal_progress (
  challenge TEXT NOT NULL,
  member TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (challenge, member)
);

-- moving data from the old app: an encrypted bundle in R2, kept 24 hours, downloaded once
CREATE TABLE IF NOT EXISTS transfers (
  id_hash TEXT PRIMARY KEY,
  expires INTEGER NOT NULL,
  size INTEGER NOT NULL
);
