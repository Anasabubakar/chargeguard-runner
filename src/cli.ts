#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename, relative } from "node:path";
import { parseArgs } from "node:util";
import { EXIT } from "./exit-codes.ts";
import { reportSchema, suiteSchema } from "./report/schema.ts";
import { renderReportText, renderSuiteText } from "./report/text.ts";
import { defaultParams, runScenario, UsageError } from "./runner.ts";
import { SCENARIOS, findScenario } from "./scenarios/index.ts";
import { runSuite } from "./suite.ts";

const HELP = `chargeguard: deployment tests for Stellar MPP replay protection

Usage:
  chargeguard list
  chargeguard run <scenario> [--store memory|sqlite] [--mode push|pull] [--variant <v>] [--rounds <n>]
                             [--backend stub|testnet] [--out report.json] [--text-out report.txt] [--keep-run-dir]
  chargeguard suite [--backend stub|testnet] [--only <scenario,...>] [--out suite.json] [--text-out suite.txt]
  chargeguard validate <report.json>

Backends:
  stub     two worker processes over real HTTP against a local stub of a Soroban RPC node (evidence class: integration)
  testnet  the same workers against Stellar testnet through a logging pass-through (evidence class: testnet settlement).
           Needs CHARGEGUARD_PAYER_SECRETS (funded testnet secret keys, comma separated) and CHARGEGUARD_RECIPIENT
           (a funded testnet public key) in the environment. Secrets are read from the environment only and never written.

Exit codes:
  0  every invariant held (run) / every run matched its expectation (suite)
  1  an invariant was violated (run) / a run did not match its expectation (suite)
  2  invalid usage, unknown scenario, unsupported combination, or a report that fails validation
  3  inconclusive: the run could not reach the state it needed to test

A finite number of runs is evidence, not a proof of linearizability or exactly-once delivery.
`;

function commandLine(): string {
  const script = process.argv[1] ? relative(process.cwd(), process.argv[1]) : "chargeguard";
  return [basename(process.execPath), script, ...process.argv.slice(2)].join(" ");
}

function testnetCredentials(): { payerSecrets: string[]; recipient: string } | null {
  const secrets = (process.env.CHARGEGUARD_PAYER_SECRETS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const recipient = process.env.CHARGEGUARD_RECIPIENT?.trim();
  return secrets.length && recipient ? { payerSecrets: secrets, recipient } : null;
}

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
});

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return command ? EXIT.OK : EXIT.USAGE;
  }

  if (command === "list") {
    for (const s of SCENARIOS) {
      process.stdout.write(`${s.id}\n  ${s.title}\n  stores: ${s.stores.join(", ")}; backends: ${s.backends.join(", ")}${s.variants ? `\n  variants: ${s.variants.join(", ")}` : ""}\n  invariant: ${s.invariant}\n`);
    }
    return EXIT.OK;
  }

  if (command === "validate") {
    const file = rest[0];
    if (!file) {
      process.stderr.write("validate needs a file\n");
      return EXIT.USAGE;
    }
    try {
      const json = JSON.parse(readFileSync(file, "utf8")) as { kind?: string };
      const parsed = json.kind === "suite" ? suiteSchema.safeParse(json) : reportSchema.safeParse(json);
      if (!parsed.success) {
        process.stderr.write(`${file} does not validate:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}\n`);
        return EXIT.USAGE;
      }
      process.stdout.write(`${file}: valid ${json.kind} report v${parsed.data.reportVersion}\n`);
      return EXIT.OK;
    } catch (error) {
      process.stderr.write(`cannot read ${file}: ${(error as Error).message}\n`);
      return EXIT.USAGE;
    }
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      store: { type: "string" },
      mode: { type: "string" },
      variant: { type: "string" },
      rounds: { type: "string" },
      backend: { type: "string", default: "stub" },
      only: { type: "string" },
      out: { type: "string" },
      "text-out": { type: "string" },
      "keep-run-dir": { type: "boolean", default: false },
    },
  });
  const backend = values.backend;
  if (backend !== "stub" && backend !== "testnet") {
    process.stderr.write("--backend must be stub or testnet\n");
    return EXIT.USAGE;
  }
  const creds = backend === "testnet" ? testnetCredentials() : null;
  if (backend === "testnet" && !creds) {
    process.stderr.write("testnet needs CHARGEGUARD_PAYER_SECRETS and CHARGEGUARD_RECIPIENT in the environment (see --help)\n");
    return EXIT.USAGE;
  }

  if (command === "run") {
    const scenario = positionals[0] ? findScenario(positionals[0]) : undefined;
    if (!scenario) {
      process.stderr.write(`unknown scenario '${positionals[0] ?? ""}'; try: chargeguard list\n`);
      return EXIT.USAGE;
    }
    if (values.store && values.store !== "memory" && values.store !== "sqlite") {
      process.stderr.write("--store must be memory or sqlite\n");
      return EXIT.USAGE;
    }
    if (values.mode && values.mode !== "push" && values.mode !== "pull") {
      process.stderr.write("--mode must be push or pull\n");
      return EXIT.USAGE;
    }
    const rounds = values.rounds === undefined ? undefined : Number(values.rounds);
    if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000)) {
      process.stderr.write("--rounds must be an integer between 1 and 1000\n");
      return EXIT.USAGE;
    }
    try {
      const params = defaultParams(scenario, {
        ...(values.store ? { store: values.store as "memory" | "sqlite" } : {}),
        ...(values.mode ? { mode: values.mode as "push" | "pull" } : {}),
        ...(values.variant ? { variant: values.variant } : {}),
        ...(rounds !== undefined ? { rounds } : {}),
      });
      const report = await runScenario({ scenario, params, backend, command: commandLine(), keepRunDir: values["keep-run-dir"], ...(creds ?? {}) });
      reportSchema.parse(report);
      if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n");
      const text = renderReportText(report);
      if (values["text-out"]) writeFileSync(values["text-out"], text);
      process.stdout.write(text);
      return report.verdict === "pass" ? EXIT.OK : report.verdict === "fail" ? EXIT.VIOLATION : EXIT.INCONCLUSIVE;
    } catch (error) {
      if (error instanceof UsageError) {
        process.stderr.write(`${error.message}\n`);
        return EXIT.USAGE;
      }
      throw error;
    }
  }

  if (command === "suite") {
    const suite = await runSuite({
      backend,
      command: commandLine(),
      ...(creds ?? {}),
      ...(values.only ? { only: values.only.split(",") } : {}),
      onProgress: (line) => process.stderr.write(`${line}\n`),
    });
    suiteSchema.parse(suite);
    if (values.out) writeFileSync(values.out, JSON.stringify(suite, null, 2) + "\n");
    const text = renderSuiteText(suite);
    if (values["text-out"]) writeFileSync(values["text-out"], text);
    process.stdout.write(suite.reports.length > 8 ? text.split("=".repeat(100))[0]! : text);
    if (suite.totals.inconclusive > 0) return EXIT.INCONCLUSIVE;
    return suite.totals.matchedExpectation === suite.totals.runs ? EXIT.OK : EXIT.VIOLATION;
  }

  process.stderr.write(`unknown command '${command}'\n${HELP}`);
  return EXIT.USAGE;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`chargeguard failed: ${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = EXIT.INCONCLUSIVE;
  },
);
