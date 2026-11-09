// Ten Days server: one Cloudflare Worker that serves the app itself and its small backend.
//
// - The app (index.html, sw.js, icons) is served from static assets at the same address.
// - A "circle" is a small private group (you and your brother, later a few friends, up to 12).
//   Every member has their own secret key; the server keeps only its SHA-256 hash.
// - New members join with a 6-character code: single use, 15 minutes, rate-limited.
// - Members see moments from 10 days before they joined onward, never older history.
// - Push notifications (Web Push with VAPID), and a cron that fires "I need you" alerts and
//   scheduled reminders even when the app is closed.

import { sendPush } from "./push.js";

const REACTIONS = ["respect", "seeyou", "prove", "brother", "saving"];
const RX_LABEL = { respect: "👊 Respect", seeyou: "👀 I see you", prove: "🔥 Prove it", brother: "🫂 That's my brother", saving: "📌 Saving this" };
const MAX_PHOTO = 3 * 1024 * 1024;
const MAX_MOVE = 50 * 1024 * 1024;
const MAX_MEMBERS = 12;
const CODE_MS = 15 * 60e3;
const HISTORY_MS = 10 * 864e5;
const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no O/0, I/1
const TYPES = { "image/jpeg": [0xff, 0xd8, 0xff], "image/png": [0x89, 0x50, 0x4e, 0x47], "image/webp": [0x52, 0x49, 0x46, 0x46] };
const ID_RE = /^[a-z0-9]{8,40}$/;

function rid(n) {
  const a = "abcdefghijkmnpqrstuvwxyz23456789", b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = ""; for (const x of b) s += a[x % a.length];
  return s;
}
function code6() { const b = new Uint8Array(6); crypto.getRandomValues(b); let s = ""; for (const x of b) s += CODE_ABC[x % 32]; return s; }
export function normCode(c) { return String(c || "").toUpperCase().replace(/[\s-]+/g, ""); }
async function sha(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function clean(s, max) { return typeof s === "string" ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max) : ""; }

function cors(env, req) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map(x => x.trim()).filter(Boolean);
  const origin = req.headers.get("origin") || "";
  const ok = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0] || "null";
  return {
    "access-control-allow-origin": ok,
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-moment-id, x-caption, x-for-story, x-move-id",
    "access-control-max-age": "86400",
    vary: "origin"
  };
}
function json(data, status, h) { return new Response(JSON.stringify(data), { status: status || 200, headers: { ...h, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function err(status, msg, h) { return json({ error: msg }, status, h); }
async function body(req) { try { const t = await req.text(); return t ? JSON.parse(t) : {}; } catch (e) { return null; } }

async function auth(req, env) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer ([A-Za-z0-9_-]{20,100})$/);
  if (!m) return null;
  return env.DB.prepare("SELECT m.id, m.circle, m.name, m.joined, c.created AS circle_created, c.name AS circle_name FROM members m JOIN circles c ON c.id = m.circle WHERE m.token_hash = ? AND m.left_at IS NULL")
    .bind(await sha(m[1])).first();
}
async function newMember(env, circle, name, now) {
  const token = rid(40), id = rid(16);
  await env.DB.prepare("INSERT INTO members (id, circle, name, token_hash, joined) VALUES (?, ?, ?, ?, ?)").bind(id, circle, name, await sha(token), now).run();
  return { id, token };
}
async function circleView(env, me) {
  const { results } = await env.DB.prepare("SELECT id, name, joined, left_at, seen, word, word_day FROM members WHERE circle = ? ORDER BY joined").bind(me.circle).all();
  return { circle: { id: me.circle, name: me.circle_name, created: me.circle_created }, me: { id: me.id, name: me.name },
    members: results.map(r => ({ id: r.id, name: r.name, joined: r.joined, left: !!r.left_at, seen: r.seen || 0, word: r.word || "", wordDay: r.word_day || "" })) };
}
async function visibleMoment(env, me, id) {
  if (!ID_RE.test(id || "")) return null;
  const m = await env.DB.prepare("SELECT * FROM moments WHERE id = ? AND circle = ?").bind(id, me.circle).first();
  if (!m || m.created < me.joined - HISTORY_MS) return null;
  return m;
}
async function touch(env, id, now) { await env.DB.prepare("UPDATE moments SET updated = ? WHERE id = ?").bind(now, id).run(); }
function sniff(buf, type) { const sig = TYPES[type]; if (!sig) return false; const b = new Uint8Array(buf.slice(0, sig.length)); return sig.every((x, i) => b[i] === x); }
function periodOf(created, at) { const d = x => Math.floor(x / 864e5); return Math.floor((d(at) - d(created)) / 10); }

// Rate limit by address: at most `max` tries per `win` milliseconds for one kind of request.
async function limited(env, req, kind, max, win, now) {
  const ip = req.headers.get("cf-connecting-ip") || "local";
  const key = kind + ":" + await sha(ip);
  await env.DB.prepare("DELETE FROM attempts WHERE at < ?").bind(now - win).run();
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM attempts WHERE k = ? AND at >= ?").bind(key, now - win).first();
  if (n.n >= max) return true;
  await env.DB.prepare("INSERT INTO attempts (k, at) VALUES (?, ?)").bind(key, now).run();
  return false;
}

// ---- push ----
function pushReady(env) { return !!(env.VAPID_PUBLIC && env.VAPID_PRIVATE_JWK); }
// Send to one member's devices. Every push carries a visible notification (iOS requires that) and the badge count.
export async function pushTo(env, memberId, data, opts) {
  if (!pushReady(env)) return 0;
  const { results } = await env.DB.prepare("SELECT * FROM push_subs WHERE member = ?").bind(memberId).all();
  if (!results.length) return 0;
  await env.DB.prepare("UPDATE members SET unread = COALESCE(unread, 0) + 1 WHERE id = ?").bind(memberId).run();
  const u = await env.DB.prepare("SELECT unread FROM members WHERE id = ?").bind(memberId).first();
  let sent = 0;
  for (const s of results) {
    try {
      const st = await sendPush(s, { ...data, badge: (u && u.unread) || 1 }, env, opts);
      if (st === 404 || st === 410) await env.DB.prepare("DELETE FROM push_subs WHERE id = ?").bind(s.id).run();
      else if (st >= 200 && st < 300) sent++;
    } catch (e) {}
  }
  return sent;
}
async function pushOthers(env, me, data, opts) {
  const { results } = await env.DB.prepare("SELECT id FROM members WHERE circle = ? AND left_at IS NULL AND id != ?").bind(me.circle, me.id).all();
  let n = 0; for (const r of results) n += await pushTo(env, r.id, data, opts);
  return n;
}
async function ntfyPost(n) {
  if (!n || !/^[A-Za-z0-9_-]{8,64}$/.test(n.topic || "")) return false;
  const q = Object.keys(n.params || {}).filter(k => /^(title|priority|tags|actions|click)$/.test(k) && n.params[k]).map(k => k + "=" + encodeURIComponent(String(n.params[k]).slice(0, 600))).join("&");
  try { const r = await fetch("https://ntfy.sh/" + n.topic + (q ? "?" + q : ""), { method: "POST", body: String(n.body || "").slice(0, 500) }); return r.ok; } catch (e) { return false; }
}
// "I need you": push to everyone else in the circle, and to his ntfy channel unless the app already did that.
async function fireAlert(env, a, ntfyDone) {
  const r = await env.DB.prepare("UPDATE alerts SET state = 'sent', sent_at = ? WHERE id = ? AND state = 'pending'").bind(Date.now(), a.id).run();
  if (!r.meta || r.meta.changes !== 1) return false;   // someone else already fired or cancelled it
  const me = { id: a.member, circle: a.circle };
  await pushOthers(env, me, { title: a.title, body: a.body, tag: "sos-" + a.id, url: "./#call=" + encodeURIComponent(a.call || "") + "&from=" + encodeURIComponent(a.who || ""), kind: "sos" }, { urgency: "high", ttl: 3600 });
  if (!ntfyDone && a.ntfy) { try { await ntfyPost(JSON.parse(a.ntfy)); } catch (e) {} }
  return true;
}
// Every minute: alerts whose wait ran out, and reminders that are due.
export async function runDue(env, now) {
  now = now || Date.now();
  const { results: due } = await env.DB.prepare("SELECT * FROM alerts WHERE state = 'pending' AND fire_at <= ? LIMIT 50").bind(now).all();
  for (const a of due) await fireAlert(env, a, false);
  const { results: rem } = await env.DB.prepare("SELECT * FROM push_sched WHERE at <= ? AND at > ? LIMIT 200").bind(now, now - 30 * 60e3).all();
  for (const x of rem) {
    await env.DB.prepare("DELETE FROM push_sched WHERE member = ? AND k = ?").bind(x.member, x.k).run();
    await pushTo(env, x.member, { title: x.title, body: x.body, tag: x.k, url: x.url || "./", kind: x.kind });
  }
  await env.DB.prepare("DELETE FROM push_sched WHERE at <= ?").bind(now - 30 * 60e3).run();   // missed by more than 30 minutes: drop, don't nag late
  await env.DB.prepare("DELETE FROM transfers WHERE expires < ?").bind(now).run();
  await env.DB.prepare("DELETE FROM invites WHERE expires < ?").bind(now - 864e5).run();
  return { alerts: due.length, reminders: rem.length };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, ""), now = Date.now();
    // the app itself
    if (!p.startsWith("/v1")) return env.ASSETS ? env.ASSETS.fetch(req) : new Response("Not found", { status: 404 });
    const H = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: H });
    try {
      if (p === "/v1") return json({ ok: true, service: "ten-days-moments", v: 2, push: pushReady(env) }, 200, H);
      if (p === "/v1/push/key" && req.method === "GET") return pushReady(env) ? json({ key: env.VAPID_PUBLIC }, 200, H) : err(503, "push isn't set up on this server", H);

      // start a circle: you become its first member
      if (p === "/v1/circles" && req.method === "POST") {
        const b = await body(req); if (!b) return err(400, "bad json", H);
        const name = clean(b.memberName, 40); if (!name) return err(400, "your name is required", H);
        const id = rid(16);
        await env.DB.prepare("INSERT INTO circles (id, name, created) VALUES (?, ?, ?)").bind(id, clean(b.name, 60), now).run();
        const m = await newMember(env, id, name, now);
        return json({ token: m.token, ...(await circleView(env, { id: m.id, circle: id, name, joined: now, circle_created: now, circle_name: clean(b.name, 60) })) }, 201, H);
      }
      // join with a code
      if (p === "/v1/join" && req.method === "POST") {
        const b = await body(req); if (!b) return err(400, "bad json", H);
        const name = clean(b.name, 40), code = normCode(clean(b.code, 64));
        if (!name || !code) return err(400, "name and code are required", H);
        if (await limited(env, req, "join", 20, 15 * 60e3, now)) return err(429, "too many tries; wait 15 minutes", H);
        if (!/^[A-Z2-9]{6}$/.test(code) || /[01IO]/.test(code)) return err(403, "that code is wrong, used or expired", H);
        const inv = await env.DB.prepare("SELECT * FROM invites WHERE code_hash = ?").bind(await sha(code)).first();
        if (!inv || inv.used_by || inv.expires < now) return err(403, "that code is wrong, used or expired", H);
        const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE circle = ? AND left_at IS NULL").bind(inv.circle).first();
        if (n.n >= MAX_MEMBERS) return err(403, "this circle is full", H);
        const c = await env.DB.prepare("SELECT * FROM circles WHERE id = ?").bind(inv.circle).first();
        const m = await newMember(env, inv.circle, name, now);
        const r = await env.DB.prepare("UPDATE invites SET used_by = ? WHERE code_hash = ? AND used_by IS NULL").bind(m.id, inv.code_hash).run();
        if (!r.meta || r.meta.changes !== 1) { await env.DB.prepare("DELETE FROM members WHERE id = ?").bind(m.id).run(); return err(403, "that code was just used", H); }
        await pushOthers(env, { id: m.id, circle: c.id }, { title: name + " joined your circle", body: "You can share moments now.", tag: "join", url: "./#moments", kind: "join" });
        return json({ token: m.token, ...(await circleView(env, { id: m.id, circle: c.id, name, joined: now, circle_created: c.created, circle_name: c.name })) }, 201, H);
      }
      // moving to the new app: an encrypted bundle, readable only with the code shown on the old phone
      if (p === "/v1/transfer" && req.method === "POST") {
        const id = clean(req.headers.get("x-move-id"), 20);
        if (!/^[A-Z2-9]{4}$/.test(id)) return err(400, "x-move-id is required", H);
        if (await limited(env, req, "move", 10, 3600e3, now)) return err(429, "too many tries", H);
        const buf = await req.arrayBuffer();
        if (!buf.byteLength || buf.byteLength > MAX_MOVE) return err(413, "too large", H);
        const k = await sha("move:" + id);
        await env.PHOTOS.put("move/" + k, buf);
        await env.DB.prepare("INSERT INTO transfers (id_hash, expires, size) VALUES (?, ?, ?) ON CONFLICT(id_hash) DO UPDATE SET expires = excluded.expires, size = excluded.size").bind(k, now + 24 * 3600e3, buf.byteLength).run();
        return json({ ok: true, expires: now + 24 * 3600e3 }, 201, H);
      }
      let mt;
      if ((mt = p.match(/^\/v1\/transfer\/([A-Za-z2-9]{4})$/)) && req.method === "GET") {
        if (await limited(env, req, "movein", 30, 3600e3, now)) return err(429, "too many tries", H);
        const k = await sha("move:" + mt[1].toUpperCase());
        const t = await env.DB.prepare("SELECT * FROM transfers WHERE id_hash = ? AND expires > ?").bind(k, now).first();
        const obj = t && await env.PHOTOS.get("move/" + k);
        if (!obj) return err(404, "no move with that code (they last 24 hours)", H);
        const data = await new Response(obj.body).arrayBuffer();
        await env.PHOTOS.delete("move/" + k); await env.DB.prepare("DELETE FROM transfers WHERE id_hash = ?").bind(k).run();   // one download
        return new Response(data, { headers: { ...H, "content-type": "application/octet-stream", "cache-control": "no-store" } });
      }

      const me = await auth(req, env);
      if (!me) return err(401, "not a member", H);

      if (p === "/v1/circle" && req.method === "GET") return json(await circleView(env, me), 200, H);

      if (p === "/v1/invites" && req.method === "POST") {
        const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE circle = ? AND used_by IS NULL AND expires > ?").bind(me.circle, now).first();
        if (open.n >= 20) return err(429, "too many open codes", H);
        const code = code6();
        await env.DB.prepare("INSERT INTO invites (code_hash, circle, by_member, expires) VALUES (?, ?, ?, ?)").bind(await sha(code), me.circle, me.id, now + CODE_MS).run();
        return json({ code, expires: now + CODE_MS }, 201, H);
      }

      if (p === "/v1/leave" && req.method === "POST") {
        const b = (await body(req)) || {};
        if (b.deleteMine) {
          const { results } = await env.DB.prepare("SELECT id, photo_key FROM moments WHERE circle = ? AND author = ? AND deleted = 0").bind(me.circle, me.id).all();
          for (const m of results) await removeMoment(env, m, now);
          await env.DB.prepare("DELETE FROM reactions WHERE member = ?").bind(me.id).run();
          await env.DB.prepare("DELETE FROM replies WHERE member = ?").bind(me.id).run();
          await env.DB.prepare("DELETE FROM capsules WHERE member = ?").bind(me.id).run();
        }
        await env.DB.prepare("DELETE FROM push_subs WHERE member = ?").bind(me.id).run();
        await env.DB.prepare("DELETE FROM push_sched WHERE member = ?").bind(me.id).run();
        await env.DB.prepare("UPDATE members SET left_at = ? WHERE id = ?").bind(now, me.id).run();
        return json({ ok: true }, 200, H);
      }

      // everything that changed since a time
      if (p === "/v1/sync" && req.method === "GET") {
        const since = Math.max(0, Math.floor(+url.searchParams.get("since") || 0));
        await env.DB.prepare("UPDATE members SET seen = ?, unread = 0 WHERE id = ?").bind(now, me.id).run();
        const floor = me.joined - HISTORY_MS;
        const { results: ms } = await env.DB.prepare("SELECT * FROM moments WHERE circle = ? AND updated >= ? AND created >= ? ORDER BY created LIMIT 500").bind(me.circle, since, floor).all();
        const ids = ms.map(m => m.id), rx = {}, rp = {};
        if (ids.length) {
          const q = ids.map(() => "?").join(",");
          (await env.DB.prepare("SELECT * FROM reactions WHERE moment IN (" + q + ")").bind(...ids).all()).results.forEach(r => (rx[r.moment] = rx[r.moment] || []).push({ member: r.member, kind: r.kind, at: r.at }));
          (await env.DB.prepare("SELECT * FROM replies WHERE moment IN (" + q + ") ORDER BY at").bind(...ids).all()).results.forEach(r => (rp[r.moment] = rp[r.moment] || []).push({ id: r.id, member: r.member, text: r.text, at: r.at }));
        }
        const { results: ch } = await env.DB.prepare("SELECT * FROM chapters WHERE circle = ? AND updated >= ?").bind(me.circle, since).all();
        // time capsules: your own while the run is going; everyone's once it has ended
        const cur = periodOf(me.circle_created, now);
        const { results: caps } = await env.DB.prepare("SELECT * FROM capsules WHERE circle = ? AND (member = ? OR period < ?)").bind(me.circle, me.id, cur).all();
        const br = await env.DB.prepare("SELECT * FROM breathe WHERE circle = ? AND until > ?").bind(me.circle, now).first();
        const { results: chal } = await env.DB.prepare("SELECT * FROM challenges WHERE circle = ? AND ends > ?").bind(me.circle, now).all();
        const prog = {};
        if (chal.length) (await env.DB.prepare("SELECT * FROM chal_progress WHERE challenge IN (" + chal.map(() => "?").join(",") + ")").bind(...chal.map(c => c.id)).all()).results.forEach(x => { (prog[x.challenge] = prog[x.challenge] || {})[x.member] = x.count; });
        return json({ now, ...(await circleView(env, me)),
          moments: ms.map(m => ({ id: m.id, author: m.author, caption: m.caption, forStory: !!m.for_story, hasPhoto: !!m.photo_key, created: m.created, updated: m.updated, deleted: !!m.deleted, reactions: rx[m.id] || [], replies: rp[m.id] || [] })),
          chapters: ch.map(c => ({ period: c.period, title: c.title, body: c.body, momentIds: safeIds(c.moment_ids), by: c.by_member, updated: c.updated, byAi: !!c.by_ai })),
          capsules: caps.map(c => ({ period: c.period, member: c.member, text: c.text, at: c.created })),
          breathe: br ? { start: br.start, until: br.until, by: br.by } : null,
          challenges: chal.map(c => ({ id: c.id, title: c.title, target: c.target, starts: c.starts, ends: c.ends, by: c.by, progress: prog[c.id] || {} })) }, 200, H);
      }

      // ---- push: subscribe this phone, schedule reminders, test ----
      if (p === "/v1/push/subscribe" && req.method === "POST") {
        const b = await body(req), k = b && b.keys || {};
        if (!b || !/^https:\/\//.test(b.endpoint || "") || !k.p256dh || !k.auth) return err(400, "endpoint and keys are required", H);
        const id = await sha(b.endpoint);
        await env.DB.prepare("INSERT INTO push_subs (id, member, endpoint, p256dh, auth, created) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET member = excluded.member, p256dh = excluded.p256dh, auth = excluded.auth")
          .bind(id, me.id, clean(b.endpoint, 1000), clean(k.p256dh, 200), clean(k.auth, 100), now).run();
        return json({ ok: true }, 201, H);
      }
      if (p === "/v1/push/subscribe" && req.method === "DELETE") {
        const b = (await body(req)) || {};
        if (b.endpoint) await env.DB.prepare("DELETE FROM push_subs WHERE id = ? AND member = ?").bind(await sha(b.endpoint), me.id).run();
        else await env.DB.prepare("DELETE FROM push_subs WHERE member = ?").bind(me.id).run();
        return json({ ok: true }, 200, H);
      }
      // your reminders for the next days: replaces what was there (hard hours, nudges, start times)
      if (p === "/v1/push/schedule" && req.method === "PUT") {
        const b = await body(req); if (!b || !Array.isArray(b.items)) return err(400, "items are required", H);
        const items = b.items.slice(0, 120).filter(x => x && /^[a-z]+:[A-Za-z0-9:_-]{1,80}$/.test(x.key || "") && +x.at > now && +x.at < now + 8 * 864e5 && clean(x.title, 80));
        await env.DB.prepare("DELETE FROM push_sched WHERE member = ?").bind(me.id).run();
        for (const x of items) await env.DB.prepare("INSERT OR REPLACE INTO push_sched (member, k, at, title, body, kind, url) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(me.id, x.key, Math.floor(+x.at), clean(x.title, 80), clean(x.body, 200), clean(x.kind, 20), clean(x.url, 200) || "./").run();
        return json({ ok: true, n: items.length }, 200, H);
      }
      if (p === "/v1/push/test" && req.method === "POST") {
        const n = await pushTo(env, me.id, { title: "Ten Days", body: "Notifications work on this phone.", tag: "test", url: "./", kind: "test" });
        return json({ ok: n > 0, sent: n }, n > 0 ? 200 : 409, H);
      }

      // ---- "I need you" on the server: it fires on time even if the app is closed ----
      if (p === "/v1/alerts" && req.method === "POST") {
        const b = await body(req); if (!b) return err(400, "bad json", H);
        const wait = Math.max(0, Math.min(600, Math.floor(+b.wait || 0)));
        const id = rid(16), n = b.ntfy && typeof b.ntfy === "object" ? JSON.stringify({ topic: clean(b.ntfy.topic, 64), params: b.ntfy.params || {}, body: clean(b.ntfy.body, 500) }) : null;
        await env.DB.prepare("INSERT INTO alerts (id, circle, member, fire_at, state, title, body, call, who, ntfy, created) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)")
          .bind(id, me.circle, me.id, now + wait * 1000, clean(b.title, 80) || me.name + " needs you", clean(b.body, 200) || "Call when you can.", clean(b.call, 40), me.name, n, now).run();
        return json({ id, fireAt: now + wait * 1000 }, 201, H);
      }
      let m;
      if ((m = p.match(/^\/v1\/alerts\/([a-z0-9]{16})(\/fire)?$/))) {
        const a = await env.DB.prepare("SELECT * FROM alerts WHERE id = ? AND member = ?").bind(m[1], me.id).first();
        if (!a) return err(404, "no such alert", H);
        if (!m[2] && req.method === "GET") return json({ state: a.state, fireAt: a.fire_at, sentAt: a.sent_at || 0 }, 200, H);
        if (!m[2] && req.method === "DELETE") { await env.DB.prepare("UPDATE alerts SET state = 'cancelled' WHERE id = ? AND state = 'pending'").bind(a.id).run(); return json({ ok: true }, 200, H); }
        if (m[2] && req.method === "POST") { const b = (await body(req)) || {}; const fired = await fireAlert(env, a, !!b.ntfyDone); return json({ ok: true, fired }, 200, H); }
      }
      // quiet signals and messages to the others in your circle
      if (p === "/v1/signal" && req.method === "POST") {
        const b = await body(req); if (!b) return err(400, "bad json", H);
        const text = clean(b.text, 300);
        const data = b.kind === "notgreat" ? { title: me.name, body: "Not a great day. No need to call, just letting you know.", tag: "notgreat-" + me.id, url: "./#people", kind: "notgreat" }
          : b.kind === "message" && text ? { title: me.name, body: text, tag: "msg-" + now, url: "./#people", kind: "message" } : null;
        if (!data) return err(400, "kind must be notgreat or message (with text)", H);
        return json({ ok: true, sent: await pushOthers(env, me, data) }, 200, H);
      }
      // one word a day, next to your name
      if (p === "/v1/word" && req.method === "PUT") {
        const b = await body(req); const w = clean(b && b.word, 24).split(/\s+/).slice(0, 2).join(" "), day = clean(b && b.day, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return err(400, "day is required", H);
        await env.DB.prepare("UPDATE members SET word = ?, word_day = ? WHERE id = ?").bind(w, w ? day : "", me.id).run();
        return json({ ok: true }, 200, H);
      }
      // a time capsule: written during the first three days of a run, sealed until it ends
      if ((m = p.match(/^\/v1\/capsules\/(\d{1,5})$/)) && req.method === "PUT") {
        const b = await body(req), text = clean(b && b.text, 600), per = +m[1], cur = periodOf(me.circle_created, now);
        if (per !== cur) return err(409, "you can only write to the run that's going now", H);
        const dayIn = Math.floor(now / 864e5) - Math.floor(me.circle_created / 864e5) - cur * 10;
        if (dayIn > 2) return err(409, "time capsules are written in the first three days of a run", H);
        if (!text) return err(400, "write something first", H);
        await env.DB.prepare("INSERT INTO capsules (circle, period, member, text, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(circle, period, member) DO UPDATE SET text = excluded.text, created = excluded.created").bind(me.circle, per, me.id, text, now).run();
        return json({ ok: true }, 200, H);
      }
      // breathe together: the same circle on every phone, from one shared start time
      if (p === "/v1/breathe" && req.method === "POST") {
        const start = now + 4000, until = start + 3 * 60e3;
        await env.DB.prepare("INSERT INTO breathe (circle, start, until, by) VALUES (?, ?, ?, ?) ON CONFLICT(circle) DO UPDATE SET start = excluded.start, until = excluded.until, by = excluded.by").bind(me.circle, start, until, me.id).run();
        await pushOthers(env, me, { title: me.name + " wants to breathe with you", body: "Three minutes, same rhythm. Open Ten Days to join.", tag: "breathe", url: "./#breathe", kind: "breathe" });
        return json({ start, until, now }, 201, H);
      }
      if (p === "/v1/breathe" && req.method === "DELETE") { await env.DB.prepare("DELETE FROM breathe WHERE circle = ?").bind(me.circle).run(); return json({ ok: true }, 200, H); }
      // a challenge between you: two bars while it runs, gone when it ends
      if (p === "/v1/challenges" && req.method === "POST") {
        const b = await body(req), title = clean(b && b.title, 60), target = Math.max(1, Math.min(100, Math.floor(+(b && b.target) || 0))), days = Math.max(1, Math.min(30, Math.floor(+(b && b.days) || 0)));
        if (!title || !b.target || !b.days) return err(400, "title, target and days are required", H);
        const live = await env.DB.prepare("SELECT COUNT(*) AS n FROM challenges WHERE circle = ? AND ends > ?").bind(me.circle, now).first();
        if (live.n >= 3) return err(409, "three challenges at once is plenty", H);
        const id = rid(16);
        await env.DB.prepare("INSERT INTO challenges (id, circle, title, target, starts, ends, by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, me.circle, title, target, now, now + days * 864e5, me.id, now).run();
        await pushOthers(env, me, { title: me.name + " started a challenge", body: title + " · " + target + " in " + days + (days === 1 ? " day" : " days"), tag: "chal-" + id, url: "./", kind: "challenge" });
        return json({ id }, 201, H);
      }
      if ((m = p.match(/^\/v1\/challenges\/([a-z0-9]{16})(\/progress)?$/))) {
        const c = await env.DB.prepare("SELECT * FROM challenges WHERE id = ? AND circle = ?").bind(m[1], me.circle).first();
        if (!c) return err(404, "no such challenge", H);
        if (m[2] && req.method === "POST") {
          if (c.ends <= now) return err(409, "this challenge is over", H);
          const b = (await body(req)) || {}, d = Math.max(-5, Math.min(5, Math.floor(+b.delta || 0)));
          await env.DB.prepare("INSERT INTO chal_progress (challenge, member, count) VALUES (?, ?, MAX(0, ?)) ON CONFLICT(challenge, member) DO UPDATE SET count = MAX(0, MIN(?, count + ?))").bind(c.id, me.id, d, c.target, d).run();
          const x = await env.DB.prepare("SELECT count FROM chal_progress WHERE challenge = ? AND member = ?").bind(c.id, me.id).first();
          return json({ count: x ? x.count : 0 }, 200, H);
        }
        if (!m[2] && req.method === "DELETE") {
          if (c.by !== me.id) return err(403, "only the person who started it can end it", H);
          await env.DB.prepare("UPDATE challenges SET ends = ? WHERE id = ?").bind(now, c.id).run();
          return json({ ok: true }, 200, H);
        }
      }

      // ---- moments ----
      if (p === "/v1/moments" && req.method === "POST") {
        const id = clean(req.headers.get("x-moment-id"), 40);
        if (!ID_RE.test(id)) return err(400, "x-moment-id is required", H);
        const caption = clean(decodeHeader(req.headers.get("x-caption")), 500), forStory = req.headers.get("x-for-story") !== "0";
        const ex = await env.DB.prepare("SELECT * FROM moments WHERE id = ?").bind(id).first();
        if (ex) return ex.circle === me.circle && ex.author === me.id ? json({ id, created: ex.created, duplicate: true }, 200, H) : err(409, "id taken", H);
        const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const len = +req.headers.get("content-length") || 0;
        if (len > MAX_PHOTO) return err(413, "photo too large", H);
        const buf = await req.arrayBuffer();
        let key = null;
        if (buf.byteLength) {
          if (buf.byteLength > MAX_PHOTO) return err(413, "photo too large", H);
          if (!sniff(buf, type)) return err(415, "only JPEG, PNG or WebP photos", H);
          key = "c/" + me.circle + "/" + id;
          await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: type } });
        } else if (!caption) return err(400, "a moment needs a photo or a caption", H);
        await env.DB.prepare("INSERT INTO moments (id, circle, author, caption, for_story, photo_key, photo_type, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(id, me.circle, me.id, caption, forStory ? 1 : 0, key, key ? type : null, now, now).run();
        await pushOthers(env, me, { title: me.name + " shared a moment", body: caption || "A new photo.", tag: "moment-" + id, url: "./#moments", kind: "moment" });
        return json({ id, created: now }, 201, H);
      }
      if ((m = p.match(/^\/v1\/moments\/([a-z0-9]+)(\/photo|\/reaction|\/replies)?$/))) {
        const mo = await visibleMoment(env, me, m[1]);
        if (!mo || mo.deleted) return err(404, "no such moment", H);
        const sub = m[2] || "";
        if (sub === "/photo" && req.method === "GET") {
          if (!mo.photo_key) return err(404, "no photo", H);
          const obj = await env.PHOTOS.get(mo.photo_key);
          if (!obj) return err(404, "photo missing", H);
          return new Response(obj.body, { headers: { ...H, "content-type": mo.photo_type || "image/jpeg", "cache-control": "private, max-age=31536000, immutable" } });
        }
        if (sub === "/reaction" && req.method === "PUT") {
          const b = await body(req); if (!b || REACTIONS.indexOf(b.kind) < 0) return err(400, "kind must be one of " + REACTIONS.join(", "), H);
          const before = await env.DB.prepare("SELECT kind FROM reactions WHERE moment = ? AND member = ?").bind(mo.id, me.id).first();
          await env.DB.prepare("INSERT INTO reactions (moment, member, kind, at) VALUES (?, ?, ?, ?) ON CONFLICT(moment, member) DO UPDATE SET kind = excluded.kind, at = excluded.at").bind(mo.id, me.id, b.kind, now).run();
          await touch(env, mo.id, now);
          if (mo.author !== me.id && (!before || before.kind !== b.kind)) await pushTo(env, mo.author, { title: me.name + ": " + RX_LABEL[b.kind], body: "On your " + (mo.photo_key ? "photo" : "moment") + (mo.caption ? ": " + mo.caption.slice(0, 80) : "") + ".", tag: "rx-" + mo.id + "-" + me.id, url: "./#moments", kind: "reaction" });
          return json({ ok: true }, 200, H);
        }
        if (sub === "/reaction" && req.method === "DELETE") {
          await env.DB.prepare("DELETE FROM reactions WHERE moment = ? AND member = ?").bind(mo.id, me.id).run();
          await touch(env, mo.id, now);
          return json({ ok: true }, 200, H);
        }
        if (sub === "/replies" && req.method === "POST") {
          const b = await body(req); const text = b && clean(b.text, 300), id = b && clean(b.id, 40);
          if (!text || !ID_RE.test(id || "")) return err(400, "text and id are required", H);
          const ex = await env.DB.prepare("SELECT id FROM replies WHERE id = ?").bind(id).first();
          if (!ex) await env.DB.prepare("INSERT INTO replies (id, moment, member, text, at) VALUES (?, ?, ?, ?, ?)").bind(id, mo.id, me.id, text, now).run();
          await touch(env, mo.id, now);
          return json({ ok: true }, 201, H);
        }
        if (!sub && req.method === "PATCH") {
          if (mo.author !== me.id) return err(403, "only the person who posted it can change it", H);
          const b = await body(req); if (!b) return err(400, "bad json", H);
          await env.DB.prepare("UPDATE moments SET caption = ?, for_story = ?, updated = ? WHERE id = ?")
            .bind(typeof b.caption === "string" ? clean(b.caption, 500) : mo.caption, typeof b.forStory === "boolean" ? (b.forStory ? 1 : 0) : mo.for_story, now, mo.id).run();
          return json({ ok: true }, 200, H);
        }
        if (!sub && req.method === "DELETE") {
          if (mo.author !== me.id) return err(403, "only the person who posted it can delete it", H);
          await removeMoment(env, mo, now);
          return json({ ok: true }, 200, H);
        }
      }
      if ((m = p.match(/^\/v1\/replies\/([a-z0-9]+)$/)) && req.method === "DELETE") {
        const r = await env.DB.prepare("SELECT r.*, mo.circle FROM replies r JOIN moments mo ON mo.id = r.moment WHERE r.id = ?").bind(m[1]).first();
        if (!r || r.circle !== me.circle) return err(404, "no such reply", H);
        if (r.member !== me.id) return err(403, "only the person who wrote it can delete it", H);
        await env.DB.prepare("DELETE FROM replies WHERE id = ?").bind(r.id).run();
        await touch(env, r.moment, now);
        return json({ ok: true }, 200, H);
      }
      if ((m = p.match(/^\/v1\/chapters\/(\d{1,5})$/)) && req.method === "PUT") {
        const b = await body(req); if (!b) return err(400, "bad json", H);
        const ids = (Array.isArray(b.momentIds) ? b.momentIds : []).filter(x => ID_RE.test(x || "")).slice(0, 60);
        await env.DB.prepare("INSERT INTO chapters (circle, period, title, body, moment_ids, by_member, updated, by_ai) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(circle, period) DO UPDATE SET title = excluded.title, body = excluded.body, moment_ids = excluded.moment_ids, by_member = excluded.by_member, updated = excluded.updated, by_ai = excluded.by_ai")
          .bind(me.circle, +m[1], clean(b.title, 120), clean(b.body, 6000), JSON.stringify(ids), me.id, now, b.byAi ? 1 : 0).run();
        return json({ ok: true }, 200, H);
      }
      return err(404, "not found", H);
    } catch (e) {
      return err(500, "server error", H);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runDue(env, Date.now())); }
};

async function removeMoment(env, mo, now) {
  if (mo.photo_key) await env.PHOTOS.delete(mo.photo_key);
  await env.DB.prepare("DELETE FROM reactions WHERE moment = ?").bind(mo.id).run();
  await env.DB.prepare("DELETE FROM replies WHERE moment = ?").bind(mo.id).run();
  await env.DB.prepare("UPDATE moments SET deleted = 1, caption = '', photo_key = NULL, photo_type = NULL, updated = ? WHERE id = ?").bind(now, mo.id).run();
}
function safeIds(s) { try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter(x => typeof x === "string") : []; } catch (e) { return []; } }
function decodeHeader(v) { try { return decodeURIComponent(v || ""); } catch (e) { return ""; } }
