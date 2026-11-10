// Stand-ins for Cloudflare D1 and R2 so the real Worker code runs under Node in tests.
const { DatabaseSync } = require("node:sqlite");
function makeEnv(schema, vars) {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  const DB = {
    _db: db,
    prepare(sql) {
      const st = db.prepare(sql); let args = [];
      const o = {
        bind(...a) { args = a.map(x => x === undefined ? null : x); return o; },
        async first() { const r = st.get(...args); return r === undefined ? null : { ...r }; },
        async all() { return { results: st.all(...args).map(r => ({ ...r })) }; },
        async run() { const r = st.run(...args); return { meta: { changes: Number(r.changes) } }; }
      };
      return o;
    }
  };
  const store = new Map();
  const PHOTOS = {
    _store: store,
    async put(k, buf, opts) { store.set(k, { buf: new Uint8Array(buf).slice(), type: opts && opts.httpMetadata && opts.httpMetadata.contentType }); },
    async get(k) { const v = store.get(k); return v ? { body: v.buf.slice(), httpMetadata: { contentType: v.type } } : null; },
    async delete(k) { store.delete(k); }
  };
  return { DB, PHOTOS, ...(vars || {}) };
}
module.exports = { makeEnv };
