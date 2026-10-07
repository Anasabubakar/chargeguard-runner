import { XLM_SAC_TESTNET } from "@stellar/mpp";
import { Keypair } from "@stellar/stellar-sdk";
import { ConfigError } from "../errors.ts";
import { parseStoreSpec, type StoreSpec } from "../store/spec.ts";

export interface WorkerConfig {
  workerId: string;
  store: StoreSpec;
  /** HMAC key for challenge ids; every worker of one deployment must share it. */
  mppSecret: string;
  recipient: string;
  currency: string;
  /** Human-readable amount, e.g. "0.01". */
  amount: string;
  rpcUrl?: string;
  /** Directory the worker writes its event and fulfillment logs to. */
  runDir: string;
  port: number;
  challengeTtlSeconds: number;
  pollDelayMs: number;
  pollTimeoutMs: number;
  pollMaxAttempts: number;
  /** Max time a store call may stall before the request is failed closed. */
  storeBusyTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new ConfigError(`${name} is required`);
  return v;
}

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a non-negative integer`);
  return n;
}

/** Reads a worker's configuration from environment variables. Throws ConfigError on anything missing. */
export function workerConfigFromEnv(env: Env): WorkerConfig {
  const store = parseStoreSpec(env.CHARGEGUARD_STORE);
  const recipient = required(env, "CHARGEGUARD_RECIPIENT");
  try {
    Keypair.fromPublicKey(recipient);
  } catch {
    throw new ConfigError("CHARGEGUARD_RECIPIENT is not a valid Stellar public key");
  }
  const mppSecret = required(env, "CHARGEGUARD_MPP_SECRET");
  if (mppSecret.length < 32) throw new ConfigError("CHARGEGUARD_MPP_SECRET must be at least 32 characters");
  return {
    workerId: required(env, "CHARGEGUARD_WORKER_ID"),
    store,
    mppSecret,
    recipient,
    currency: env.CHARGEGUARD_CURRENCY?.trim() || XLM_SAC_TESTNET,
    amount: env.CHARGEGUARD_AMOUNT?.trim() || "0.01",
    ...(env.CHARGEGUARD_RPC_URL?.trim() ? { rpcUrl: env.CHARGEGUARD_RPC_URL.trim() } : {}),
    runDir: required(env, "CHARGEGUARD_RUN_DIR"),
    port: int(env, "CHARGEGUARD_PORT", 0),
    challengeTtlSeconds: int(env, "CHARGEGUARD_TTL_SECONDS", 120),
    pollDelayMs: int(env, "CHARGEGUARD_POLL_DELAY_MS", 1000),
    pollTimeoutMs: int(env, "CHARGEGUARD_POLL_TIMEOUT_MS", 20_000),
    pollMaxAttempts: int(env, "CHARGEGUARD_POLL_MAX_ATTEMPTS", 20),
    storeBusyTimeoutMs: int(env, "CHARGEGUARD_STORE_BUSY_MS", 1500),
  };
}
