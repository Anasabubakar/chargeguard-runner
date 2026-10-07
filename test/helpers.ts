import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Per-test scratch directory under the OS temp dir (removed by the OS, never by rm). */
export function scratch(prefix = "chargeguard-test-"): string {
  return mkdtempSync(join(process.env.CHARGEGUARD_TMPDIR ?? tmpdir(), prefix));
}
