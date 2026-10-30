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
//                                     Before loading opens (LOAD_FROM), a packed box stays packed: result "held"
//   PUT    /api/settings/print        shared label settings {size?, copies?, top?, bottom?}, used by every phone
//   POST   /api/boxes/:id/photos      add a photo of what's in a box (raw JPEG, PNG or WebP body)
//   GET    /api/photos/:pid           the photo itself
//   DELETE /api/photos/:pid           remove a photo
//
// Checklists. Closed until Cloudflare Access is set up (ACCESS_TEAM_DOMAIN) or LISTS_OPEN=1; see lib/access.js:
//   GET    /api/lists/state           items + meta
//   POST   /api/lists/doc/:col        add a document, returns {id}
//   PUT    /api/lists/doc/:col/:id    replace a document
//   PATCH  /api/lists/doc/:col/:id    merge into a document (nested objects merge)
//   DELETE /api/lists/doc/:col/:id    delete a document

import { listsAccess } from "./access.js";

const STEPS = ["labelled", "packed", "loaded", "inroom", "unpacked"];
const PACKED = STEPS.indexOf("packed");
const SCAN_GUARD_MS = 15000;
// Nothing is loaded before the truck: Fri 6 Nov 2026, 5pm Sydney time. LOAD_FROM in wrangler.toml can move it.
const LOAD_FROM_DEFAULT = "2026-11-06T17:00:00+11:00";
const PHOTO_MAX_BYTES = 1500000; // D1 holds up to 2 MB in one value; the app sends about 200-400 KB
const PHOTO_MAX_PER_BOX = 20;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PHOTO_ID_RE = /^p[0-9a-f]{32}$/;
// Label settings shared by every phone, so the same printer gets the same layout whoever prints.
const LABEL_SIZES = new Set(["100x150", "a4", "48x30", "50x30", "40x30", "50x20"]);
// Every device gets a complete set, so nothing falls back to one phone's own old value.
const PRINT_DEFAULTS = { size: "a4", copies: 2, top: 0, bottom: 10 };
function cleanPrintSettings(body) {
  const out = {};
  if (typeof body.size === "string" && LABEL_SIZES.has(body.size)) out.size = body.size;
  const c = Number(body.copies);
  if (Number.isInteger(c) && c >= 1 && c <= 6) out.copies = c;
  for (const k of ["top", "bottom"]) {
    const v = Number(body[k]);
    if (body[k] !== undefined && body[k] !== null && Number.isFinite(v)) out[k] = Math.max(-20, Math.min(20, Math.round(v * 2) / 2));
  }
  return out;
}
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
function loadFrom(env) {
  const t = Date.parse((env && env.LOAD_FROM) || "");
  return Number.isFinite(t) ? t : Date.parse(LOAD_FROM_DEFAULT);
}
function loadingText(at) {
  const d = new Date(at);
  const day = d.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", weekday: "short", day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney", hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(/\s/g, "");
  return `${day} at ${time}`;
}
// Photos live in their own table, made the first time it's needed.
let photosReady = false;
async function ensurePhotos(DB) {
  if (photosReady) return;
  await DB.batch([
    DB.prepare("CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, box TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL)"),
    DB.prepare("CREATE INDEX IF NOT EXISTS photos_box ON photos (box)"),
  ]);
  photosReady = true;
}
// Writes to a box check it hasn't changed since it was read (compare and swap). When two land
// together, the loser waits a moment, re-reads and tries again.
const RETRIES = 8;
const backoff = (attempt) => new Promise((r) => setTimeout(r, attempt * (15 + Math.random() * 35)));
// Change a box's list of photos without losing a scan or edit made at the same moment.
async function updatePhotoList(DB, id, change) {
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (attempt) await backoff(attempt);
    const cur = await getDoc(DB, "boxes", id);
    if (!cur) return null;
    const list = Array.isArray(cur.data.photos) ? cur.data.photos.filter((p) => typeof p === "string") : [];
    const next = { ...cur.data, photos: change(list) };
    const res = await DB.prepare("UPDATE docs SET data = ?, updated_at = ? WHERE col = 'boxes' AND id = ? AND updated_at = ?")
      .bind(JSON.stringify(next), Math.max(Date.now(), cur.at + 1), id, cur.at).run();
    if (res.meta && res.meta.changes === 1) return next;
  }
  throw new Error("The box kept changing while the photo was saved. Try again.");
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
      const [rooms, boxes, print] = await Promise.all([collection(DB, "rooms"), collection(DB, "boxes"), getDoc(DB, "settings", "print")]);
      return json({ rooms, boxes, settings: { print: { ...PRINT_DEFAULTS, ...(print ? print.data : {}) } }, now: Date.now(), loadFrom: loadFrom(env) });
    }

    if (parts[0] === "settings" && parts[1] === "print" && parts.length === 2 && method === "PUT") {
      const body = await readBody(request);
      if (!body) return fail(400, "Send JSON.");
      const f = cleanPrintSettings(body);
      if (!Object.keys(f).length) return fail(400, "Nothing to change.");
      // Merge the change in one statement (json_patch), so two changes landing together both stick.
      f.updatedAt = new Date().toISOString();
      const row = await DB.prepare(
        "INSERT INTO docs (col, id, data, updated_at) VALUES ('settings', 'print', ?1, ?2) ON CONFLICT (col, id) DO UPDATE SET data = json_patch(docs.data, excluded.data), updated_at = excluded.updated_at RETURNING data"
      ).bind(JSON.stringify(f), Date.now()).first();
      return json({ print: { ...PRINT_DEFAULTS, ...JSON.parse(row.data) } });
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
      await ensurePhotos(DB);
      await DB.prepare("DELETE FROM photos WHERE box LIKE 't%'").run();
      await DB.prepare("INSERT INTO counters (k, v) VALUES ('test', 0) ON CONFLICT (k) DO UPDATE SET v = 0").run();
      return json({ deleted: (res.meta && res.meta.changes) || 0 });
    }

    // A photo of what's in a box. The body is the image itself, already shrunk by the app.
    if (parts[0] === "boxes" && parts[2] === "photos" && parts.length === 3 && method === "POST") {
      const id = parts[1];
      if (!ID_RE.test(id)) return fail(400, "Bad box id.");
      const mime = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!PHOTO_TYPES.has(mime)) return fail(415, "Send the photo as a JPEG, PNG or WebP image.");
      if (Number(request.headers.get("content-length") || 0) > PHOTO_MAX_BYTES) return fail(413, "That photo is too big to save.");
      const cur = await getDoc(DB, "boxes", id);
      if (!cur) return fail(404, "No such box.");
      if (Array.isArray(cur.data.photos) && cur.data.photos.length >= PHOTO_MAX_PER_BOX) return fail(400, `That box already has ${PHOTO_MAX_PER_BOX} photos. Remove one first.`);
      const buf = await request.arrayBuffer();
      if (!buf.byteLength) return fail(400, "The photo was empty.");
      if (buf.byteLength > PHOTO_MAX_BYTES) return fail(413, "That photo is too big to save.");
      await ensurePhotos(DB);
      const pid = "p" + crypto.randomUUID().replace(/-/g, "");
      await DB.prepare("INSERT INTO photos (id, box, mime, data, created_at) VALUES (?, ?, ?, ?, ?)").bind(pid, id, mime, buf, Date.now()).run();
      let box = null;
      try { box = await updatePhotoList(DB, id, (list) => list.concat(pid)); }
      catch (e) { await DB.prepare("DELETE FROM photos WHERE id = ?").bind(pid).run(); return fail(409, e.message); }
      if (!box) { await DB.prepare("DELETE FROM photos WHERE id = ?").bind(pid).run(); return fail(404, "No such box."); }
      return json({ id, pid, box }, 201);
    }

    if (parts[0] === "photos" && parts.length === 2) {
      const pid = parts[1];
      if (!PHOTO_ID_RE.test(pid)) return fail(400, "Bad photo id.");
      await ensurePhotos(DB);
      if (method === "GET") {
        const row = await DB.prepare("SELECT mime, data FROM photos WHERE id = ?").bind(pid).first();
        if (!row) return fail(404, "No such photo.");
        return new Response(new Uint8Array(row.data), {
          headers: { "content-type": row.mime, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
        });
      }
      if (method === "DELETE") {
        const row = await DB.prepare("SELECT box FROM photos WHERE id = ?").bind(pid).first();
        if (!row) return fail(404, "No such photo.");
        await DB.prepare("DELETE FROM photos WHERE id = ?").bind(pid).run();
        const box = await updatePhotoList(DB, row.box, (list) => list.filter((p) => p !== pid));
        return json({ id: row.box, pid, deleted: true, box });
      }
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
        // Write only if the box hasn't changed since it was read, so a photo or scan that
        // lands at the same moment isn't overwritten. Re-read and retry if it has.
        for (let attempt = 0, doc = cur; attempt < RETRIES; attempt++) {
          if (attempt) { await backoff(attempt); doc = await getDoc(DB, "boxes", id); }
          if (!doc) return fail(404, "No such box.");
          // Until loading opens, a box can't be moved forward past Packed (moving back is fine).
          const at = loadFrom(env);
          if (f.status && Date.now() < at && STEPS.indexOf(f.status) > PACKED && STEPS.indexOf(f.status) > STEPS.indexOf(statusOf(doc.data))) {
            return json({ error: `Loading opens ${loadingText(at)}. Until then boxes can only go as far as Packed.`, locked: true, loadFrom: at }, 409);
          }
          const next = { ...doc.data, ...f };
          if (f.status) next.statusAt = new Date().toISOString();
          if (body.resetScan === true) next.scannedAt = null;
          const res = await DB.prepare("UPDATE docs SET data = ?, updated_at = ? WHERE col = 'boxes' AND id = ? AND updated_at = ?")
            .bind(JSON.stringify(next), Math.max(Date.now(), doc.at + 1), id, doc.at).run();
          if (res.meta && res.meta.changes === 1) return json({ id, box: next });
        }
        return fail(409, "Someone else changed that box at the same moment. Try again.");
      }
      if (method === "DELETE") {
        await DB.prepare("DELETE FROM docs WHERE col = 'boxes' AND id = ?").bind(id).run();
        await ensurePhotos(DB);
        await DB.prepare("DELETE FROM photos WHERE box = ?").bind(id).run();
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
        const at = loadFrom(env);
        if (i + 1 > PACKED && now < at) return json({ id, box: b, from, to: from, result: "held", loadFrom: at, opens: loadingText(at) });
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
