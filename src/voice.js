// Turns what someone said into a stage and a list of box ids, for the scanner's mic button.
//
//   "Loaded 12, 15 and 284."          -> { stage: "loaded", ids: ["b012", "b015", "b284"] }
//   "Hacked 012 045 107."             -> { stage: "packed", ... }   (Whisper mishears "packed")
//   "two eighty four, oh one two"     -> b284, b012                  (words, if Whisper writes them)
//   "In room 212233."                 -> unclear: ["212233"] unless only one even split (21 22 33
//                                        or 212 233) gives boxes that exist (Whisper runs numbers
//                                        together when they're said without pauses)
//
// The stage is optional; with none, the app moves each box one step on, like a scan.
// Test labels can be said as "test 3" or "T 3".

export const STAGE_WORDS = ["labelled", "packed", "loaded", "inroom", "unpacked"];

// Phrases checked against the normalised text (lower case, words and digits separated by single
// spaces). The stage mentioned first wins. Whole words only, so "unpacked" isn't "packed" and
// "unloaded" isn't "loaded".
const PHRASES = [
  ["labelled", /\b(not packed|to pack|labell?ed)\b/],
  ["inroom", /\b(in|into|inside) (the )?rooms?\b|\binroom\b|\bunloaded\b|\boff (the )?truck\b|\bdelivered\b/],
  ["loaded", /\bon (the |to the )?(truck|ute|trailer|car)\b|\b(loaded|load|loading)\b/],
  ["unpacked", /\b(unpacked|unpack|unpacking|emptied)\b/],
  ["packed", /\b(packed|pack|packing|pact)\b/],
];
// Single words Whisper hears instead of a stage word: anything one letter away from these.
const FUZZY = [["unpacked", "unpacked"], ["packed", "packed"], ["loaded", "loaded"]];

function near(a, b) { // edit distance <= 1
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export function findStage(text) {
  const t = " " + text + " ";
  let best = null;
  for (const [stage, re] of PHRASES) {
    const m = re.exec(t);
    if (m && (!best || m.index < best.at)) best = { stage, at: m.index };
  }
  if (best) return best.stage;
  // No exact word: look for a near miss ("hacked", "backed", "loader"), first one wins.
  for (const w of text.split(" ")) {
    if (w.length < 5) continue;
    for (const [stage, word] of FUZZY) if (near(w, word)) return stage;
  }
  return null;
}

const UNITS = { zero: 0, oh: 0, o: 0, nought: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const isNumWord = (w) => w in UNITS || w in TEENS || w in TENS || w === "hundred";

// "eighty four" / "fifteen" / "seven" (after "hundred and") at ws[i]
function readTens(ws, i) {
  const w = ws[i];
  if (w in TEENS) return { v: TEENS[w], len: 1 };
  if (w in TENS) return ws[i + 1] in UNITS && UNITS[ws[i + 1]] > 0 ? { v: TENS[w] + UNITS[ws[i + 1]], len: 2 } : { v: TENS[w], len: 1 };
  if (w in UNITS) return { v: UNITS[w], len: 1 };
  return null;
}

// A run of number words said without a break -> digit strings.
export function wordsToNumbers(ws) {
  const out = [];
  let i = 0;
  while (i < ws.length) {
    const w = ws[i];
    if (w in UNITS) {
      if (ws[i + 1] === "hundred") { // "two hundred (and) eighteen"
        let v = UNITS[w] * 100; i += 2;
        if (ws[i] === "and") i++;
        const r = i < ws.length ? readTens(ws, i) : null;
        if (r) { v += r.v; i += r.len; }
        out.push(String(v)); continue;
      }
      if (UNITS[w] > 0 && (ws[i + 1] in TENS || ws[i + 1] in TEENS)) { // "two eighty four", "one fifteen"
        const r = readTens(ws, i + 1);
        out.push(String(UNITS[w] * 100 + r.v)); i += 1 + r.len; continue;
      }
      // A run of single digits. With a nought in it, it's one number spelt out ("two oh four",
      // "oh one two oh four five" in threes); without, each is a box ("seven eight nine").
      const run = [];
      while (i < ws.length && ws[i] in UNITS && ws[i + 1] !== "hundred") run.push(UNITS[ws[i++]]);
      if (run.includes(0)) for (let k = 0; k < run.length; k += 3) out.push(run.slice(k, k + 3).join(""));
      else run.forEach((d) => out.push(String(d)));
      continue;
    }
    if (w in TENS || w in TEENS) { const r = readTens(ws, i); out.push(String(r.v)); i += r.len; continue; }
    i++; // "and", stray "hundred"
  }
  return out;
}

// Ways of cutting a run of digits (Whisper's "212233" for "21, 22, 33") into box numbers that
// all exist. Only even cuts into 2-digit or 3-digit numbers count, since that's how a run of box
// numbers sounds; the caller uses it only when there's exactly one.
function splits(digits, known) {
  const found = [];
  for (const size of [2, 3]) {
    if (digits.length % size) continue;
    const parts = [];
    for (let at = 0; at < digits.length; at += size) parts.push(parseInt(digits.slice(at, at + size), 10));
    if (parts.every((v) => v > 0 && known.has(v))) found.push(parts);
  }
  return found;
}

export const normalise = (text) => String(text || "").toLowerCase()
  .replace(/(\d)\s*[-–—]\s*(?=\d)/g, "$1 , ")    // 204-115 -> 204 , 115
  .replace(/[-–—]/g, " ")                         // twenty-one -> twenty one
  .replace(/([a-z])(?=\d)|(\d)(?=[a-z])/g, "$1$2 ")  // T3 -> t 3
  .replace(/(\d)[.:](?=\d)/g, "$1 , ")           // 12.15 / 12:15 -> 12 , 15
  .replace(/[^a-z0-9,;.!?]+/g, " ")
  .replace(/([,;.!?])/g, " $1 ")
  .replace(/\s+/g, " ").trim();

const pad3 = (n) => String(n).padStart(3, "0");

// knownNumbers: Set of existing box numbers (ints), used only to split run-together digits.
export function parseVoice(text, knownNumbers = new Set()) {
  const norm = normalise(text);
  const stage = findStage(norm.replace(/ [,;.!?]/g, ""));
  const tokens = norm.split(" ").filter(Boolean);
  // Number words become digit strings; punctuation and other words break a run.
  const flat = [];
  for (let i = 0; i < tokens.length;) {
    if (isNumWord(tokens[i])) {
      const run = [];
      while (i < tokens.length && (isNumWord(tokens[i]) || (tokens[i] === "and" && tokens[i - 1] === "hundred"))) run.push(tokens[i++]);
      wordsToNumbers(run).forEach((d) => flat.push(d, ","));
      continue;
    }
    flat.push(tokens[i++]);
  }
  const ids = [], unclear = [], seen = new Set();
  const add = (id) => { if (!seen.has(id)) { seen.add(id); ids.push(id); } };
  for (let i = 0; i < flat.length; i++) {
    const tok = flat[i];
    if (!/^\d+$/.test(tok)) continue;
    const prev = flat[i - 1];
    if ((prev === "t" || prev === "test" || prev === "tee") && tok.length <= 3) { if (+tok > 0) add("t" + pad3(+tok)); continue; }
    if (tok.length <= 3) { if (+tok > 0) add("b" + pad3(+tok)); continue; }
    if (knownNumbers.has(+tok)) { add("b" + pad3(+tok)); continue; } // a real 4-digit box, not two run together
    const ways = splits(tok, knownNumbers);
    if (ways.length === 1) ways[0].forEach((n) => add("b" + pad3(n)));
    else unclear.push(tok);
  }
  return { stage, ids, unclear };
}
