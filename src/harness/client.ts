import { Credential } from "mppx";
import { Mppx, stellar } from "@stellar/mpp/charge/client";
import { FeeBumpTransaction, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";

export type PayMode = "push" | "pull";

export interface ClientOptions {
  keypair: Keypair;
  mode: PayMode;
  /** Soroban RPC the official client builds and (in push mode) submits against. */
  rpcUrl?: string;
  pollDelayMs?: number;
  pollTimeoutMs?: number;
}

export interface Payer {
  readonly mode: PayMode;
  readonly publicKey: string;
  /** Asks a worker for a challenge. Returns the raw 402 response. */
  requestChallenge(url: string): Promise<Response>;
  /**
   * Builds a credential with the official @stellar/mpp client for a 402 response.
   * Pull mode: signs a transfer, nothing reaches the network yet.
   * Push mode: the client broadcasts and waits for confirmation itself, then returns a signedHash credential.
   */
  createCredential(challengeResponse: Response): Promise<string>;
  /** Presents an Authorization value to a worker. */
  present(url: string, authorization: string): Promise<Response>;
}

export function createPayer(options: ClientOptions): Payer {
  const mppx = Mppx.create({
    polyfill: false,
    methods: [
      stellar.charge({
        keypair: options.keypair,
        mode: options.mode,
        ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
        ...(options.pollDelayMs !== undefined ? { pollDelayMs: options.pollDelayMs } : {}),
        ...(options.pollTimeoutMs !== undefined ? { pollTimeoutMs: options.pollTimeoutMs } : {}),
      }),
    ],
  });
  return {
    mode: options.mode,
    publicKey: options.keypair.publicKey(),
    requestChallenge: (url) => fetch(url),
    createCredential: (response) => mppx.createCredential(response),
    present: (url, authorization) => fetch(url, { headers: { authorization } }),
  };
}

export interface CredentialInfo {
  challengeId: string;
  type: "transaction" | "signedHash" | "hash";
  /** Inner transaction hash (hex): the payment's identity across all four levels. */
  txHash: string;
  payer: string | null;
}

/** Reads a serialised credential (an Authorization value) and derives the payment's transaction hash. */
export function describeCredential(authorization: string): CredentialInfo {
  const credential = Credential.deserialize<{ type: "transaction" | "signedHash" | "hash"; transaction?: string; hash?: string }>(authorization);
  const payload = credential.payload;
  let txHash: string;
  if (payload.type === "transaction") {
    const parsed = TransactionBuilder.fromXDR(payload.transaction!, Networks.TESTNET);
    const inner = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
    txHash = inner.hash().toString("hex");
  } else {
    txHash = payload.hash!.toLowerCase();
  }
  const source = (credential as { source?: string }).source;
  return { challengeId: credential.challenge.id, type: payload.type, txHash, payer: source ? (source.split(":").pop() ?? null) : null };
}
