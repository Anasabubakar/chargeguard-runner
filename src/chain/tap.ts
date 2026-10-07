import { createServer } from "node:https";
import { FeeBumpTransaction, Networks, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import type { Chain, ChainObservation, SendLogEntry } from "./chain.ts";
import { createTestCert, trustCert } from "./tls.ts";

export const TESTNET_RPC = "https://soroban-testnet.stellar.org";

/**
 * A logging pass-through in front of the real Stellar testnet RPC.
 *
 * Workers and the payer talk to the tap over https (see tls.ts for why), the tap forwards every
 * JSON-RPC call unchanged to the real node, and records each sendTransaction it sees (hash and
 * the node's answer). That is how a report can show that a second worker's broadcast of an
 * already-spent transaction was refused by the network, which no worker reports itself.
 * It never alters a request or a response.
 */
export async function startTestnetTap(upstream: string = TESTNET_RPC): Promise<Chain> {
  const sendLog: SendLogEntry[] = [];
  const cert = createTestCert();
  trustCert(cert.cert);

  const server = createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      let sentHash: string | null = null;
      try {
        const parsed = JSON.parse(body.toString("utf8")) as { method?: string; params?: { transaction?: string } };
        if (parsed.method === "sendTransaction" && parsed.params?.transaction) {
          const tx = TransactionBuilder.fromXDR(parsed.params.transaction, Networks.TESTNET);
          sentHash = (tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx).hash().toString("hex");
        }
      } catch {
        /* forward anyway */
      }
      try {
        const upstreamResponse = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body });
        const text = await upstreamResponse.text();
        if (sentHash) {
          let outcome: SendLogEntry["outcome"] = "UNKNOWN";
          let resultCode: string | undefined;
          try {
            const result = (JSON.parse(text) as { result?: { status?: string; errorResultXdr?: string } }).result;
            const status = result?.status;
            if (status === "PENDING" || status === "DUPLICATE" || status === "ERROR") outcome = status;
            if (status === "ERROR" && result?.errorResultXdr) resultCode = xdr.TransactionResult.fromXDR(result.errorResultXdr, "base64").result().switch().name;
          } catch {
            /* keep UNKNOWN */
          }
          sendLog.push({ at: new Date().toISOString(), hash: sentHash, outcome, ...(resultCode ? { resultCode } : {}) });
        }
        res.writeHead(upstreamResponse.status, { "content-type": "application/json" }).end(text);
      } catch (error) {
        if (sentHash) sendLog.push({ at: new Date().toISOString(), hash: sentHash, outcome: "UNKNOWN" });
        res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `tap could not reach upstream: ${(error as Error).message}` } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    kind: "testnet",
    description: `Stellar testnet via a logging pass-through to ${upstream}`,
    url: `https://127.0.0.1:${port}`,
    cert,
    sendLog,
    async observe(hash): Promise<ChainObservation> {
      const sent = sendLog.some((e) => e.hash === hash && (e.outcome === "PENDING" || e.outcome === "DUPLICATE"));
      try {
        const response = await fetch(upstream, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash } }),
        });
        const status = ((await response.json()) as { result?: { status?: string } }).result?.status;
        if (status === "SUCCESS" || status === "FAILED") return { submitted: true, status };
        if (status === "NOT_FOUND") return { submitted: sent, status: "NOT_FOUND" };
        return { submitted: sent, status: "UNKNOWN" };
      } catch {
        return { submitted: sent, status: "UNKNOWN" };
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
