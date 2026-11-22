#!/usr/bin/env tsx
/**
 * notify-escalations.test.ts — when the Slack digest sends and what it says.
 *
 * Pure tests of compose() and shortReason(): the first message of a day lists
 * everything, later runs send only new escalations, a failed run always sends,
 * a new day starts over, and journal-style reasons shrink to phone-sized text.
 */

import assert from "node:assert/strict";
import { compose, shortReason, clip, escalationKey } from "../tools/notify-escalations.ts";
import type { Escalation } from "../tools/daily-summary.ts";

const UI = "https://mac.example.ts.net";
const base = { date: "2026-11-23", uiUrl: UI, timeLabel: "23 Nov, 9:00 am", exitCode: 0 };

const screening: Escalation = { kind: "screening", id: "seek-1", title: "Senior AI Architect", company: "Softlabs", reason: 'Unanswered screening question: "How many years?"', action: "x" };
const ats: Escalation = { kind: "manual", id: "seek-2", title: "PM", company: "A & B", reason: "External ATS redirect to jobs.example.com", action: "x" };
const tray: Escalation = { kind: "awaiting_approval", id: "li-3", title: "Program Director", company: "AJQ", reason: "Package waiting in the Tray", action: "x" };
const kill: Escalation = { kind: "kill_switch", reason: "Kill switch is ON; no submissions, attended or autopilot", action: "x" };

// First run of the day: everything, grouped, blockers first, links and escaping.
{
  const m = compose({ ...base, escalations: [ats, screening, tray, kill], ledger: null })!;
  assert.ok(m.text.startsWith("*Job hunt, 23 Nov, 9:00 am: 4 items need you*"));
  const order = ["Blocking the harness", "Answer a screening question", "Approve, hold or reject", "Apply yourself"].map((h) => m.text.indexOf(`*${h}*`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "groups in fixed order");
  assert.ok(m.text.includes(`<${UI}/#/row/seek-2|PM at A &amp; B>: apply on jobs.example.com`));
  assert.ok(m.text.includes(`<${UI}/#/today|`));
  assert.equal(m.keys.length, 4);
  assert.ok(!/[—–]/.test(m.text), "no dashes");
}

// A yesterday ledger does not suppress today's first message.
{
  const m = compose({ ...base, escalations: [screening], ledger: { date: "2026-11-22", keys: [escalationKey(screening)] } });
  assert.ok(m && m.newKeys.length === 1);
}

// Later run, nothing new: silent.
{
  const ledger = { date: base.date, keys: [screening, tray].map(escalationKey) };
  assert.equal(compose({ ...base, escalations: [screening, tray], ledger }), null);
}

// Later run, one new: only the new one is listed, the rest counted.
{
  const ledger = { date: base.date, keys: [screening, tray].map(escalationKey) };
  const m = compose({ ...base, escalations: [screening, tray, ats], ledger })!;
  assert.ok(m.text.includes("1 new item need you"));
  assert.ok(m.text.includes("apply on jobs.example.com"));
  assert.ok(!m.text.includes("How many years"));
  assert.ok(m.text.includes("Plus 2 still waiting from earlier today."));
  assert.deepEqual(m.newKeys, [escalationKey(ats)]);
}

// A failed run always sends, even with nothing new.
{
  const ledger = { date: base.date, keys: [escalationKey(screening)] };
  const m = compose({ ...base, exitCode: 124, escalations: [screening], ledger })!;
  assert.ok(m.text.includes("run failed"));
  assert.ok(m.text.includes("exit 124"));
}

// --force resends the full list.
{
  const ledger = { date: base.date, keys: [escalationKey(screening)] };
  const m = compose({ ...base, escalations: [screening], ledger, force: true })!;
  assert.ok(m.text.includes("1 item need you"));
}

// Short reasons.
{
  const row = (reason: string): Escalation => ({ kind: "manual", id: "r", title: "T", company: "C", reason, action: "x" });
  assert.equal(shortReason(row("[daily 2026-11-18] External Vocus portal, attended only. Package in archive has approved CV.")), "External Vocus portal, attended only");
  assert.equal(shortReason(row("[autopilot priority-2026-11-18] channel 'linkedin_jobs' is not on autopilot, route to manual_action_needed")), "LinkedIn is not on autopilot");
  assert.equal(shortReason({ ...tray }), "package ready");
  assert.ok(clip("word ".repeat(40), 30).endsWith("…"));
  assert.ok(clip("word ".repeat(40), 30).length <= 30);
}

console.log("notify-escalations: ok");
