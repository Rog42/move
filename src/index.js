// Worker entry: /api/* goes to the API; everything else is a static file from public/.
// /lists serves lists.html, and any other page path (such as /b/014 from a label's QR code)
// falls back to index.html via not_found_handling in wrangler.toml.
import { handleApi } from "./api.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
  },
};
