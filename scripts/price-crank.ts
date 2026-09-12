import * as anchor from "@coral-xyz/anchor";
import { Program, BN, Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { HermesClient } from "@pythnetwork/hermes-client";
import idl from "../app/src/lib/idl.json";
import addresses from "../app/src/lib/addresses.json";

const SHARD = 0;
const markets = Object.entries(addresses.markets) as [string, any][];
const FEEDS: Record<string, string> = Object.fromEntries(markets.filter(([, m]) => m.feedId).map(([sym, m]) => [sym, m.feedId]));

async function crankJupiter(provider: anchor.AnchorProvider) {
  const program = new Program(idl as Idl, provider);
  const config = new PublicKey(addresses.config);
  const mock = markets.filter(([, m]) => !m.feedId);
  const ids = mock.map(([, m]) => m.mainnetMint).join(",");
  const res: any = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`).then((r) => r.json());
  for (const [sym, m] of mock) {
    const usd = Number(res[m.mainnetMint]?.usdPrice);
    if (!(usd > 0)) {
      console.log(`${sym}: no Jupiter price`);
      continue;
    }
    const sig = await program.methods
      .updatePrice(new BN(Math.round(usd * 1e6)))
      .accountsPartial({ admin: provider.wallet.publicKey, config, market: new PublicKey(m.market) })
      .rpc();
    console.log(`${sym} $${usd.toFixed(2)} → ${sig.slice(0, 8)}`);
  }
}

async function crankPyth(receiver: PythSolanaReceiver, hermes: HermesClient) {
  const ids = Object.values(FEEDS);
  if (ids.length === 0) return console.log("no pyth markets in addresses.json");
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
  const hasPyth = Object.keys(FEEDS).length > 0;
  const hasJupiter = markets.some(([, m]) => !m.feedId);
  let receiver: PythSolanaReceiver | undefined;
  let hermes: HermesClient | undefined;
  if (hasPyth) {
    const key = process.env.PYTH_API_KEY;
    if (!key) throw new Error("PYTH_API_KEY is required (https://pythdata.app/signup)");
    receiver = new PythSolanaReceiver({ connection: provider.connection, wallet: provider.wallet as anchor.Wallet });
    hermes = new HermesClient(process.env.HERMES_URL ?? "https://pyth.dourolabs.app/hermes", {
      headers: { Authorization: `Bearer ${key}` },
    });
  }
  const every = Number(process.env.EVERY ?? 0);
  console.log(`cluster ${provider.connection.rpcEndpoint} · payer ${provider.wallet.publicKey.toBase58()} · sources: ${[hasPyth && "pyth", hasJupiter && "jupiter"].filter(Boolean).join(", ")}`);
  do {
    try {
      if (hasJupiter) await crankJupiter(provider);
      if (hasPyth) await crankPyth(receiver!, hermes!);
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
