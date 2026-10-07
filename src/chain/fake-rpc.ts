import { createServer, type Server } from "node:https";
import { createTestCert, trustCert } from "./tls.ts";
import type { Chain, ChainObservation, SendLogEntry } from "./chain.ts";
import {
  Address,
  Networks,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  FeeBumpTransaction,
  scValToBigInt,
  xdr,
} from "@stellar/stellar-sdk";

/**
 * A local stand-in for a Soroban RPC node, used for the "integration" evidence class.
 *
 * It speaks just enough JSON-RPC for the official @stellar/mpp unsponsored charge flow
 * (client: getLedgerEntries + simulateTransaction; server: simulateTransaction,
 * sendTransaction, getTransaction) and applies the one Stellar rule that matters for replay:
 * a transaction is only accepted when its sequence number is exactly the account's current
 * sequence plus one, so a second submission of the same signed transaction is rejected.
 *
 * It is NOT Stellar. It does not execute contracts: the simulated transfer event is derived
 * from the transaction's own invoke arguments. Anything it returns is labelled "simulated
 * chain" in reports. The sponsored (feePayer) path needs getLatestLedger header XDR and is not
 * supported; the stub answers it with a JSON-RPC error.
 */

export type LandMode = "immediate" | "manual";
export type SendMode = "ok" | "error" | "drop";

export interface ChainFaults {
  /** immediate: confirmed as soon as sent. manual: stays NOT_FOUND until land() is called. */
  land: LandMode;
  /** ok: PENDING. error: synchronous ERROR (never enters the mempool). drop: connection is cut mid-request. */
  send: SendMode;
  /** When landing, finish as FAILED instead of SUCCESS. */
  landAs: "SUCCESS" | "FAILED";
  /** error: getTransaction answers with a JSON-RPC error (the node cannot say what it knows). */
  lookup: "ok" | "error";
}

export interface ChainTx {
  hash: string;
  envelopeXdr: string;
  source: string;
  sequence: string;
  submittedAt: string;
  status: "PENDING" | "SUCCESS" | "FAILED";
  landedAt?: string;
  ledger?: number;
}

export interface FakeChain extends Chain {
  readonly kind: "stub";
  faults: ChainFaults;
  /** Called after a transaction is accepted into the stub's mempool and before the node answers. */
  onSend: ((hash: string) => void | Promise<void>) | null;
  lookup(hash: string): ChainTx | undefined;
  /** Confirms a pending transaction (manual landing). */
  land(hash: string, as?: "SUCCESS" | "FAILED"): ChainTx;
  pending(): ChainTx[];
  close(): Promise<void>;
}

const BASE_LEDGER = 5_000_000;

function resultXdr(kind: "success" | "failed" | "badSeq"): string {
  const inner =
    kind === "success"
      ? xdr.TransactionResultResult.txSuccess([
          xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionSuccess(Buffer.alloc(32)))),
        ])
      : kind === "failed"
        ? xdr.TransactionResultResult.txFailed([
            xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped())),
          ])
        : xdr.TransactionResultResult.txBadSeq();
  return new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString("100"), result: inner, ext: new xdr.TransactionResultExt(0) }).toXDR("base64");
}

function metaXdr(): string {
  return xdr.TransactionMeta.fromXDR(
    new xdr.TransactionMeta(3, new xdr.TransactionMetaV3({ ext: new xdr.ExtensionPoint(0), txChangesBefore: [], operations: [], txChangesAfter: [], sorobanMeta: null })).toXDR("base64"),
    "base64",
  ).toXDR("base64");
}

function transferEvent(contractId: Buffer, from: string, to: string, amount: bigint): string {
  const body = new xdr.ContractEventV0({
    topics: [xdr.ScVal.scvSymbol("transfer"), new Address(from).toScVal(), new Address(to).toScVal(), xdr.ScVal.scvString("native")],
    data: xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString((amount >> 64n).toString()), lo: xdr.Uint64.fromString((amount & ((1n << 64n) - 1n)).toString()) })),
  });
  const event = new xdr.ContractEvent({ ext: new xdr.ExtensionPoint(0), contractId: contractId as never, type: xdr.ContractEventType.contract(), body: new xdr.ContractEventBody(0, body) });
  return new xdr.DiagnosticEvent({ inSuccessfulContractCall: true, event }).toXDR("base64");
}

function parseTx(b64: string): Transaction {
  const parsed = TransactionBuilder.fromXDR(b64, Networks.TESTNET);
  return (parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed) as Transaction;
}

function transferOf(tx: Transaction): { contractId: Buffer; from: string; to: string; amount: bigint } {
  const op = tx.toEnvelope().v1().tx().operations()[0]!.body().invokeHostFunctionOp().hostFunction().invokeContract();
  const args = op.args();
  return {
    contractId: op.contractAddress().contractId() as unknown as Buffer,
    from: Address.fromScVal(args[0]!).toString(),
    to: Address.fromScVal(args[1]!).toString(),
    amount: scValToBigInt(args[2]!),
  };
}

export async function startFakeChain(initial: Partial<ChainFaults> = {}): Promise<FakeChain> {
  const faults: ChainFaults = { land: "immediate", send: "ok", landAs: "SUCCESS", lookup: "ok", ...initial };
  let onSend: FakeChain["onSend"] = null;
  const sequences = new Map<string, bigint>();
  const txs = new Map<string, ChainTx>();
  const sendLog: SendLogEntry[] = [];
  let ledger = BASE_LEDGER;

  const seqOf = (address: string): bigint => {
    if (!sequences.has(address)) sequences.set(address, BigInt(1_000_000 + Math.floor(Math.random() * 1000)));
    return sequences.get(address)!;
  };

  const landTx = (tx: ChainTx, as: "SUCCESS" | "FAILED") => {
    ledger += 1;
    tx.status = as;
    tx.ledger = ledger;
    tx.landedAt = new Date().toISOString();
  };

  const methods: Record<string, (params: any, ctx: { drop: () => void }) => unknown | Promise<unknown>> = {
    getHealth: () => ({ status: "healthy", latestLedger: ledger }),
    getLedgerEntries: ({ keys }: { keys: string[] }) => ({
      latestLedger: ledger,
      entries: keys.map((k) => {
        const key = xdr.LedgerKey.fromXDR(k, "base64");
        const accountId = key.account().accountId();
        const address = Address.account(accountId.ed25519() as unknown as Buffer).toString();
        const entry = xdr.LedgerEntryData.account(
          new xdr.AccountEntry({
            accountId,
            balance: xdr.Int64.fromString("1000000000"),
            seqNum: xdr.Int64.fromString(seqOf(address).toString()),
            numSubEntries: 0,
            inflationDest: null,
            flags: 0,
            homeDomain: "",
            thresholds: Buffer.from([1, 0, 0, 0]),
            signers: [],
            ext: new xdr.AccountEntryExt(0),
          }),
        );
        return { key: k, xdr: entry.toXDR("base64"), lastModifiedLedgerSeq: ledger };
      }),
    }),
    simulateTransaction: ({ transaction }: { transaction: string }) => {
      const tx = parseTx(transaction);
      const t = transferOf(tx);
      return {
        latestLedger: ledger,
        minResourceFee: "100",
        transactionData: new SorobanDataBuilder().build().toXDR("base64"),
        events: [transferEvent(t.contractId, t.from, t.to, t.amount)],
        results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR("base64") }],
      };
    },
    sendTransaction: async ({ transaction }: { transaction: string }, ctx) => {
      const tx = parseTx(transaction);
      const hash = tx.hash().toString("hex");
      const at = new Date().toISOString();
      if (faults.send === "drop") {
        // The request may or may not have reached the network: apply it, then cut the connection.
        applySend(tx, hash, transaction, at);
        sendLog.push({ at, hash, outcome: "DROPPED" });
        ctx.drop();
        return undefined;
      }
      if (faults.send === "error") {
        sendLog.push({ at, hash, outcome: "ERROR", resultCode: "txFailed" });
        return { status: "ERROR", hash, latestLedger: ledger, latestLedgerCloseTime: String(Math.floor(Date.now() / 1000)), errorResultXdr: resultXdr("failed") };
      }
      const outcome = applySend(tx, hash, transaction, at);
      sendLog.push({ at, hash, outcome, ...(outcome === "ERROR" ? { resultCode: "txBadSeq" } : {}) });
      if (outcome === "PENDING" && onSend) await onSend(hash);
      if (outcome === "ERROR") {
        return { status: "ERROR", hash, latestLedger: ledger, latestLedgerCloseTime: String(Math.floor(Date.now() / 1000)), errorResultXdr: resultXdr("badSeq") };
      }
      return { status: outcome, hash, latestLedger: ledger, latestLedgerCloseTime: String(Math.floor(Date.now() / 1000)) };
    },
    getTransaction: ({ hash }: { hash: string }) => {
      if (faults.lookup === "error") throw new Error("stub node: getTransaction unavailable");
      const tx = txs.get(hash);
      const close = String(Math.floor(Date.now() / 1000));
      if (!tx || tx.status === "PENDING") {
        return { status: "NOT_FOUND", latestLedger: ledger, latestLedgerCloseTime: close, oldestLedger: BASE_LEDGER - 1000, oldestLedgerCloseTime: close };
      }
      return {
        status: tx.status,
        latestLedger: ledger,
        latestLedgerCloseTime: close,
        oldestLedger: BASE_LEDGER - 1000,
        oldestLedgerCloseTime: close,
        ledger: tx.ledger,
        createdAt: String(Math.floor(new Date(tx.landedAt!).getTime() / 1000)),
        applicationOrder: 1,
        feeBump: false,
        envelopeXdr: tx.envelopeXdr,
        resultXdr: resultXdr(tx.status === "SUCCESS" ? "success" : "failed"),
        resultMetaXdr: metaXdr(),
      };
    },
  };

  /** Applies the sequence rule. Returns the node's answer for the submission. */
  function applySend(tx: Transaction, hash: string, envelopeXdr: string, at: string): "PENDING" | "DUPLICATE" | "ERROR" {
    const known = txs.get(hash);
    if (known) return known.status === "PENDING" ? "DUPLICATE" : "ERROR";
    const current = seqOf(tx.source);
    if (BigInt(tx.sequence) !== current + 1n) return "ERROR";
    sequences.set(tx.source, current + 1n);
    const record: ChainTx = { hash, envelopeXdr, source: tx.source, sequence: tx.sequence, submittedAt: at, status: "PENDING" };
    txs.set(hash, record);
    if (faults.land === "immediate") landTx(record, faults.landAs);
    return "PENDING";
  }

  const cert = createTestCert();
  trustCert(cert.cert);
  const server: Server = createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let id: unknown = null;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: unknown; method: string; params: unknown };
        id = body.id;
        const handler = methods[body.method];
        if (!handler) {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `fake chain does not implement ${body.method}` } }));
          return;
        }
        let dropped = false;
        const result = await handler(body.params, {
          drop: () => {
            dropped = true;
            req.socket.destroy();
          },
        });
        if (dropped) return;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      } catch (error) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: (error as Error).message } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    kind: "stub",
    description: "local stub of a Soroban RPC node (no real ledger, no contract execution)",
    url: `https://127.0.0.1:${port}`,
    cert,
    faults,
    sendLog,
    get onSend() {
      return onSend;
    },
    set onSend(fn) {
      onSend = fn;
    },
    lookup: (hash) => txs.get(hash),
    async observe(hash): Promise<ChainObservation> {
      const tx = txs.get(hash);
      const sent = sendLog.some((e) => e.hash === hash && (e.outcome === "PENDING" || e.outcome === "DUPLICATE" || e.outcome === "DROPPED"));
      if (!tx) return { submitted: sent, status: "NOT_FOUND" };
      return { submitted: true, status: tx.status === "PENDING" ? "NOT_FOUND" : tx.status };
    },
    land(hash, as = "SUCCESS") {
      const tx = txs.get(hash);
      if (!tx) throw new Error(`unknown transaction ${hash}`);
      if (tx.status === "PENDING") landTx(tx, as);
      return tx;
    },
    pending: () => [...txs.values()].filter((t) => t.status === "PENDING"),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

