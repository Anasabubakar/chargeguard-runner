import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const WORKER_MAIN = fileURLToPath(new URL(`../worker/main${ext}`, import.meta.url));

export interface WorkerOptions {
  id: string;
  /** Raw CHARGEGUARD_STORE value, or undefined to leave it unset (the worker must refuse to start). */
  store: string | undefined;
  runDir: string;
  recipient: string;
  mppSecret: string;
  rpcUrl?: string;
  currency?: string;
  amount?: string;
  ttlSeconds?: number;
  pollDelayMs?: number;
  pollTimeoutMs?: number;
  pollMaxAttempts?: number;
  storeBusyMs?: number;
  /** PEM file the worker should trust (the stub chain's certificate). */
  caCertPath?: string;
  /** Extra environment, applied last (used by tests to break configuration). */
  extraEnv?: Record<string, string | undefined>;
}

export interface WorkerHandle {
  readonly id: string;
  readonly url: string;
  readonly port: number;
  readonly pid: number;
  readonly options: WorkerOptions;
  /** SIGKILL: no shutdown hooks run, like a crash or an OOM kill. */
  kill(): Promise<void>;
  /** SIGTERM and wait for exit. */
  stop(): Promise<void>;
  exited(): boolean;
}

export type StartResult =
  | { ok: true; worker: WorkerHandle }
  | { ok: false; exitCode: number | null; signal: NodeJS.Signals | null; stderr: string };

function buildEnv(o: WorkerOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    CHARGEGUARD_WORKER_ID: o.id,
    CHARGEGUARD_RUN_DIR: o.runDir,
    CHARGEGUARD_RECIPIENT: o.recipient,
    CHARGEGUARD_MPP_SECRET: o.mppSecret,
  };
  if (o.store !== undefined) env.CHARGEGUARD_STORE = o.store;
  if (o.rpcUrl) env.CHARGEGUARD_RPC_URL = o.rpcUrl;
  if (o.caCertPath) env.NODE_EXTRA_CA_CERTS = o.caCertPath;
  if (o.currency) env.CHARGEGUARD_CURRENCY = o.currency;
  if (o.amount) env.CHARGEGUARD_AMOUNT = o.amount;
  if (o.ttlSeconds !== undefined) env.CHARGEGUARD_TTL_SECONDS = String(o.ttlSeconds);
  if (o.pollDelayMs !== undefined) env.CHARGEGUARD_POLL_DELAY_MS = String(o.pollDelayMs);
  if (o.pollTimeoutMs !== undefined) env.CHARGEGUARD_POLL_TIMEOUT_MS = String(o.pollTimeoutMs);
  if (o.pollMaxAttempts !== undefined) env.CHARGEGUARD_POLL_MAX_ATTEMPTS = String(o.pollMaxAttempts);
  if (o.storeBusyMs !== undefined) env.CHARGEGUARD_STORE_BUSY_MS = String(o.storeBusyMs);
  for (const [k, v] of Object.entries(o.extraEnv ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** Starts one worker as its own OS process and waits for its ready line, or for it to exit. */
export function tryStartWorker(options: WorkerOptions, timeoutMs = 20_000): Promise<StartResult> {
  const args = ext === ".ts" ? ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", WORKER_MAIN] : [WORKER_MAIN];
  const child: ChildProcess = spawn(process.execPath, args, { env: buildEnv(options), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => child.once("exit", () => ((exited = true), resolve())));

  return new Promise<StartResult>((resolve) => {
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, exitCode: null, signal: "SIGKILL", stderr: `${stderr}\n(timed out waiting for the worker to listen)` });
    }, timeoutMs);
    child.stdout!.on("data", (d: Buffer) => {
      buffer += d.toString();
      const line = buffer.split("\n")[0];
      if (!line || !buffer.includes("\n")) return;
      try {
        const ready = JSON.parse(line) as { ready: boolean; port: number; pid: number };
        if (!ready.ready) return;
        clearTimeout(timer);
        const worker: WorkerHandle = {
          id: options.id,
          url: `http://127.0.0.1:${ready.port}`,
          port: ready.port,
          pid: ready.pid,
          options,
          exited: () => exited,
          async kill() {
            if (!exited) child.kill("SIGKILL");
            await exitPromise;
          },
          async stop() {
            if (!exited) child.kill("SIGTERM");
            await exitPromise;
          },
        };
        resolve({ ok: true, worker });
      } catch {
        /* not the ready line yet */
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: code, signal, stderr });
    });
  });
}

export async function startWorker(options: WorkerOptions): Promise<WorkerHandle> {
  const result = await tryStartWorker(options);
  if (!result.ok) throw new Error(`worker ${options.id} failed to start (exit ${result.exitCode ?? result.signal}): ${result.stderr.trim()}`);
  return result.worker;
}
