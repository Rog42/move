// Move app API over a D1 database bound as DB. Called from src/index.js for every /api/* request.
//
// Public (box scanning):
//   GET    /api/state                 rooms + boxes
//   POST   /api/boxes                 create the next numbered box {cat, dest, test?}
//   POST   /api/boxes/batch           create many {items: [{cat, dest}], test?}, consecutive numbers
//   POST   /api/boxes/printed         mark labels printed {ids, printed?} (unprinted = To print list)
//   PATCH  /api/boxes/:id             change cat / dest / status
//   DELETE /api/boxes/:id             remove a box (its number is never reused)
//   DELETE /api/boxes?test=1          remove every test label (T001...) and restart test numbering
//   POST   /api/scan/:id              move a box one step: labelled > packed > loaded > inroom > unpacked
//
// Checklists. Closed until Cloudflare Access is set up (ACCESS_TEAM_DOMAIN) or LISTS_OPEN=1; see lib/access.js:
//   GET    /api/lists/state           items + meta
//   POST   /api/lists/doc/:col        add a document, returns {id}
//   PUT    /api/lists/doc/:col/:id    replace a document
//   PATCH  /api/lists/doc/:col/:id    merge into a document (nested objects merge)
//   DELETE /api/lists/doc/:col/:id    delete a document

import { listsAccess } from "./access.js";

const STEPS = ["labelled", "packed", "loaded", "inroom", "unpacked"];
const SCAN_GUARD_MS = 15000;
const LIST_COLS = new Set(["items", "meta"]);
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,120}$/;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (status, error) => json({ error }, status);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function merge(base, patch) {
  const out = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch || {})) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  return out;
}
const pad3 = (n) => String(n).padStart(3, "0");

async function readBody(request) {
  try {
    const b = await request.json();
    return isObj(b) ? b : null;
  } catch {
    return null;
  }
}
async function getDoc(DB, col, id) {
  const row = await DB.prepare("SELECT data, updated_at FROM docs WHERE col = ? AND id = ?").bind(col, id).first();
  return row ? { data: JSON.parse(row.data), at: row.updated_at } : null;
}
async function putDoc(DB, col, id, data) {
  await DB.prepare(
    "INSERT INTO docs (col, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
  ).bind(col, id, JSON.stringify(data), Date.now()).run();
}
async function collection(DB, col) {
  const { results } = await DB.prepare("SELECT id, data FROM docs WHERE col = ?").bind(col).all();
  const out = {};
  for (const r of results) out[r.id] = JSON.parse(r.data);
  return out;
}
function statusOf(b) {
  return STEPS.includes(b.status) ? b.status : b.arrived === true ? "inroom" : "labelled";
}
function cleanBoxFields(body) {
  const out = {};
  if (typeof body.cat === "string") out.cat = body.cat.trim().slice(0, 40);
  if (body.dest === null || (typeof body.dest === "string" && ID_RE.test(body.dest))) out.dest = body.dest;
  if (typeof body.status === "string" && STEPS.includes(body.status)) out.status = body.status;
  return out;
}

export async function handleApi(request, env, parts) {
  const DB = env.DB;
  if (!DB) return fail(500, "The DB binding is missing. Check the d1_databases entry in wrangler.toml.");
  const method = request.method;

  try {
    // ---------- Boxes (public) ----------
    if (parts[0] === "state" && parts.length === 1 && method === "GET") {
      const [rooms, boxes] = await Promise.all([collection(DB, "rooms"), collection(DB, "boxes")]);
      return json({ rooms, boxes, now: Date.now() });
    }

    if (parts[0] === "boxes" && parts.length === 1 && method === "POST") {
      const body = await readBody(request);
      if (!body) return fail(400, "Send JSON with cat and dest.");
      const f = cleanBoxFields(body);
      // Test labels (T001, T002...) have their own counter so they never use up real box numbers.
      const test = body.test === true;
      if (test) await DB.prepare("INSERT OR IGNORE INTO counters (k, v) VALUES ('test', 0)").run();
      const row = await DB.prepare("UPDATE counters SET v = v + 1 WHERE k = ? RETURNING v").bind(test ? "test" : "box").first();
      if (!row) return fail(500, "The box counter is missing. Run schema.sql.");
      const n = row.v, id = (test ? "t" : "b") + pad3(n);
      const box = { n, cat: f.cat || "", dest: f.dest ?? null, status: "labelled", createdAt: new Date().toISOString() };
      if (test) box.test = true;
      await putDoc(DB, "boxes", id, box);
      return json({ id, box }, 201);
    }

    // Create many at once: {items: [{cat, dest}], test}. Numbers are taken in one atomic step,
    // so the batch is consecutive even if someone else is creating labels at the same time.
    if (parts[0] === "boxes" && parts[1] === "batch" && parts.length === 2 && method === "POST") {
      const body = await readBody(request);
      const items = body && Array.isArray(body.items) ? body.items : null;
      if (!items || !items.length) return fail(400, "Send a list of labels to create.");
      if (items.length > 100) return fail(400, "That's more than 100 labels in one go. Split it up.");
      const clean = items.map((it) => { const f = isObj(it) ? cleanBoxFields(it) : {}; return { cat: f.cat || "", dest: f.dest ?? null }; });
      const test = body.test === true, key = test ? "test" : "box";
      if (test) await DB.prepare("INSERT OR IGNORE INTO counters (k, v) VALUES ('test', 0)").run();
      const row = await DB.prepare("UPDATE counters SET v = v + ? WHERE k = ? RETURNING v").bind(clean.length, key).first();
      if (!row) return fail(500, "The box counter is missing. Run schema.sql.");
      const first = row.v - clean.length + 1, now = Date.now(), at = new Date(now).toISOString(), out = {};
      const stmts = clean.map((c, i) => {
        const n = first + i, id = (test ? "t" : "b") + pad3(n);
        const box = { n, cat: c.cat, dest: c.dest, status: "labelled", createdAt: at };
        if (test) box.test = true;
        out[id] = box;
        return DB.prepare("INSERT OR REPLACE INTO docs (col, id, data, updated_at) VALUES ('boxes', ?, ?, ?)").bind(id, JSON.stringify(box), now);
      });
      await DB.batch(stmts);
      return json({ boxes: out }, 201);
    }

    // Take labels off (or put them back on) the To print list: {ids: [...], printed: true|false}.
    if (parts[0] === "boxes" && parts[1] === "printed" && parts.length === 2 && method === "POST") {
      const body = await readBody(request);
      const ids = body && Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string" && ID_RE.test(x)).slice(0, 300) : [];
      const at = body && body.printed === false ? null : new Date().toISOString(), now = Date.now();
      if (ids.length) {
        await DB.batch(ids.map((id) => DB.prepare("UPDATE docs SET data = json_set(data, '$.printedAt', json(?)), updated_at = ? WHERE col = 'boxes' AND id = ?").bind(JSON.stringify(at), now, id)));
      }
      return json({ ids, printedAt: at });
    }

    // Bulk delete is only for test labels; it also restarts test numbering at T001.
    if (parts[0] === "boxes" && parts.length === 1 && method === "DELETE") {
      if (new URL(request.url).searchParams.get("test") !== "1") return fail(400, "Only test labels can be deleted in bulk.");
      const res = await DB.prepare("DELETE FROM docs WHERE col = 'boxes' AND id LIKE 't%'").run();
      await DB.prepare("INSERT INTO counters (k, v) VALUES ('test', 0) ON CONFLICT (k) DO UPDATE SET v = 0").run();
      return json({ deleted: (res.meta && res.meta.changes) || 0 });
    }

    if (parts[0] === "boxes" && parts.length === 2) {
      const id = parts[1];
      if (!ID_RE.test(id)) return fail(400, "Bad box id.");
      const cur = await getDoc(DB, "boxes", id);
      if (!cur) return fail(404, "No such box.");
      if (method === "PATCH") {
        const body = await readBody(request);
        if (!body) return fail(400, "Send JSON.");
        const f = cleanBoxFields(body);
        const next = { ...cur.data, ...f };
        if (f.status) next.statusAt = new Date().toISOString();
        if (body.resetScan === true) next.scannedAt = null;
        await putDoc(DB, "boxes", id, next);
        return json({ id, box: next });
      }
      if (method === "DELETE") {
        await DB.prepare("DELETE FROM docs WHERE col = 'boxes' AND id = ?").bind(id).run();
        return json({ id, deleted: true });
      }
    }

    if (parts[0] === "scan" && parts.length === 2 && method === "POST") {
      const id = parts[1];
      if (!ID_RE.test(id)) return fail(400, "Bad box id.");
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await getDoc(DB, "boxes", id);
        if (!cur) return fail(404, "No such box.");
        const b = cur.data, from = statusOf(b), now = Date.now();
        const last = b.scannedAt ? Date.parse(b.scannedAt) : 0;
        if (now - last < SCAN_GUARD_MS) return json({ id, box: b, from, to: from, result: "recent" });
        const i = STEPS.indexOf(from);
        if (i >= STEPS.length - 1) return json({ id, box: b, from, to: from, result: "done" });
        const to = STEPS[i + 1];
        const next = { ...b, status: to, statusAt: new Date(now).toISOString(), scannedAt: new Date(now).toISOString() };
        const res = await DB.prepare("UPDATE docs SET data = ?, updated_at = ? WHERE col = 'boxes' AND id = ? AND updated_at = ?")
          .bind(JSON.stringify(next), now, id, cur.at).run();
        if (res.meta && res.meta.changes === 1) return json({ id, box: next, from, to, result: "moved" });
      }
      return fail(409, "Someone else scanned that box at the same moment. Try again.");
    }

    // ---------- Checklists ----------
    if (parts[0] === "lists") {
      const gate = await listsAccess(request, env);
      if (!gate.ok) {
        const msg = {
          locked: "The checklists are locked. Set up Cloudflare Access for /lists, then set ACCESS_TEAM_DOMAIN on the Pages project.",
          signin: "Sign in through Cloudflare Access to see the checklists.",
          error: "Couldn't check your Cloudflare Access sign-in. Try again in a minute.",
        }[gate.why];
        return json({ error: msg, locked: gate.why }, gate.why === "error" ? 503 : 403);
      }
      const rest = parts.slice(1);
      if (rest[0] === "state" && rest.length === 1 && method === "GET") {
        const [items, meta] = await Promise.all([collection(DB, "items"), collection(DB, "meta")]);
        return json({ items, meta, now: Date.now() });
      }
      if (rest[0] === "doc" && LIST_COLS.has(rest[1])) {
        const col = rest[1];
        if (rest.length === 2 && method === "POST") {
          const body = await readBody(request);
          if (!body) return fail(400, "Send JSON.");
          const id = "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
          await putDoc(DB, col, id, body);
          return json({ id }, 201);
        }
        if (rest.length === 3 && ID_RE.test(rest[2])) {
          const id = rest[2];
          if (method === "PUT") {
            const body = await readBody(request);
            if (!body) return fail(400, "Send JSON.");
            await putDoc(DB, col, id, body);
            return json({ id });
          }
          if (method === "PATCH") {
            const body = await readBody(request);
            if (!body) return fail(400, "Send JSON.");
            const cur = await getDoc(DB, col, id);
            if (!cur) return fail(404, "No such document.");
            await putDoc(DB, col, id, merge(cur.data, body));
            return json({ id });
          }
          if (method === "DELETE") {
            await DB.prepare("DELETE FROM docs WHERE col = ? AND id = ?").bind(col, id).run();
            return json({ id, deleted: true });
          }
        }
      }
    }

    return fail(404, "Not found.");
  } catch (e) {
    return fail(500, "Server error: " + (e && e.message ? e.message : String(e)));
  }
}
