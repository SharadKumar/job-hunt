import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../tools/ui/static/labels.js", import.meta.url), "utf8");
const { clockTime, scheduleClock, when, whenFull, dayStamp } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
assert.equal(scheduleClock("20:10"), "8:10 pm");
assert.equal(scheduleClock("07:00"), "7:00 am");
assert.equal(scheduleClock("25:00"), "");
const evening = new Date(2026, 8, 22, 20, 10);
assert.equal(clockTime(evening), "8:10 pm");
assert.equal(clockTime(new Date(2026, 8, 22, 0, 0)), "12:00 am");
assert.equal(clockTime(new Date(2026, 8, 22, 12, 0)), "12:00 pm");
assert.equal(clockTime(new Date(2026, 8, 22, 7, 5)), "7:05 am");
assert.equal(clockTime(null), "");
assert.equal(clockTime("invalid"), "");
assert.equal(when(evening, evening), "8:10 pm");
assert.match(whenFull(evening), /8:10 pm$/);
assert.match(dayStamp(evening, true), /8:10 pm$/);
console.log("Human-readable UI clock tests passed");
