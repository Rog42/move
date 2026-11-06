// node --test test/  (no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVoice, findStage, wordsToNumbers } from "../src/voice.js";

const known = new Set(Array.from({ length: 260 }, (_, i) => i + 1)); // boxes 1-260 exist
const p = (t, k = known) => parseVoice(t, k);
const ids = (...ns) => ns.map((n) => "b" + String(n).padStart(3, "0"));

test("what Whisper actually wrote for test phrases", () => {
  assert.deepEqual(p("Loaded 12, 15, and 284."), { stage: "loaded", ids: ids(12, 15, 284), unclear: [] });
  assert.deepEqual(p("Loaded 012, 15 and 284."), { stage: "loaded", ids: ids(12, 15, 284), unclear: [] });
  assert.deepEqual(p("Hacked 012 045 107."), { stage: "packed", ids: ids(12, 45, 107), unclear: [] });
  assert.deepEqual(p("204-115-99-218"), { stage: null, ids: ids(204, 115, 99, 218), unclear: [] });
  assert.deepEqual(p("204, 115, 99, 218."), { stage: null, ids: ids(204, 115, 99, 218), unclear: [] });
  assert.deepEqual(p("Box 40, Box 41, Box 160."), { stage: null, ids: ids(40, 41, 160), unclear: [] });
  assert.deepEqual(p("Unloaded 07, 8, 9, 10."), { stage: "inroom", ids: ids(7, 8, 9, 10), unclear: [] });
});

test("run-together digits are split only when there's one reading", () => {
  // 212233 could be 21 22 33 or 212 233 (all exist) -> ask again
  assert.deepEqual(p("In room 212233."), { stage: "inroom", ids: [], unclear: ["212233"] });
  // with only boxes up to 60, 21 22 33 is the only reading
  const small = new Set(Array.from({ length: 60 }, (_, i) => i + 1));
  assert.deepEqual(p("In room 212233.", small).ids, ids(21, 22, 33));
  // nothing fits
  assert.deepEqual(p("loaded 999999", small), { stage: "loaded", ids: [], unclear: ["999999"] });
  // "twelve fifteen" run together: 1215 can only be 12 15
  assert.deepEqual(p("packed 1215").ids, ids(12, 15));
  // mixed lengths aren't guessed
  assert.deepEqual(p("packed 12115").unclear, ["12115"]);
  // times and decimals are two numbers
  assert.deepEqual(p("packed 12.15").ids, ids(12, 15));
  assert.deepEqual(p("packed 12:15").ids, ids(12, 15));
});

test("numbers in words", () => {
  assert.deepEqual(wordsToNumbers("two eighty four".split(" ")), ["284"]);
  assert.deepEqual(wordsToNumbers("one fifteen".split(" ")), ["115"]);
  assert.deepEqual(wordsToNumbers("two oh four".split(" ")), ["204"]);
  assert.deepEqual(wordsToNumbers("oh one two oh four five".split(" ")), ["012", "045"]);
  assert.deepEqual(wordsToNumbers("two hundred and eighteen".split(" ")), ["218"]);
  assert.deepEqual(wordsToNumbers("one hundred and seven".split(" ")), ["107"]);
  assert.deepEqual(wordsToNumbers("twenty one twenty two thirty three".split(" ")), ["21", "22", "33"]);
  assert.deepEqual(wordsToNumbers("seven eight nine ten".split(" ")), ["7", "8", "9", "10"]);
  assert.deepEqual(p("loaded twelve, fifteen and two eighty four").ids, ids(12, 15, 284));
  assert.deepEqual(p("Packed oh one two, oh four five, one hundred and seven").ids, ids(12, 45, 107));
  assert.deepEqual(p("twenty-one and forty-two").ids, ids(21, 42));
});

test("stage words", () => {
  assert.equal(findStage("packed 12"), "packed");
  assert.equal(findStage("pack 12"), "packed");
  assert.equal(findStage("unpacked 12"), "unpacked");
  assert.equal(findStage("loaded 12"), "loaded");
  assert.equal(findStage("these are on the truck 12"), "loaded");
  assert.equal(findStage("unloaded 12"), "inroom");
  assert.equal(findStage("in the room 12"), "inroom");
  assert.equal(findStage("in room 12"), "inroom");
  assert.equal(findStage("off the truck 12"), "inroom");
  assert.equal(findStage("not packed 12"), "labelled");
  assert.equal(findStage("backed 12"), "packed");
  assert.equal(findStage("loader 12"), "loaded");
  assert.equal(findStage("12 15"), null);
  // the first one said wins
  assert.equal(findStage("loaded 12 actually packed"), "loaded");
});

test("test labels, duplicates, noise", () => {
  assert.deepEqual(p("packed test 3 and T 4").ids, ["t003", "t004"]);
  assert.deepEqual(p("packed T3").ids, ["t003"]);
  assert.deepEqual(p("loaded 12, 12, 15").ids, ids(12, 15));
  assert.deepEqual(p("um loaded 0, 12"), { stage: "loaded", ids: ids(12), unclear: [] });
  assert.deepEqual(p(""), { stage: null, ids: [], unclear: [] });
  assert.deepEqual(p("Thank you."), { stage: null, ids: [], unclear: [] });
});
