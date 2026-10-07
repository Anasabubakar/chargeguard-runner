import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { reportSchema } from "../src/report/schema.ts";
import { scratch } from "./helpers.ts";

const exec = promisify(execFile);
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

async function chargeguard(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, ...args], {
      env: { PATH: process.env.PATH, ...env },
      maxBuffer: 10_000_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("chargeguard CLI exit codes", () => {
  it("2 with no arguments, 0 for help and list", async () => {
    expect((await chargeguard([])).code).toBe(2);
    expect((await chargeguard(["--help"])).code).toBe(0);
    const list = await chargeguard(["list"]);
    expect(list.code).toBe(0);
    for (const id of ["repeated-credential", "concurrent-submission", "restart-persistence", "storage-unavailable", "challenge-consumption", "ambiguous-settlement"]) expect(list.stdout).toContain(id);
  });

  it("2 for an unknown scenario, an unsupported store, a bad flag value, and testnet without credentials", async () => {
    expect((await chargeguard(["run", "nope"])).code).toBe(2);
    expect((await chargeguard(["run", "storage-unavailable", "--store", "memory"])).code).toBe(2);
    expect((await chargeguard(["run", "repeated-credential", "--mode", "sideways"])).code).toBe(2);
    expect((await chargeguard(["run", "ambiguous-settlement"])).code).toBe(2);
    const testnet = await chargeguard(["run", "repeated-credential", "--backend", "testnet"]);
    expect(testnet.code).toBe(2);
    expect(testnet.stderr).toContain("CHARGEGUARD_PAYER_SECRETS");
  });

  it("1 for the isolated-memory deployment, 0 for the shared store, and a report that validates", async () => {
    const dir = scratch();
    const bad = join(dir, "bad.json");
    const good = join(dir, "good.json");
    const failing = await chargeguard(["run", "repeated-credential", "--store", "memory", "--mode", "push", "--out", bad, "--text-out", join(dir, "bad.txt")]);
    expect(failing.code).toBe(1);
    expect(failing.stdout).toContain("VERDICT: FAIL");
    expect(existsSync(join(dir, "bad.txt"))).toBe(true);
    const passing = await chargeguard(["run", "repeated-credential", "--store", "sqlite", "--mode", "push", "--out", good]);
    expect(passing.code).toBe(0);
    for (const [file, verdict] of [[bad, "fail"], [good, "pass"]] as const) {
      const report = reportSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      expect(report.verdict).toBe(verdict);
      expect(report.command).toContain("repeated-credential");
      expect((await chargeguard(["validate", file])).code).toBe(0);
    }
  });

  it("validate exits 2 for a file that is not a report", async () => {
    const file = join(scratch(), "x.json");
    writeFileSync(file, JSON.stringify({ kind: "run", reportVersion: "1" }));
    expect((await chargeguard(["validate", file])).code).toBe(2);
    expect((await chargeguard(["validate", join(scratch(), "missing.json")])).code).toBe(2);
  });
});
