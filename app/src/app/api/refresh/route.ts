import { NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { RPC_URL } from "@/lib/program";
import { refreshStalePrices } from "@/lib/crank";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await refreshStalePrices(new Connection(RPC_URL, "confirmed"));
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ refreshed: [], error: e?.message ?? String(e) }, { status: 500 });
  }
}
