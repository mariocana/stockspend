import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { RPC_URL } from "@/lib/program";
import { buildPayTransaction, parsePayParams } from "@/lib/pay";
import { refreshStalePrices } from "@/lib/crank";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { headers: cors });
}

function publicOrigin(req: NextRequest) {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const pay = parsePayParams(req.nextUrl.searchParams);
  const label = pay
    ? `${pay.label} · ${pay.amount} USDC · paid from your stocks via StockSpend`
    : "StockSpend";
  return NextResponse.json({ label, icon: `${publicOrigin(req)}/icon.svg` }, { headers: cors });
}

export async function POST(req: NextRequest) {
  const pay = parsePayParams(req.nextUrl.searchParams);
  if (!pay) return NextResponse.json({ error: "invalid payment request" }, { status: 400, headers: cors });
  let account: PublicKey;
  try {
    account = new PublicKey((await req.json()).account);
  } catch {
    return NextResponse.json({ error: "missing account" }, { status: 400, headers: cors });
  }
  try {
    const connection = new Connection(RPC_URL, "confirmed");
    await refreshStalePrices(connection).catch(() => null);
    const { tx, plan } = await buildPayTransaction(connection, account, pay);
    const transaction = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    const message =
      plan.shortfall > 0
        ? `Pay ${pay.amount} USDC · borrowing ${plan.shortfall.toFixed(2)} against ${plan.borrows.map((b) => b.market.symbol).join(", ")}`
        : `Pay ${pay.amount} USDC`;
    return NextResponse.json({ transaction, message }, { headers: cors });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "failed to build transaction" }, { status: 400, headers: cors });
  }
}
