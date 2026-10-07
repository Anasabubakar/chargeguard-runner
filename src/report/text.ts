import { LEVEL_DESCRIPTIONS, LEVELS } from "../levels.ts";
import type { Report, Suite } from "./schema.ts";

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const wrap = (text: string, indent: string, width = 100): string => {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width - indent.length) {
      lines.push(line);
      line = w;
    } else line = (line + " " + w).trim();
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
};

export function renderReportText(r: Report): string {
  const out: string[] = [];
  const verdict = r.verdict.toUpperCase();
  out.push(`ChargeGuard run report v${r.reportVersion}`);
  out.push(`${r.scenario.title}${r.scenario.variant ? ` [${r.scenario.variant}]` : ""}  (${r.scenario.id})`);
  out.push("");
  out.push(`Evidence class : ${r.evidenceClass}  (chain: ${r.chain.description})`);
  out.push(`Deployment     : ${r.deployment.workers} worker processes, store=${r.deployment.store}, credential mode=${r.deployment.mode}`);
  out.push(`Command        : ${r.command}`);
  out.push(`Environment    : node ${r.environment.node} on ${r.environment.platform}/${r.environment.arch}; @stellar/mpp ${r.environment.sdk["@stellar/mpp"]}, mppx ${r.environment.sdk.mppx}, @stellar/stellar-sdk ${r.environment.sdk["@stellar/stellar-sdk"]}`);
  out.push(`Generated      : ${r.generatedAt}`);
  out.push("");
  out.push(`VERDICT: ${verdict}   (expected ${r.expectation.toUpperCase()}: ${r.matchesExpectation ? "as expected" : "NOT as expected"})`);
  out.push(wrap(r.summary, "  "));
  out.push("");
  out.push("Invariant under test:");
  out.push(wrap(r.scenario.invariant, "  "));
  out.push("");
  out.push("Fault schedule (planned):");
  r.scenario.faultSchedule.forEach((s, i) => out.push(wrap(`${i + 1}. ${s}`, "  ")));
  out.push("");
  out.push("Checks:");
  for (const c of r.checks) {
    out.push(`  [${c.passed ? "pass" : "FAIL"}] ${c.id}`);
    out.push(wrap(c.description, "         "));
    out.push(wrap(`-> ${c.detail}`, "         "));
  }
  if (r.payments.length) {
    out.push("");
    out.push("Payments, with the four levels kept apart:");
    for (const l of LEVELS) out.push(wrap(`${l}: ${LEVEL_DESCRIPTIONS[l]}`, "  "));
    out.push("");
    out.push(`  ${pad("payment", 11)}${pad("mode", 6)}${pad("accepted", 10)}${pad("submitted", 11)}${pad("confirmed", 11)}fulfilled`);
    for (const p of r.payments) {
      out.push(`  ${pad(p.id, 11)}${pad(p.mode, 6)}${pad(String(p.levels.accepted), 10)}${pad(p.levels.submitted ?? "-", 11)}${pad(p.levels.confirmed, 11)}${p.levels.fulfilled}`);
    }
    for (const p of r.payments) if (p.note) out.push(wrap(`${p.id} (${p.txHash.slice(0, 12)}…): ${p.note}`, "  "));
  }
  if (r.broadcasts.length) {
    out.push("");
    out.push("Broadcasts seen by the chain endpoint (sendTransaction and the node's answer):");
    for (const b of r.broadcasts) out.push(`  +${pad(String(b.t), 6)} ms  ${pad(b.paymentId ?? "unknown", 11)}${pad(b.outcome, 10)}${b.resultCode ?? ""}  ${b.txHash.slice(0, 12)}…`);
  }
  if (r.faultEvents.length) {
    out.push("");
    out.push("Fault and harness events:");
    for (const f of r.faultEvents) out.push(`  +${pad(String(f.t), 6)} ms  ${pad(f.kind, 18)} ${f.detail}`);
  }
  out.push("");
  out.push("Timeline (client view, one line per request):");
  for (const e of r.timeline) {
    out.push(`  +${pad(String(e.t), 6)} ms  ${pad(e.worker, 9)} ${pad(String(e.status), 4)}${pad(e.outcome, 12)}${e.label}${e.detail ? `  [${e.detail}]` : ""}`);
  }
  if (r.observations.length) {
    out.push("");
    out.push("Observations (reported, not pass/fail):");
    r.observations.forEach((o) => out.push(wrap(`- ${o}`, "  ")));
  }
  out.push("");
  out.push("Limits:");
  r.limits.forEach((l) => out.push(wrap(`- ${l}`, "  ")));
  return out.join("\n") + "\n";
}

export function renderSuiteText(s: Suite): string {
  const out: string[] = [];
  out.push(`ChargeGuard suite report v${s.reportVersion}  (${s.evidenceClass})`);
  out.push(`Command   : ${s.command}`);
  out.push(`Generated : ${s.generatedAt}`);
  out.push(`Environment: node ${s.environment.node} on ${s.environment.platform}/${s.environment.arch}; @stellar/mpp ${s.environment.sdk["@stellar/mpp"]}, mppx ${s.environment.sdk.mppx}, @stellar/stellar-sdk ${s.environment.sdk["@stellar/stellar-sdk"]}`);
  out.push("");
  out.push(`${pad("scenario", 50)}${pad("store", 8)}${pad("mode", 6)}${pad("verdict", 14)}expected  matches`);
  for (const r of s.reports) {
    const name = `${r.scenario.id}${r.scenario.variant ? `/${r.scenario.variant}` : ""}`;
    out.push(`${pad(name, 50)}${pad(r.deployment.store, 8)}${pad(r.deployment.mode, 6)}${pad(r.verdict, 14)}${pad(r.expectation, 10)}${r.matchesExpectation ? "yes" : "NO"}`);
  }
  out.push("");
  out.push(`Totals: ${s.totals.runs} runs; pass ${s.totals.pass}, fail ${s.totals.fail}, inconclusive ${s.totals.inconclusive}; ${s.totals.matchedExpectation} matched their expectation.`);
  out.push("A 'fail' on a control run (isolated memory stores) is the demonstration, not a defect in the runner.");
  out.push("");
  out.push("Limits:");
  s.limits.forEach((l) => out.push(wrap(`- ${l}`, "  ")));
  out.push("");
  out.push("=".repeat(100));
  for (const r of s.reports) {
    out.push("");
    out.push(renderReportText(r));
    out.push("=".repeat(100));
  }
  return out.join("\n") + "\n";
}
