import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Address, BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { XLM_SAC_TESTNET } from "@stellar/mpp";
import { startFakeChain, type FakeChain } from "../src/chain/fake-rpc.ts";

// The stub is held to two Stellar rules that exist independently of this repository:
// a transaction needs sequence = account sequence + 1, and a confirmed transaction cannot be applied twice.
let chain: FakeChain;
let server: rpc.Server;
const payer = Keypair.random();
const recipient = Keypair.random().publicKey();

async function signedTransfer(): Promise<ReturnType<TransactionBuilder["build"]>> {
  const account = await server.getAccount(payer.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: "Test SDF Network ; September 2015" })
    .addOperation(new Contract(XLM_SAC_TESTNET).call("transfer", new Address(payer.publicKey()).toScVal(), new Address(recipient).toScVal(), nativeToScVal(100000n, { type: "i128" })))
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(payer);
  return prepared;
}

beforeAll(async () => {
  chain = await startFakeChain();
  server = new rpc.Server(chain.url, { allowHttp: false });
});
afterAll(async () => chain.close());

describe("stub chain", () => {
  it("serves an account sequence and applies the sequence rule", async () => {
    const tx = await signedTransfer();
    const first = await server.sendTransaction(tx);
    expect(first.status).toBe("PENDING");
    const again = await server.sendTransaction(tx);
    expect(again.status).toBe("ERROR");
    const next = await signedTransfer();
    expect(BigInt(next.sequence)).toBe(BigInt(tx.sequence) + 1n);
  });

  it("confirms immediately by default and reports the envelope", async () => {
    const tx = await signedTransfer();
    const sent = await server.sendTransaction(tx);
    const got = await server.getTransaction(sent.hash);
    expect(got.status).toBe("SUCCESS");
    expect(chain.lookup(sent.hash)?.status).toBe("SUCCESS");
  });

  it("holds a transaction as NOT_FOUND until it is landed, then answers SUCCESS", async () => {
    chain.faults.land = "manual";
    const tx = await signedTransfer();
    const sent = await server.sendTransaction(tx);
    expect((await server.getTransaction(sent.hash)).status).toBe("NOT_FOUND");
    expect(await chain.observe(sent.hash)).toEqual({ submitted: true, status: "NOT_FOUND" });
    chain.land(sent.hash);
    expect((await server.getTransaction(sent.hash)).status).toBe("SUCCESS");
    chain.faults.land = "immediate";
  });

  it("answers a synchronous ERROR without consuming the sequence number when send=error", async () => {
    chain.faults.send = "error";
    const tx = await signedTransfer();
    const sent = await server.sendTransaction(tx);
    expect(sent.status).toBe("ERROR");
    chain.faults.send = "ok";
    expect((await server.sendTransaction(tx)).status).toBe("PENDING");
  });

  it("records every sendTransaction in the send log with the node's answer", () => {
    const outcomes = new Set(chain.sendLog.map((e) => e.outcome));
    expect(outcomes.has("PENDING")).toBe(true);
    expect(outcomes.has("ERROR")).toBe(true);
  });

  it("does not implement the sponsored path and says so", async () => {
    await expect(server.getLatestLedger()).rejects.toBeDefined();
  });
});

