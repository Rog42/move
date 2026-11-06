// Worker entry: /api/* goes to the API; everything else is a static file from public/.
// /lists serves lists.html, and any other page path (such as /b/014 from a label's QR code)
// falls back to index.html via not_found_handling in wrangler.toml.
//
// Every request comes through here first (run_worker_first = true), so a plain-http visit is sent
// to https before anything is served: phones only allow the camera on a secure page. https
// responses carry HSTS, so a browser that has been here once keeps using https by itself.
import { handleApi } from "./api.js";

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/; // wrangler dev stays on http
const HSTS = "max-age=31536000";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol === "http:" && !LOCAL.test(url.hostname)) {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    const res = await route(request, env, url);
    if (url.protocol !== "https:") return res;
    const out = new Response(res.body, res);
    out.headers.set("Strict-Transport-Security", HSTS);
    return out;
  },
};

async function route(request, env, url) {
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    let parts;
    try {
      parts = url.pathname.slice(4).split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return new Response(JSON.stringify({ error: "Bad path." }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return handleApi(request, env, parts);
  }
  return env.ASSETS.fetch(request);
}
