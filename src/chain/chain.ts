import type { TestCert } from "./tls.ts";

/** What the runner can see of the chain, independent of any worker's claims. */
export interface ChainObservation {
  /** A transaction with this hash reached the node (accepted into the mempool or already known). */
  submitted: boolean;
  status: "SUCCESS" | "FAILED" | "NOT_FOUND" | "UNKNOWN";
}

export interface SendLogEntry {
  at: string;
  hash: string;
  /** What the node answered to sendTransaction. DROPPED: the connection was cut before an answer. */
  outcome: "PENDING" | "DUPLICATE" | "ERROR" | "DROPPED" | "UNKNOWN";
  /** For ERROR: the transaction result code the node gave (for example txBadSeq), when it could be decoded. */
  resultCode?: string;
}

/**
 * The chain as the harness sees it. Workers and the payer talk to `url`; the runner calls
 * `observe` to learn what actually happened. Two implementations: the local stub (integration
 * evidence) and a logging tap in front of Stellar testnet (testnet-settlement evidence).
 */
export interface Chain {
  readonly kind: "stub" | "testnet";
  readonly description: string;
  readonly url: string;
  /** Certificate the endpoint serves; spawned workers trust it through NODE_EXTRA_CA_CERTS. */
  readonly cert: TestCert;
  readonly sendLog: SendLogEntry[];
  observe(hash: string): Promise<ChainObservation>;
  close(): Promise<void>;
}
