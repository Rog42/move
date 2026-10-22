// Checks that a request came through Cloudflare Access before the checklists are served.
//
// The checklists hold account and policy numbers, so /api/lists/* stays closed until one of:
//   - ACCESS_TEAM_DOMAIN is set (e.g. "rog42" or "rog42.cloudflareaccess.com") and the request
//     carries a valid Access token for that team (optionally pinned to ACCESS_AUD), or
//   - LISTS_OPEN = "1" is set, which opens them to anyone with the link.
// Requests to localhost are always allowed so `wrangler pages dev` works.

let certCache = { team: "", at: 0, keys: [] };
const CERT_TTL_MS = 60 * 60 * 1000;

function b64urlBytes(s) {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

export function teamHost(v) {
  const t = String(v || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (!t) return "";
  return t.includes(".") ? t : t + ".cloudflareaccess.com";
}

function tokenFrom(request) {
  const h = request.headers.get("cf-access-jwt-assertion");
  if (h) return h;
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : "";
}

async function keysFor(team, fetchImpl) {
  const now = Date.now();
  if (certCache.team === team && now - certCache.at < CERT_TTL_MS && certCache.keys.length) return certCache.keys;
  const r = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error("certs " + r.status);
  const body = await r.json();
  certCache = { team, at: now, keys: Array.isArray(body.keys) ? body.keys : [] };
  return certCache.keys;
}

export async function verifyAccessToken(token, { team, aud, fetchImpl = fetch, now = Date.now() }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); } catch { return null; }
  if (header.alg !== "RS256") return null;
  if (payload.iss !== `https://${team}`) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < now) return null;
  if (typeof payload.nbf === "number" && payload.nbf * 1000 > now + 60000) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (aud && !auds.includes(aud)) return null;
  let keys = await keysFor(team, fetchImpl);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { certCache.at = 0; keys = await keysFor(team, fetchImpl); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  return ok ? payload : null;
}

// Returns { ok: true, who } or { ok: false, why }.
export async function listsAccess(request, env) {
  const host = new URL(request.url).hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return { ok: true, who: "local" };
  if (env.LISTS_OPEN === "1") return { ok: true, who: null };
  const team = teamHost(env.ACCESS_TEAM_DOMAIN);
  if (!team) return { ok: false, why: "locked" };
  const token = tokenFrom(request);
  if (!token) return { ok: false, why: "signin" };
  try {
    const p = await verifyAccessToken(token, { team, aud: env.ACCESS_AUD || "" });
    return p ? { ok: true, who: p.email || null } : { ok: false, why: "signin" };
  } catch {
    return { ok: false, why: "error" };
  }
}
