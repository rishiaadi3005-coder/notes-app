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
  seen INTEGER
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
  PRIMARY KEY (circle, period)
);
