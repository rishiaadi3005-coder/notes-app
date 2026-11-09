// Moments server tests: the real Worker code, with D1 and R2 replaced by in-memory stand-ins.
// Run: node tests/worker.test.js
const fs = require("fs"), path = require("path");
const { makeEnv } = require("./cfshim");
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
  ok(r.status === 201 && code, "invite made");
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
  r = await call("GET", "/v1/moments/kmoment0001/photo", { token: audi });
  ok(r.status === 200 && r.data[0] === 0xff && r.h.get("content-type") === "image/jpeg", "Audi can load the photo");
  ok((await call("GET", "/v1/moments/kmoment0001/photo")).status === 401, "photo needs a token");

  // reactions and replies
  ok((await call("PUT", "/v1/moments/kmoment0001/reaction", { token: audi, json: { kind: "respect" } })).status === 200, "react with Respect");
  ok((await call("PUT", "/v1/moments/kmoment0001/reaction", { token: audi, json: { kind: "fire" } })).status === 200, "change the reaction");
  ok((await call("PUT", "/v1/moments/kmoment0001/reaction", { token: audi, json: { kind: "angry" } })).status === 400, "unknown reaction refused");
  ok((await call("POST", "/v1/moments/kmoment0001/replies", { token: audi, json: { id: "kreply00001", text: "beast" } })).status === 201, "optional reply");
  r = await call("GET", "/v1/sync?since=0", { token: rishi });
  const m1 = r.data.moments.find(m => m.id === "kmoment0001");
  ok(m1.reactions.length === 1 && m1.reactions[0].kind === "fire" && m1.reactions[0].member === audiId && m1.replies[0].text === "beast", "one reaction per person, reply attached");
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
  ok((await call("PUT", "/v1/moments/kmoment0001/reaction", { token: other, json: { kind: "love" } })).status === 404, "other circle can't react");

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

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
