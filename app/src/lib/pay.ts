import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CONFIG,
  TOKEN_PROGRAM_ID,
  TREASURY,
  USDC_DECIMALS,
  USDC_MINT,
  getProgram,
  ownerAta,
  positionPda,
  priceUpdateAccount,
  toUnits,
} from "./program";
import { fetchPortfolio, MarketView, Portfolio } from "./portfolio";

export const DEMO_MERCHANT = "3h4jhpCW4JdYkJWqHiuq6MBUGdYADiAsYcEVqSKrGSny";

export type PayRequest = {
  recipient: PublicKey;
  amount: number;
  reference: PublicKey;
  label: string;
};

export type PayPlan = {
  amount: number;
  walletUsdc: number;
  shortfall: number;
  borrows: { market: MarketView; amount: number }[];
  ok: boolean;
  reason?: string;
};

export function parsePayParams(params: URLSearchParams): PayRequest | null {
  try {
    const recipient = new PublicKey(params.get("recipient") ?? "");
    const reference = new PublicKey(params.get("reference") ?? "");
    const amount = parseFloat(params.get("amount") ?? "");
    if (!(amount > 0)) return null;
    return { recipient, reference, amount, label: params.get("label") ?? "Payment" };
  } catch {
    return null;
  }
}

export function payQuery(req: PayRequest) {
  return new URLSearchParams({
    recipient: req.recipient.toBase58(),
    amount: req.amount.toString(),
    reference: req.reference.toBase58(),
    label: req.label,
  }).toString();
}

export function solanaPayUrl(origin: string, req: PayRequest) {
  return `solana:${encodeURIComponent(`${origin}/api/pay?${payQuery(req)}`)}`;
}

export function planPayment(p: Portfolio, amount: number): PayPlan {
  const shortfall = Math.max(0, +(amount - p.walletUsdc).toFixed(6));
  const borrows: PayPlan["borrows"] = [];
  let left = shortfall;
  for (const m of [...p.markets].sort((a, b) => b.room - a.room)) {
    if (left <= 0) break;
    const take = Math.min(left, Math.floor(m.room * 1e6) / 1e6);
    if (take > 0) {
      borrows.push({ market: m, amount: take });
      left = +(left - take).toFixed(6);
    }
  }
  const ok = left <= 0;
  return {
    amount,
    walletUsdc: p.walletUsdc,
    shortfall,
    borrows,
    ok,
    reason: ok ? undefined : `Need ${shortfall.toFixed(2)} USDC but only ${p.available.toFixed(2)} available against your portfolio`,
  };
}

export async function buildPayTransaction(connection: Connection, payer: PublicKey, req: PayRequest) {
  const portfolio = await fetchPortfolio(connection, payer);
  const plan = planPayment(portfolio, req.amount);
  if (!plan.ok) throw new Error(plan.reason);

  const program = getProgram(connection);
  const ixs: TransactionInstruction[] = [];
  const payerUsdc = ownerAta(USDC_MINT, payer);

  for (const b of plan.borrows) {
    ixs.push(
      await program.methods
        .borrow(toUnits(b.amount, USDC_DECIMALS))
        .accountsPartial({
          owner: payer,
          config: CONFIG,
          usdcMint: USDC_MINT,
          treasury: TREASURY,
          ownerUsdc: payerUsdc,
          market: b.market.market,
          position: positionPda(payer, b.market.market),
          priceUpdate: priceUpdateAccount(b.market.feedId) as any,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    );
  }

  const recipientUsdc = getAssociatedTokenAddressSync(USDC_MINT, req.recipient, true);
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(payer, recipientUsdc, req.recipient, USDC_MINT));
  const transfer = createTransferCheckedInstruction(
    payerUsdc,
    USDC_MINT,
    recipientUsdc,
    payer,
    BigInt(toUnits(req.amount, USDC_DECIMALS).toString()),
    USDC_DECIMALS
  );
  transfer.keys.push({ pubkey: req.reference, isSigner: false, isWritable: false });
  ixs.push(transfer);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(...ixs);
  return { tx, plan, lastValidBlockHeight };
}

export async function findPayment(connection: Connection, reference: PublicKey) {
  const sigs = await connection.getSignaturesForAddress(reference, { limit: 1 }, "confirmed");
  return sigs[0]?.signature ?? null;
}
