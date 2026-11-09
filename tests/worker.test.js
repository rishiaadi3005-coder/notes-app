// Moments server tests: the real Worker code, with D1 and R2 replaced by in-memory stand-ins.
// Run: node tests/worker.test.js
const fs = require("fs"), path = require("path");
const { makeEnv } = require("./cfshim");
const kit = require("./pushkit");
let pass = 0, fail = 0;
function ok(c, name) { if (c) pass++; else { fail++; console.log("  FAIL " + name); } }

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
(async () => {
  const worker = (await import(path.join(__dirname, "../worker/src/index.js"))).default;
  const env = makeEnv(fs.readFileSync(path.join(__dirname, "../worker/schema.sql"), "utf8"), { ALLOWED_ORIGINS: "https://app.example" });
  const call = async (method, p, opts) => {
    opts = opts || {};
    const headers = { origin: "https://app.example", ...(opts.headers || {}) };
    if (opts.token) headers.authorization = "Bearer " + opts.token;
    let body = opts.body;
    if (opts.json !== undefined) { body = JSON.stringify(opts.json); headers["content-type"] = "application/json"; }
    const r = await worker.fetch(new Request("https://m.example" + p, { method, headers, body }), env);
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, h: r.headers, data: ct.includes("json") ? await r.json() : new Uint8Array(await r.arrayBuffer()) };
  };
  const post = (token, id, caption, body, type) => call("POST", "/v1/moments", { token, body: body === undefined ? JPEG : body, headers: { "content-type": type || "image/jpeg", "x-moment-id": id, "x-caption": encodeURIComponent(caption || "") } });

  // start and join
  let r = await call("POST", "/v1/circles", { json: { memberName: "Rishi" } });
  ok(r.status === 201 && r.data.token && r.data.me.name === "Rishi" && r.data.members.length === 1, "start a circle");
  ok(r.h.get("access-control-allow-origin") === "https://app.example", "CORS limited to the app");
  const rishi = r.data.token, rishiId = r.data.me.id;
  ok(!JSON.stringify([...env.DB._db.prepare("SELECT * FROM members").all()]).includes(rishi), "token is stored only as a hash");
  ok((await call("GET", "/v1/sync")).status === 401, "no token: refused");
  ok((await call("GET", "/v1/sync", { token: "x".repeat(40) })).status === 401, "wrong token: refused");
  r = await call("POST", "/v1/invites", { token: rishi });
  const code = r.data.code;
  ok(r.status === 201 && /^[A-HJ-NP-Z2-9]{6}$/.test(code) && r.data.expires - Date.now() <= 15 * 60e3 + 1000, "a 6-character code, no O/0 or I/1, 15 minutes: " + code);
  r = await call("POST", "/v1/join", { json: { code, name: "Audi" } });
  ok(r.status === 201 && r.data.members.length === 2, "Audi joins");
  const audi = r.data.token, audiId = r.data.me.id;
  ok((await call("POST", "/v1/join", { json: { code, name: "Stranger" } })).status === 403, "an invite works once");
  ok((await call("POST", "/v1/join", { json: { code: "nope-nope-nope", name: "X" } })).status === 403, "a made-up code fails");

  // moments
  r = await post(rishi, "kmoment0001", "Leg day");
  ok(r.status === 201, "post a photo moment");
  ok((await post(rishi, "kmoment0001", "Leg day")).data.duplicate, "posting the same id twice is safe");
  ok((await post(audi, "kmoment0001", "steal")).status === 409, "someone else can't reuse an id");
  ok((await post(rishi, "kmoment0002", "x", new Uint8Array([1, 2, 3, 4]), "image/jpeg")).status === 415, "not really a JPEG: refused");
  ok((await post(rishi, "kmoment0003", "x", new Uint8Array(3 * 1024 * 1024 + 10).fill(0xff), "image/jpeg")).status === 413, "too large: refused");
  ok((await post(rishi, "kmoment0004", "", new Uint8Array(0))).status === 400, "empty moment: refused");
  r = await post(audi, "kmoment0005", "Rest day, just text", new Uint8Array(0));
  ok(r.status === 201, "caption-only moment");
  r = await call("GET", "/v1/sync?since=0", { token: audi });
  ok(r.status === 200 && r.data.moments.length === 2 && r.data.moments[0].caption === "Leg day" && r.data.moments[0].hasPhoto, "Audi sees both moments");
  ok(r.data.members.find(m => m.id === audiId).seen > 0, "syncing marks him as here");
  r = await call("GET", "/v1/moments/kmoment0001/photo", { token: audi });
  ok(r.status === 200 && r.data[0] === 0xff && r.h.get("content-type") === "image/jpeg", "Audi can load the photo");
  ok((await call("GET", "/v1/moments/kmoment0001/photo")).status === 401, "photo needs a token");

  // reactions and replies
  ok((await call("PUT", "/v1/moments/kmoment0001/reaction", { token: audi, json: { kind: "respect" } })).status === 200, "react with Respect");
  ok((await call("PUT", "/v1/moments/kmoment0001/reaction", { token: audi, json: { kind: "prove" } })).status === 200, "change the reaction");
  ok((await call("PUT", "/v1/moments/kmoment0001/reaction", { token: audi, json: { kind: "angry" } })).status === 400, "unknown reaction refused");
  ok((await call("POST", "/v1/moments/kmoment0001/replies", { token: audi, json: { id: "kreply00001", text: "beast" } })).status === 201, "optional reply");
  r = await call("GET", "/v1/sync?since=0", { token: rishi });
  const m1 = r.data.moments.find(m => m.id === "kmoment0001");
  ok(m1.reactions.length === 1 && m1.reactions[0].kind === "prove" && m1.reactions[0].member === audiId && m1.replies[0].text === "beast", "one reaction per person, reply attached");
  const since = r.data.now;
  r = await call("GET", "/v1/sync?since=" + (since + 1), { token: rishi });
  ok(r.data.moments.length === 0, "nothing new since last sync");
  await call("DELETE", "/v1/moments/kmoment0001/reaction", { token: audi });
  r = await call("GET", "/v1/sync?since=" + since, { token: rishi });
  ok(r.data.moments.length === 1 && r.data.moments[0].reactions.length === 0, "removing a reaction syncs");

  // only the author edits or deletes
  ok((await call("DELETE", "/v1/moments/kmoment0001", { token: audi })).status === 403, "Audi can't delete Rishi's moment");
  ok((await call("PATCH", "/v1/moments/kmoment0001", { token: rishi, json: { forStory: false } })).status === 200, "leave it out of the chapter");
  r = await call("GET", "/v1/sync?since=0", { token: audi });
  ok(r.data.moments.find(m => m.id === "kmoment0001").forStory === false, "the choice syncs");

  // another circle can't see in
  r = await call("POST", "/v1/circles", { json: { memberName: "Other" } });
  const other = r.data.token;
  ok((await call("GET", "/v1/sync?since=0", { token: other })).data.moments.length === 0, "other circle sees nothing");
  ok((await call("GET", "/v1/moments/kmoment0001/photo", { token: other })).status === 404, "other circle can't load the photo");
  ok((await call("PUT", "/v1/moments/kmoment0001/reaction", { token: other, json: { kind: "brother" } })).status === 404, "other circle can't react");

  // history window: someone joining later doesn't see old moments
  env.DB._db.prepare("UPDATE moments SET created = created - ? WHERE id = 'kmoment0005'").run(30 * 864e5);
  r = await call("POST", "/v1/invites", { token: rishi });
  const sam = (await call("POST", "/v1/join", { json: { code: r.data.code, name: "Sam" } })).data.token;
  r = await call("GET", "/v1/sync?since=0", { token: sam });
  ok(r.data.moments.length === 1 && r.data.moments[0].id === "kmoment0001" && r.data.members.length === 3, "a new member sees only the last ten days");

  // chapters
  ok((await call("PUT", "/v1/chapters/0", { token: rishi, json: { title: "Leg day and rest", body: "Rishi posted…", momentIds: ["kmoment0001", "BAD ID"] } })).status === 200, "save a chapter");
  r = await call("GET", "/v1/sync?since=0", { token: audi });
  ok(r.data.chapters.length === 1 && r.data.chapters[0].title === "Leg day and rest" && r.data.chapters[0].momentIds.join() === "kmoment0001", "the chapter syncs, bad ids dropped");

  // delete and leave
  ok((await call("DELETE", "/v1/moments/kmoment0001", { token: rishi })).status === 200, "author deletes");
  ok(!env.PHOTOS._store.has("c/" + r.data.circle.id + "/kmoment0001"), "photo removed from storage");
  r = await call("GET", "/v1/sync?since=0", { token: audi });
  ok(r.data.moments.find(m => m.id === "kmoment0001").deleted === true, "deletion syncs as a tombstone");
  ok((await call("POST", "/v1/leave", { token: audi, json: { deleteMine: true } })).status === 200, "Audi leaves and deletes his moments");
  ok((await call("GET", "/v1/sync", { token: audi })).status === 401, "after leaving, the token stops working");
  r = await call("GET", "/v1/sync?since=0", { token: rishi });
  const m5 = env.DB._db.prepare("SELECT deleted, caption FROM moments WHERE id = 'kmoment0005'").get();
  ok(m5.deleted === 1 && m5.caption === "" && r.data.members.find(m => m.id === audiId).left, "his moments are gone, he shows as left");
  ok((await call("OPTIONS", "/v1/moments")).status === 204, "preflight answered");


  // ---------- final round: codes, push, server-side alerts, reminders, extras, moving, the app files ----------
  const sent = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => { u = String(u); sent.push({ url: u, init, body: init && init.body }); return new Response(null, { status: u.includes("gone.test") ? 410 : 201 }); };
  const keys = await kit.vapidKeys(); env.VAPID_PUBLIC = keys.VAPID_PUBLIC; env.VAPID_PRIVATE_JWK = keys.VAPID_PRIVATE_JWK; env.VAPID_SUBJECT = "mailto:t@example.com";
  r = await call("POST", "/v1/circles", { json: { memberName: "Rishi" } }); const R2 = r.data.token, R2id = r.data.me.id;
  // codes: lowercase and spaces are fine; mistyped, reused and expired codes fail
  let c1 = (await call("POST", "/v1/invites", { token: R2 })).data.code;
  ok((await call("POST", "/v1/join", { json: { code: c1.slice(0, 5) + (c1[5] === "A" ? "B" : "A"), name: "Aadi" } })).status === 403, "mistyped code: no");
  ok((await call("POST", "/v1/join", { json: { code: "AB0I1O", name: "Aadi" } })).status === 403, "ambiguous characters are never valid");
  r = await call("POST", "/v1/join", { json: { code: " " + c1.slice(0, 3).toLowerCase() + "-" + c1.slice(3) + " ", name: "Aadi" } });
  ok(r.status === 201, "typed in lowercase with a dash: still works");
  const A2 = r.data.token, A2id = r.data.me.id;
  ok((await call("POST", "/v1/join", { json: { code: c1, name: "Again" } })).status === 403, "reused code: no");
  const c2 = (await call("POST", "/v1/invites", { token: R2 })).data.code;
  env.DB._db.prepare("UPDATE invites SET expires = ? WHERE used_by IS NULL").run(Date.now() - 1);
  ok((await call("POST", "/v1/join", { json: { code: c2, name: "Late" } })).status === 403, "expired code (after 15 minutes): no");
  let blocked = false;
  for (let i = 0; i < 25 && !blocked; i++) blocked = (await call("POST", "/v1/join", { json: { code: "ZZZZZ" + "23456789"[i % 8], name: "X" }, headers: { "cf-connecting-ip": "9.9.9.9" } })).status === 429;
  ok(blocked, "guessing codes gets rate-limited");
  // push: each phone subscribes; what it receives is encrypted for it alone and signed with the server's VAPID key
  ok((await call("GET", "/v1/push/key")).data.key === keys.VAPID_PUBLIC, "the app can fetch the public VAPID key");
  const subR = await kit.fakeSubscription("https://web.push.apple.com/rishi1"), subA = await kit.fakeSubscription("https://fcm.googleapis.com/fcm/send/aadi1");
  ok((await call("POST", "/v1/push/subscribe", { token: R2, json: subR.json })).status === 201 && (await call("POST", "/v1/push/subscribe", { token: A2, json: subA.json })).status === 201, "both phones subscribe");
  const lastTo = async (sub) => { const x = sent.filter(s => s.url === sub.json.endpoint).pop(); return x ? { data: await kit.decrypt(sub, x.body), headers: x.init.headers } : null; };
  sent.length = 0;
  await call("POST", "/v1/moments", { token: R2, body: JPEG, headers: { "content-type": "image/jpeg", "x-moment-id": "kpush000001", "x-caption": encodeURIComponent("Leg day") } });
  let got = await lastTo(subA);
  ok(got && got.data.title === "Rishi shared a moment" && got.data.body === "Leg day" && got.data.badge === 1, "new moment: a push to Aadi, with a badge count");
  ok(got && await kit.verifyVapid(got.headers.authorization, keys.verifyKey, subA.json.endpoint) && got.headers["content-encoding"] === "aes128gcm", "signed with VAPID and encrypted (aes128gcm)");
  ok(!sent.some(s => s.url === subR.json.endpoint), "the poster isn't pushed about their own moment");
  await call("PUT", "/v1/moments/kpush000001/reaction", { token: A2, json: { kind: "brother" } });
  got = await lastTo(subR);
  ok(got && got.data.title === "Aadi: 🫂 That's my brother" && got.data.url.includes("moments"), "a reaction: a push to the person who posted");
  sent.length = 0; await call("PUT", "/v1/moments/kpush000001/reaction", { token: A2, json: { kind: "brother" } });
  ok(!sent.length, "the same reaction again doesn't push twice");
  await call("POST", "/v1/signal", { token: A2, json: { kind: "notgreat" } });
  got = await lastTo(subR); ok(got && got.data.body.includes("Not a great day") && got.data.title === "Aadi", "not great today: a quiet push");
  await call("POST", "/v1/signal", { token: R2, json: { kind: "message", text: "Proud of you" } });
  got = await lastTo(subA); ok(got && got.data.body === "Proud of you", "tell him: a push with the message");
  await call("GET", "/v1/sync", { token: R2 });
  ok(env.DB._db.prepare("SELECT unread FROM members WHERE id = ?").get(R2id).unread === 0, "opening the app clears the badge count");
  // "I need you" on the server: fires on time with the app closed, with his ntfy as the fallback
  sent.length = 0;
  r = await call("POST", "/v1/alerts", { token: R2, json: { wait: 60, title: "Check in", body: "Call when you can.", call: "+15551234567", ntfy: { topic: "td-alertchannel01", params: { title: "Check in", priority: "5" }, body: "Call when you can." } } });
  const al = r.data.id;
  const due = (await import(path.join(__dirname, "../worker/src/index.js"))).runDue;
  await due(env, Date.now() + 30e3);
  ok(!sent.length, "not before the wait is over");
  await due(env, Date.now() + 61e3);
  got = await lastTo(subA);
  ok(got && got.data.kind === "sos" && got.data.url.includes("call=%2B15551234567") && got.headers.urgency === "high", "after the wait: an urgent push to Aadi with the number to call");
  ok(sent.some(s => s.url.startsWith("https://ntfy.sh/td-alertchannel01") && s.url.includes("priority=5")), "and his ntfy alert, for when push isn't on");
  ok((await call("GET", "/v1/alerts/" + al, { token: R2 })).data.state === "sent", "the app can see it went out");
  sent.length = 0; await due(env, Date.now() + 120e3); ok(!sent.length, "fires once");
  r = await call("POST", "/v1/alerts", { token: R2, json: { wait: 60 } });
  await call("DELETE", "/v1/alerts/" + r.data.id, { token: R2 }); sent.length = 0; await due(env, Date.now() + 61e3);
  ok(!sent.length, "Don't tell him: cancelled on the server too");
  r = await call("POST", "/v1/alerts", { token: R2, json: { wait: 60, ntfy: { topic: "td-alertchannel01", body: "x" } } }); sent.length = 0;
  await call("POST", "/v1/alerts/" + r.data.id + "/fire", { token: R2, json: { ntfyDone: true } });
  ok(sent.some(s => s.url === subA.json.endpoint) && !sent.some(s => s.url.includes("ntfy.sh")), "Tell now with the app open: push now, ntfy already sent by the app");
  ok((await call("GET", "/v1/alerts/" + r.data.id, { token: A2 })).status === 404, "nobody else can read your alerts");
  // reminders: hard hours, nudges, start times, sent by the cron at their time
  const at = Date.now() + 3600e3;
  r = await call("PUT", "/v1/push/schedule", { token: R2, json: { items: [{ key: "nudge:kc1:0", at, title: "Grounding", body: "Now's a good time.", kind: "nudge", url: "./#n=nudge:kc1:0" }, { key: "hard:0", at: at + 60e3, title: "Heads-up", body: "Hard hours ahead." }, { key: "bad key!", at, title: "x" }, { key: "task:old", at: Date.now() - 5, title: "past" }] } });
  ok(r.data.n === 2, "reminders saved; bad and past ones dropped");
  sent.length = 0; await due(env, at + 1000);
  got = await lastTo(subR);
  ok(got && got.data.title === "Grounding" && got.data.url === "./#n=nudge:kc1:0" && sent.filter(s => s.url === subR.json.endpoint).length === 1, "a nudge on the lock screen at the learned time");
  await call("PUT", "/v1/push/schedule", { token: R2, json: { items: [] } }); sent.length = 0; await due(env, at + 61e3);
  ok(!sent.length, "quieted nudges are taken off the schedule");
  // a dead subscription is forgotten
  await call("POST", "/v1/push/subscribe", { token: R2, json: (await kit.fakeSubscription("https://gone.test/x")).json });
  await call("POST", "/v1/push/test", { token: R2 });
  ok(!env.DB._db.prepare("SELECT * FROM push_subs WHERE endpoint = 'https://gone.test/x'").get(), "a phone that unsubscribed (410) is removed");
  // one word, time capsules, breathing together, a challenge
  const today = new Date().toISOString().slice(0, 10);
  await call("PUT", "/v1/word", { token: A2, json: { word: "locked in", day: today } });
  r = await call("GET", "/v1/sync", { token: R2 });
  ok(r.data.members.find(m => m.id === A2id).word === "locked in", "one word next to his name");
  ok((await call("PUT", "/v1/capsules/0", { token: A2, json: { text: "Ten days from now, you'll be glad you started." } })).status === 200, "a time capsule at the start of the run");
  r = await call("GET", "/v1/sync", { token: R2 }); ok(!r.data.capsules.length, "sealed: Rishi can't read it yet");
  r = await call("GET", "/v1/sync", { token: A2 }); ok(r.data.capsules.length === 1, "Aadi sees his own");
  const cid = env.DB._db.prepare("SELECT circle FROM members WHERE id = ?").get(R2id).circle;
  env.DB._db.prepare("UPDATE circles SET created = created - ? WHERE id = ?").run(11 * 864e5, cid);
  r = await call("GET", "/v1/sync", { token: R2 }); ok(r.data.capsules.length === 1 && r.data.capsules[0].text.includes("glad you started"), "unsealed when the run ends");
  env.DB._db.prepare("UPDATE circles SET created = created - ? WHERE id = ?").run(3 * 864e5, cid);
  ok((await call("PUT", "/v1/capsules/1", { token: R2, json: { text: "late" } })).status === 409, "written only in the first three days of a run");
  sent.length = 0; r = await call("POST", "/v1/breathe", { token: R2 });
  ok(r.data.start > r.data.now && (await lastTo(subA)).data.kind === "breathe", "breathe together: a shared start time and a push to him");
  ok((await call("GET", "/v1/sync", { token: A2 })).data.breathe.start === r.data.start, "his phone gets the same start");
  r = await call("POST", "/v1/challenges", { token: R2, json: { title: "Workouts", target: 5, days: 7 } }); const ch = r.data.id;
  await call("POST", "/v1/challenges/" + ch + "/progress", { token: R2, json: { delta: 1 } }); await call("POST", "/v1/challenges/" + ch + "/progress", { token: A2, json: { delta: 1 } }); await call("POST", "/v1/challenges/" + ch + "/progress", { token: A2, json: { delta: 1 } });
  r = await call("GET", "/v1/sync", { token: R2 }); const cc = r.data.challenges[0];
  ok(cc && cc.progress[R2id] === 1 && cc.progress[A2id] === 2, "a challenge: both counts");
  ok((await call("DELETE", "/v1/challenges/" + ch, { token: A2 })).status === 403, "only the one who started it can end it");
  env.DB._db.prepare("UPDATE challenges SET ends = ? WHERE id = ?").run(Date.now() - 1, ch);
  ok(!(await call("GET", "/v1/sync", { token: R2 })).data.challenges.length, "when it ends it's gone: no lasting scores");
  // moving to the new app: upload once, download once
  ok((await call("POST", "/v1/transfer", { body: new Uint8Array([1, 2, 3, 4]), headers: { "x-move-id": "AB2C" } })).status === 201, "the old app uploads its encrypted bundle");
  r = await call("GET", "/v1/transfer/ab2c"); ok(r.status === 200 && r.data.length === 4, "the new app downloads it with the code");
  ok((await call("GET", "/v1/transfer/AB2C")).status === 404, "only once");
  // the app files come from the same Worker
  let asked = null; env.ASSETS = { fetch: req => { asked = new URL(req.url).pathname; return new Response("<html>", { headers: { "content-type": "text/html" } }); } };
  r = await worker.fetch(new Request("https://m.example/index.html"), env);
  ok(asked === "/index.html" && r.status === 200, "the app is served from the same address as the server");
  globalThis.fetch = realFetch;
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
