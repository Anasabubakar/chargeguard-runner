// Worker process entry point: one paid-endpoint server per OS process.
// Prints one JSON line on stdout when listening: {"ready":true,"port":N,"workerId":"...","pid":N}.
// Exit codes: 0 clean stop, 78 configuration refused (no store, bad setting), 70 store could not be opened.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ConfigError, StoreUnavailableError } from "../errors.ts";
import { createWorkerApp } from "../server/app.ts";
import { workerConfigFromEnv } from "../server/config.ts";

export const EXIT_CONFIG = 78;
export const EXIT_STORE = 70;

function toRequest(req: IncomingMessage, port: number): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else headers.set(k, v);
  }
  return new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, { method: req.method ?? "GET", headers });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    const existing = headers[key];
    headers[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

try {
  const config = workerConfigFromEnv(process.env);
  const app = createWorkerApp(config);
  const server = createServer((req, res) => {
    const port = (server.address() as { port: number }).port;
    app
      .handle(toRequest(req, port))
      .then((response) => send(res, response))
      .catch(() => {
        res.writeHead(500).end();
      });
  });
  server.listen(config.port, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    process.stdout.write(JSON.stringify({ ready: true, port, workerId: config.workerId, pid: process.pid, store: config.store.kind }) + "\n");
  });
  const stop = () => {
    server.close();
    app.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch (error) {
  process.stderr.write(`chargeguard worker refused to start: ${(error as Error).message}\n`);
  process.exit(error instanceof ConfigError ? EXIT_CONFIG : error instanceof StoreUnavailableError ? EXIT_STORE : 1);
}
