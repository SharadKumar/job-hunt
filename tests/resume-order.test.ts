import { orderedExperiences } from "../templates/resume/_experience-order.ts";
import type { ExperienceItem } from "../templates/resume/_interface.ts";

const feature = (title: string, start: string, end: string): ExperienceItem => ({
  placement: "feature", title, company: "Example", start, end, summary: "Summary", bullets: ["Evidence"],
});
const mention = (title: string, start: string, end: string): ExperienceItem => ({
  placement: "mention", title, company: "Example", start, end, one_liner: "Evidence",
});

const ordered = orderedExperiences([
  feature("Older featured", "2016-01", "2019-01"),
  mention("Newer compact", "2021-01", "2021-08"),
  feature("Current featured", "2026-01", "current"),
]).map(({ xp }) => xp.title);

const expected = ["Current featured", "Newer compact", "Older featured"];
if (JSON.stringify(ordered) !== JSON.stringify(expected)) {
  console.error(`  ✗ mixed experience chronology: ${JSON.stringify(ordered)}`);
  process.exit(1);
}
console.log("  ✓ featured and compact experiences share reverse chronology");
