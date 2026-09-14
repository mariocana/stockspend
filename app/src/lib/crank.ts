import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { CONFIG, MARKETS, getProgram } from "./program";
import addresses from "./addresses.json";

const REFRESH_AFTER_SECS = 20 * 60;

function adminKeypair() {
  const raw = process.env.ADMIN_KEYPAIR;
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    return null;
  }
}

export async function refreshStalePrices(connection: Connection) {
  const admin = adminKeypair();
  if (!admin) return { refreshed: [], reason: "no ADMIN_KEYPAIR" };
  const program = getProgram(connection);
  const now = Math.floor(Date.now() / 1000);
  const mock = MARKETS.filter((m) => !m.feedId);
  const stale: typeof mock = [];
  for (const m of mock) {
    const acc: any = await (program.account as any).market.fetch(m.market);
    if (now - Number(acc.priceUpdatedAt) > REFRESH_AFTER_SECS) stale.push(m);
  }
  if (stale.length === 0) return { refreshed: [], reason: "fresh" };

  const mints = stale.map((m) => (addresses.markets as any)[m.symbol].mainnetMint);
  const res: any = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mints.join(",")}`).then((r) => r.json());
  const tx = new Transaction();
  const refreshed: string[] = [];
  for (const m of stale) {
    const usd = Number(res[(addresses.markets as any)[m.symbol].mainnetMint]?.usdPrice);
    if (!(usd > 0)) continue;
    tx.add(
      await program.methods
        .updatePrice(new BN(Math.round(usd * 1e6)))
        .accountsPartial({ admin: admin.publicKey, config: CONFIG, market: new PublicKey(m.market) })
        .instruction()
    );
    refreshed.push(`${m.symbol} $${usd.toFixed(2)}`);
  }
  if (tx.instructions.length === 0) return { refreshed: [], reason: "no jupiter price" };
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = admin.publicKey;
  tx.sign(admin);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return { refreshed, signature: sig };
}
