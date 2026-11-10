// The deployed entry point: the app's own files, bundled in, then the server (src/index.js) for /v1.
// (Bundling instead of a separate asset upload keeps deploys to one step.)
import server from "./index.js";
import INDEX from "../../index.html";
import SW from "../../sw.js";
import QR from "../../qrcode.js";
import MANIFEST from "../../manifest.webmanifest";
import ICON192 from "../../icon-192.png";
import ICON512 from "../../icon-512.png";
import APPLE from "../../apple-touch-icon.png";

const FILES = {
  "/": [INDEX, "text/html; charset=utf-8", "no-cache"],
  "/index.html": [INDEX, "text/html; charset=utf-8", "no-cache"],
  "/sw.js": [SW, "text/javascript; charset=utf-8", "no-cache"],
  "/qrcode.js": [QR, "text/javascript; charset=utf-8", "public, max-age=86400"],
  "/manifest.webmanifest": [MANIFEST, "application/manifest+json", "public, max-age=3600"],
  "/icon-192.png": [ICON192, "image/png", "public, max-age=86400"],
  "/icon-512.png": [ICON512, "image/png", "public, max-age=86400"],
  "/apple-touch-icon.png": [APPLE, "image/png", "public, max-age=86400"]
};
const SECURITY = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "permissions-policy": "geolocation=(), camera=(), microphone=(self)" };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/v1")) {
      const f = FILES[url.pathname];
      if (!f || (req.method !== "GET" && req.method !== "HEAD")) return new Response("Not found", { status: 404 });
      return new Response(req.method === "HEAD" ? null : f[0], { headers: { "content-type": f[1], "cache-control": f[2], ...SECURITY } });
    }
    return server.fetch(req, env, ctx);
  },
  scheduled: server.scheduled
};
