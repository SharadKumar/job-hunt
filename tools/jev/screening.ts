import { evaluateWithJev } from "./evaluate.ts";

export type ScreeningCandidate = { id: string; patterns: string[] };

/**
 * Fuzzy-match a portal question to an existing answer-bank entry. This never
 * creates an answer and never sends stored answer text to the model.
 */
export async function fuzzyScreeningMatch<T extends ScreeningCandidate>(label: string, entries: T[]): Promise<T | undefined> {
  if (!entries.length) return undefined;
  const criteria: Record<string, string> = { none: "No existing entry has the same meaning." };
  const byKey = new Map<string, T>();
  entries.forEach((entry, index) => {
    const key = `entry_${index}`;
    criteria[key] = `Answer-bank id ${entry.id}; known question patterns: ${entry.patterns.join(" | ")}`;
    byKey.set(key, entry);
  });
  const evaluation = await evaluateWithJev({
    callSite: "screening-match",
    state: { portal_question: label },
    questions: {
        answer_bank_match: {
          type: "choice",
          instructions: "Choose an existing answer-bank entry only when it asks the same factual question. Superficial topic overlap is insufficient. Choose none when unsure.",
          criteria,
        },
    },
  });
  if (evaluation.status === "degraded" || !evaluation.route_fingerprint_matches) return undefined;
  const answer = evaluation.result.answers.answer_bank_match;
  const probabilities = answer.probabilities ?? {};
  const sorted = Object.values(probabilities).sort((a, b) => b - a);
  if (answer.choice === "none" || (sorted[0] ?? 0) < 0.85 || (sorted[0] ?? 0) - (sorted[1] ?? 0) < 0.2) return undefined;
  return byKey.get(answer.choice ?? "");
}
