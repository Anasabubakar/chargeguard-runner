/**
 * The four levels ChargeGuard keeps apart in every report and in the code.
 *
 * A single "paid" boolean hides the failure classes this tool exists to find, so
 * each payment is described by four independent facts:
 *
 * - accepted:   the server's verify step accepted the credential and answered
 *               with a receipt (HTTP 200). This is a statement about the
 *               server's store, not about the chain.
 * - submitted:  a transaction carrying the payment reached a Stellar node
 *               (sendTransaction returned PENDING, or the payer broadcast it).
 * - confirmed:  the ledger shows the transaction as SUCCESS. Observed by the
 *               runner against the chain, not by trusting the worker.
 * - fulfilled:  the paid resource was actually delivered. Observed in the
 *               worker's fulfillment log, once per delivery.
 *
 * Replay protection is a property of the first level only: it decides how many
 * workers say "accepted" for one payment. The others show what that cost.
 */
export const LEVELS = ["accepted", "submitted", "confirmed", "fulfilled"] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_DESCRIPTIONS: Record<Level, string> = {
  accepted: "The server verified the credential and replied 200 with a receipt.",
  submitted: "A transaction for the payment reached a Stellar node (by the server in pull mode, by the payer in push mode).",
  confirmed: "The ledger reports the transaction as SUCCESS, observed by the runner and not by the worker.",
  fulfilled: "The paid resource was delivered, recorded once per delivery in the worker's fulfillment log.",
};

/** What the evidence for one payment says at each level. */
export interface PaymentLevels {
  /** How many worker responses accepted a credential for this payment. */
  accepted: number;
  /** Who put the transaction on the network, or null when no submission was observed. */
  submitted: "worker" | "client" | null;
  /** Ledger status as observed by the runner. */
  confirmed: "SUCCESS" | "FAILED" | "NOT_FOUND" | "UNKNOWN";
  /** How many times the paid resource was delivered for this payment. */
  fulfilled: number;
}

/**
 * Evidence class of a run. A report never mixes these up:
 * - in-process: store or server logic exercised inside one process, no HTTP between workers.
 * - integration: separate worker OS processes over real HTTP against a simulated chain (a local JSON-RPC stub).
 * - testnet settlement: separate worker OS processes over real HTTP, real Stellar testnet transactions.
 */
export const EVIDENCE_CLASSES = ["in-process", "integration", "testnet settlement"] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];
