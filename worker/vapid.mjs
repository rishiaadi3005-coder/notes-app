// Makes the VAPID key pair push notifications need. Run once: node vapid.mjs
// The public key goes in wrangler.toml (VAPID_PUBLIC); the private key is stored as a Cloudflare secret.
import { webcrypto as c } from "node:crypto";
const pair = await c.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const raw = new Uint8Array(await c.subtle.exportKey("raw", pair.publicKey));
const jwk = await c.subtle.exportKey("jwk", pair.privateKey);
const b64u = b => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
console.log("VAPID_PUBLIC (put in wrangler.toml):\n" + b64u(raw) + "\n");
console.log("VAPID_PRIVATE_JWK (paste when `npx wrangler secret put VAPID_PRIVATE_JWK` asks):\n" + JSON.stringify(jwk));
