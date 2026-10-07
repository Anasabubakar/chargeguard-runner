import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Version of an installed dependency, read from its own package.json (not from our declared pin). */
export function installedVersion(name: string): string {
  let dir = dirname(require.resolve(name));
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === name && pkg.version) return pkg.version;
    } catch {
      /* keep walking up */
    }
    dir = dirname(dir);
  }
  return "unknown";
}

export function runnerVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string }).version;
}
