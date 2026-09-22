import { h } from "./app.js";

export function beforeAfterTable(correction, benchmark) {
  const measured = correction?.before_after_same_active_subset || {};
  const coverage = benchmark?.coverage || {};
  const quality = benchmark?.operational_quality || {};
  const rows = [
    ["Automatic decisions", measured.automatic?.before, coverage.automatic, (value) => String(value)],
    ["Uncertain decisions", measured.uncertain?.before, coverage.uncertain, (value) => String(value)],
    ["Operational-proxy calibration error", null, quality.calibration_ece, (value) => Number(value).toFixed(4)],
    ["False-high decisions under production rule", null, quality.automatic_high_known_negative_errors, (value) => String(value)],
    ["False-low decisions under production rule", null, quality.automatic_low_apply_worthy_errors, (value) => String(value)],
  ].filter(([, before, current]) => before != null || current != null);
  return h("table", { class: "jev-before-after" },
    h("thead", {}, h("tr", {}, h("th", { text: "Measure" }), h("th", { text: "Before" }), h("th", { text: "Current" }), h("th", { text: "Change" }))),
    h("tbody", {}, ...rows.map(([label, before, current, format]) => h("tr", {},
      h("th", { text: label }),
      h("td", { text: before == null ? "Not comparable" : format(before) }),
      h("td", { text: current == null ? "Not measured" : format(current) }),
      h("td", { text: before == null || current == null ? "Current basis only" : `${Number(current) - Number(before) > 0 ? "+" : ""}${(Number(current) - Number(before)).toFixed(Math.abs(Number(current) - Number(before)) < 1 ? 4 : 0)}` }),
    ))),
  );
}
