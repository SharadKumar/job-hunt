import assert from "node:assert/strict";
import { launchWithChromeFallback } from "../tools/channels/_browser.ts";

let fallbackCalls = 0;
const fallback = async () => { fallbackCalls++; return "bundled"; };
assert.equal(await launchWithChromeFallback(async () => "chrome", fallback), "chrome");
assert.equal(fallbackCalls, 0);
for (const message of [
  "Failed to create a ProcessSingleton for your profile directory",
  "Target page, context or browser has been closed",
  "Timeout 30000ms exceeded",
  "Permission denied",
]) {
  const error = new Error(message);
  await assert.rejects(launchWithChromeFallback(async () => { throw error; }, fallback), (actual) => actual === error);
  assert.equal(fallbackCalls, 0, "a lock or runtime failure must not launch another browser against the same profile");
}
for (const message of [
  "Chromium distribution 'chrome' is not found at /missing/chrome",
  "Executable doesn't exist at /missing/chrome",
]) {
  assert.equal(await launchWithChromeFallback(async () => { throw new Error(message); }, fallback), "bundled");
}
assert.equal(fallbackCalls, 2);
console.log("Browser launcher fallback tests passed");
