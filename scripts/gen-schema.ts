// Run with: node --experimental-strip-types scripts/gen-schema.ts [--check]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { reportSchema, suiteSchema } from "../src/report/schema.ts";

const check = process.argv.includes("--check");
const targets: Array<[string, z.ZodType, string]> = [
  ["schema/report.v1.schema.json", reportSchema, "ChargeGuard run report v1"],
  ["schema/suite.v1.schema.json", suiteSchema, "ChargeGuard suite report v1"],
];
mkdirSync("schema", { recursive: true });
let stale = false;
for (const [path, schema, title] of targets) {
  const text = JSON.stringify({ title, ...z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" }) }, null, 2) + "\n";
  if (check) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      /* missing counts as stale */
    }
    if (current !== text) {
      console.error(`${path} is out of date; run pnpm schema`);
      stale = true;
    }
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${path}`);
  }
}
if (stale) process.exit(1);
