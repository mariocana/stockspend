import { AnchorProvider, BN, Program, Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "./idl.json";
import addresses from "./addresses.json";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? addresses.cluster;
export const PROGRAM_ID = new PublicKey(addresses.programId);
export const CONFIG = new PublicKey(addresses.config);
export const USDC_MINT = new PublicKey(addresses.usdcMint);
export const TREASURY = new PublicKey(addresses.treasury);
export const LTV_BPS = addresses.ltvBps;
export const USDC_DECIMALS = 6;
export const STOCK_DECIMALS = 8;

const PYTH_PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");

export type MarketMeta = {
  symbol: string;
  name: string;
  mint: PublicKey;
  market: PublicKey;
  feedId: string | null;
  source: string;
};

export const MARKETS: MarketMeta[] = Object.entries(addresses.markets).map(([symbol, m]) => ({
  symbol,
  name: m.name,
  mint: new PublicKey(m.mint),
  market: new PublicKey(m.market),
  feedId: m.feedId,
  source: (m as any).source ?? (m.feedId ? "pyth" : "mock"),
}));

export function getProgram(connection: Connection, wallet?: AnchorWallet) {
  const provider = new AnchorProvider(
    connection,
    wallet ?? ({ publicKey: PublicKey.default, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any),
    { commitment: "confirmed" }
  );
  return new Program(idl as Idl, provider);
}

export function positionPda(owner: PublicKey, market: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("position"), owner.toBuffer(), market.toBuffer()], PROGRAM_ID)[0];
}

export function vaultAta(mint: PublicKey, market: PublicKey) {
  return getAssociatedTokenAddressSync(mint, market, true);
}

export function ownerAta(mint: PublicKey, owner: PublicKey) {
  return getAssociatedTokenAddressSync(mint, owner);
}

export function priceUpdateAccount(feedId: string | null) {
  if (!feedId) return null;
  const shard = Buffer.alloc(2);
  return PublicKey.findProgramAddressSync([shard, Buffer.from(feedId, "hex")], PYTH_PUSH_ORACLE)[0];
}

export function toUnits(amount: number, decimals: number) {
  return new BN(Math.round(amount * 10 ** decimals));
}

export function fromUnits(raw: BN | bigint | number, decimals: number) {
  return Number(raw.toString()) / 10 ** decimals;
}

export const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID };

export async function readPythPrice(connection: Connection, feedId: string) {
  const account = priceUpdateAccount(feedId)!;
  const info = await connection.getAccountInfo(account);
  if (!info) return { price: 0, publishTime: 0 };
  const d = info.data;
  const vlLen = d[40] === 1 ? 1 : 2;
  const off = 8 + 32 + vlLen + 32;
  const raw = Number(d.readBigInt64LE(off));
  const expo = d.readInt32LE(off + 16);
  const publishTime = Number(d.readBigInt64LE(off + 20));
  return { price: raw * 10 ** expo, publishTime };
}
