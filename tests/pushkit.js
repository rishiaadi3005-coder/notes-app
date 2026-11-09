// Test helpers: a fake phone's push subscription, and decrypting what the server sent to it (RFC 8291).
const { webcrypto: { subtle } } = require("node:crypto");
const te = new TextEncoder();
const b64u = b => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => new Uint8Array(Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64"));
async function hkdf(salt, ikm, info, n) { const k = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]); return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, n * 8)); }
const cat = (...a) => { const o = new Uint8Array(a.reduce((x, y) => x + y.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

async function fakeSubscription(endpoint) {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey)), auth = crypto.getRandomValues(new Uint8Array(16));
  return { json: { endpoint, keys: { p256dh: b64u(pub), auth: b64u(auth) } }, priv: pair.privateKey, pub, auth, jwkPriv: await subtle.exportKey("jwk", pair.privateKey) };
}
async function decrypt(sub, body) {
  body = new Uint8Array(body);
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const asKey = await subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asKey }, sub.priv, 256));
  const ikm = await hkdf(sub.auth, shared, cat(te.encode("WebPush: info\0"), sub.pub, asPub), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16), nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const k = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, k, ct));
  if (plain[plain.length - 1] !== 2) throw new Error("bad padding");
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}
async function vapidKeys() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { VAPID_PUBLIC: b64u(new Uint8Array(await subtle.exportKey("raw", pair.publicKey))), VAPID_PRIVATE_JWK: JSON.stringify(await subtle.exportKey("jwk", pair.privateKey)), verifyKey: pair.publicKey };
}
async function verifyVapid(header, verifyKey, endpoint) {
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/); if (!m) return false;
  const [h, p, s] = m[1].split(".");
  const claims = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, unb64u(s), te.encode(h + "." + p));
  return ok && claims.aud === new URL(endpoint).origin && claims.exp > Date.now() / 1000;
}
module.exports = { fakeSubscription, decrypt, vapidKeys, verifyVapid, b64u, unb64u };
