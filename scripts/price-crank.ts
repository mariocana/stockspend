import * as anchor from "@coral-xyz/anchor";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { HermesClient } from "@pythnetwork/hermes-client";

const FEEDS: Record<string, string> = {
  TSLA: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
  AAPL: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
};
const SHARD = 0;

async function crank(receiver: PythSolanaReceiver, hermes: HermesClient) {
  const ids = Object.values(FEEDS);
  const latest = await hermes.getLatestPriceUpdates(ids, { encoding: "base64" });
  for (const p of latest.parsed ?? []) {
    const sym = Object.keys(FEEDS).find((k) => FEEDS[k] === p.id) ?? p.id.slice(0, 6);
    const price = Number(p.price.price) * 10 ** p.price.expo;
    console.log(`${sym} $${price.toFixed(2)} published ${new Date(p.price.publish_time * 1000).toISOString()}`);
  }
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addUpdatePriceFeed(latest.binary.data, SHARD);
  const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50_000 });
  const sigs = await receiver.provider.sendAll(txs, { skipPreflight: false });
  console.log(`updated ${ids.length} feeds in ${sigs.length} tx:`, sigs.map((s) => s.slice(0, 8)).join(" "));
  for (const [sym, id] of Object.entries(FEEDS)) {
    console.log(`  ${sym} → ${receiver.getPriceFeedAccountAddress(SHARD, id).toBase58()}`);
  }
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  const receiver = new PythSolanaReceiver({ connection: provider.connection, wallet: provider.wallet as anchor.Wallet });
  const key = process.env.PYTH_API_KEY;
  if (!key) throw new Error("PYTH_API_KEY is required (https://pythdata.app/signup)");
  const hermes = new HermesClient(process.env.HERMES_URL ?? "https://pyth.dourolabs.app/hermes", {
    headers: { Authorization: `Bearer ${key}` },
  });
  const every = Number(process.env.EVERY ?? 0);
  console.log(`cluster ${provider.connection.rpcEndpoint} · payer ${provider.wallet.publicKey.toBase58()}`);
  do {
    try {
      await crank(receiver, hermes);
    } catch (e: any) {
      console.error("crank failed:", e?.message ?? e);
    }
    if (every > 0) await new Promise((r) => setTimeout(r, every * 1000));
  } while (every > 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
