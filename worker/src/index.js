// Ten Days Moments server: a Cloudflare Worker with D1 (records) and R2 (photos).
//
// A "circle" is a small private group (you and your brother, later a few friends).
// Every member has their own secret token; the server keeps only its SHA-256 hash.
// New members join with a single-use invite code that expires after 7 days.
// Members see the moments posted from 10 days before they joined onward, never older history.

const REACTIONS = ["respect", "seeyou", "prove", "brother", "saving"];
const MAX_PHOTO = 3 * 1024 * 1024;
const MAX_MEMBERS = 12;
const INVITE_MS = 7 * 864e5;
const HISTORY_MS = 10 * 864e5;
const TYPES = { "image/jpeg": [0xff, 0xd8, 0xff], "image/png": [0x89, 0x50, 0x4e, 0x47], "image/webp": [0x52, 0x49, 0x46, 0x46] };

const ID_RE = /^[a-z0-9]{8,40}$/;

function rid(n) {
  const a = "abcdefghijkmnpqrstuvwxyz23456789", b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = ""; for (const x of b) s += a[x % a.length];
  return s;
}
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
    "access-control-allow-headers": "authorization, content-type, x-moment-id, x-caption, x-for-story",
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
  const { results } = await env.DB.prepare("SELECT id, name, joined, left_at, seen FROM members WHERE circle = ? ORDER BY joined").bind(me.circle).all();
  return { circle: { id: me.circle, name: me.circle_name, created: me.circle_created }, me: { id: me.id, name: me.name },
    members: results.map(r => ({ id: r.id, name: r.name, joined: r.joined, left: !!r.left_at, seen: r.seen || 0 })) };
}
// a moment the member may see: same circle, and not older than their history window
async function visibleMoment(env, me, id) {
  if (!ID_RE.test(id || "")) return null;
  const m = await env.DB.prepare("SELECT * FROM moments WHERE id = ? AND circle = ?").bind(id, me.circle).first();
  if (!m || m.created < me.joined - HISTORY_MS) return null;
  return m;
}
async function touch(env, id, now) { await env.DB.prepare("UPDATE moments SET updated = ? WHERE id = ?").bind(now, id).run(); }
function sniff(buf, type) { const sig = TYPES[type]; if (!sig) return false; const b = new Uint8Array(buf.slice(0, sig.length)); return sig.every((x, i) => b[i] === x); }

export default {
  async fetch(req, env) {
    const H = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: H });
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, ""), now = Date.now();
    try {
      if (p === "" || p === "/v1") return json({ ok: true, service: "ten-days-moments", v: 1 }, 200, H);

      // start a circle: you become its first member
      if (p === "/v1/circles" && req.method === "POST") {
        const b = await body(req); if (!b) return err(400, "bad json", H);
        const name = clean(b.memberName, 40); if (!name) return err(400, "your name is required", H);
        const id = rid(16);
        await env.DB.prepare("INSERT INTO circles (id, name, created) VALUES (?, ?, ?)").bind(id, clean(b.name, 60), now).run();
        const m = await newMember(env, id, name, now);
        return json({ token: m.token, ...(await circleView(env, { id: m.id, circle: id, name, joined: now, circle_created: now, circle_name: clean(b.name, 60) })) }, 201, H);
      }
      // join with an invite code
      if (p === "/v1/join" && req.method === "POST") {
        const b = await body(req); if (!b) return err(400, "bad json", H);
        const name = clean(b.name, 40), code = clean(b.code, 64);
        if (!name || !code) return err(400, "name and code are required", H);
        const inv = await env.DB.prepare("SELECT * FROM invites WHERE code_hash = ?").bind(await sha(code)).first();
        if (!inv || inv.used_by || inv.expires < now) return err(403, "this invite is used, expired or wrong", H);
        const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE circle = ? AND left_at IS NULL").bind(inv.circle).first();
        if (n.n >= MAX_MEMBERS) return err(403, "this circle is full", H);
        const c = await env.DB.prepare("SELECT * FROM circles WHERE id = ?").bind(inv.circle).first();
        const m = await newMember(env, inv.circle, name, now);
        // single use: only the first join wins
        const r = await env.DB.prepare("UPDATE invites SET used_by = ? WHERE code_hash = ? AND used_by IS NULL").bind(m.id, inv.code_hash).run();
        if (!r.meta || r.meta.changes !== 1) { await env.DB.prepare("DELETE FROM members WHERE id = ?").bind(m.id).run(); return err(403, "this invite was just used", H); }
        return json({ token: m.token, ...(await circleView(env, { id: m.id, circle: c.id, name, joined: now, circle_created: c.created, circle_name: c.name })) }, 201, H);
      }

      const me = await auth(req, env);
      if (!me) return err(401, "not a member", H);

      if (p === "/v1/circle" && req.method === "GET") return json(await circleView(env, me), 200, H);

      if (p === "/v1/invites" && req.method === "POST") {
        const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE circle = ? AND used_by IS NULL AND expires > ?").bind(me.circle, now).first();
        if (open.n >= 20) return err(429, "too many open invites", H);
        const code = rid(20);
        await env.DB.prepare("INSERT INTO invites (code_hash, circle, by_member, expires) VALUES (?, ?, ?, ?)").bind(await sha(code), me.circle, me.id, now + INVITE_MS).run();
        return json({ code, expires: now + INVITE_MS }, 201, H);
      }

      if (p === "/v1/leave" && req.method === "POST") {
        const b = (await body(req)) || {};
        if (b.deleteMine) {
          const { results } = await env.DB.prepare("SELECT id, photo_key FROM moments WHERE circle = ? AND author = ? AND deleted = 0").bind(me.circle, me.id).all();
          for (const m of results) await removeMoment(env, m, now);
          await env.DB.prepare("DELETE FROM reactions WHERE member = ?").bind(me.id).run();
          await env.DB.prepare("DELETE FROM replies WHERE member = ?").bind(me.id).run();
        }
        await env.DB.prepare("UPDATE members SET left_at = ? WHERE id = ?").bind(now, me.id).run();
        return json({ ok: true }, 200, H);
      }

      // everything that changed since a time: moments (with reactions and replies), chapters, members
      if (p === "/v1/sync" && req.method === "GET") {
        const since = Math.max(0, Math.floor(+url.searchParams.get("since") || 0));
        // syncing means you have the app open: that's the "he's here too" glow, nothing more precise
        await env.DB.prepare("UPDATE members SET seen = ? WHERE id = ?").bind(now, me.id).run();
        const floor = me.joined - HISTORY_MS;
        const { results: ms } = await env.DB.prepare("SELECT * FROM moments WHERE circle = ? AND updated >= ? AND created >= ? ORDER BY created LIMIT 500").bind(me.circle, since, floor).all();
        const ids = ms.map(m => m.id), rx = {}, rp = {};
        if (ids.length) {
          const q = ids.map(() => "?").join(",");
          (await env.DB.prepare("SELECT * FROM reactions WHERE moment IN (" + q + ")").bind(...ids).all()).results.forEach(r => (rx[r.moment] = rx[r.moment] || []).push({ member: r.member, kind: r.kind, at: r.at }));
          (await env.DB.prepare("SELECT * FROM replies WHERE moment IN (" + q + ") ORDER BY at").bind(...ids).all()).results.forEach(r => (rp[r.moment] = rp[r.moment] || []).push({ id: r.id, member: r.member, text: r.text, at: r.at }));
        }
        const { results: ch } = await env.DB.prepare("SELECT * FROM chapters WHERE circle = ? AND updated >= ?").bind(me.circle, since).all();
        return json({ now, ...(await circleView(env, me)),
          moments: ms.map(m => ({ id: m.id, author: m.author, caption: m.caption, forStory: !!m.for_story, hasPhoto: !!m.photo_key, created: m.created, updated: m.updated, deleted: !!m.deleted, reactions: rx[m.id] || [], replies: rp[m.id] || [] })),
          chapters: ch.map(c => ({ period: c.period, title: c.title, body: c.body, momentIds: safeIds(c.moment_ids), by: c.by_member, updated: c.updated })) }, 200, H);
      }

      // post a moment: the photo is the request body; caption and id ride in headers
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
        return json({ id, created: now }, 201, H);
      }

      let m;
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
          await env.DB.prepare("INSERT INTO reactions (moment, member, kind, at) VALUES (?, ?, ?, ?) ON CONFLICT(moment, member) DO UPDATE SET kind = excluded.kind, at = excluded.at").bind(mo.id, me.id, b.kind, now).run();
          await touch(env, mo.id, now);
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
      // a ten-day chapter, written on one phone and kept for everyone in the circle
      if ((m = p.match(/^\/v1\/chapters\/(\d{1,5})$/)) && req.method === "PUT") {
        const b = await body(req); if (!b) return err(400, "bad json", H);
        const ids = (Array.isArray(b.momentIds) ? b.momentIds : []).filter(x => ID_RE.test(x || "")).slice(0, 60);
        await env.DB.prepare("INSERT INTO chapters (circle, period, title, body, moment_ids, by_member, updated) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(circle, period) DO UPDATE SET title = excluded.title, body = excluded.body, moment_ids = excluded.moment_ids, by_member = excluded.by_member, updated = excluded.updated")
          .bind(me.circle, +m[1], clean(b.title, 120), clean(b.body, 6000), JSON.stringify(ids), me.id, now).run();
        return json({ ok: true }, 200, H);
      }
      return err(404, "not found", H);
    } catch (e) {
      return err(500, "server error", H);
    }
  }
};

async function removeMoment(env, mo, now) {
  if (mo.photo_key) await env.PHOTOS.delete(mo.photo_key);
  await env.DB.prepare("DELETE FROM reactions WHERE moment = ?").bind(mo.id).run();
  await env.DB.prepare("DELETE FROM replies WHERE moment = ?").bind(mo.id).run();
  await env.DB.prepare("UPDATE moments SET deleted = 1, caption = '', photo_key = NULL, photo_type = NULL, updated = ? WHERE id = ?").bind(now, mo.id).run();
}
function safeIds(s) { try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter(x => typeof x === "string") : []; } catch (e) { return []; } }
function decodeHeader(v) { try { return decodeURIComponent(v || ""); } catch (e) { return ""; } }
