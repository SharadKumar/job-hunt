#!/usr/bin/env tsx

import { acknowledgeDegradation, type JevDegradationScope } from "./degradation.ts";
import { log as auditLog } from "../audit.ts";

const actorAt = process.argv.indexOf("--actor");
const actor = actorAt >= 0 ? process.argv[actorAt + 1] : "user";
const scopeAt = process.argv.indexOf("--scope");
const scope = (scopeAt >= 0 ? process.argv[scopeAt + 1] : "classification") as JevDegradationScope;
if (!["classification", "screening_match", "fuzzy_dedup"].includes(scope)) throw new Error(`Unsupported degradation scope: ${scope}`);
const state = await acknowledgeDegradation(scope, actor);
await auditLog({ event_type: "jev_degradation_acknowledged", role_id: null, actor, details: { reason: state.reason, first_seen_at: state.first_seen_at } });
console.log(JSON.stringify({ acknowledged: true, scope, actor, reason: state.reason }));
