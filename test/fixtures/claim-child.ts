// Child process for the cross-process atomicity test.
// argv: dbPath keyCount workerName   -> prints JSON {claimed: string[]}
import { openSqliteStore } from "../../src/store/sqlite.ts";

const [dbPath, keyCount, name] = process.argv.slice(2);
const store = openSqliteStore(dbPath!, { busyTimeoutMs: 10_000 });
const claimed: string[] = [];
for (let i = 0; i < Number(keyCount); i++) {
  const key = `claim:${i}`;
  const result = await store.update(key, (current) =>
    current ? { op: "noop", result: "taken" as const } : { op: "set", value: { by: name }, result: "claimed" as const },
  );
  if (result === "claimed") claimed.push(key);
}
store.close();
process.stdout.write(JSON.stringify({ claimed }) + "\n");
