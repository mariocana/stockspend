"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useSearchParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { fetchPortfolio, Portfolio } from "@/lib/portfolio";

export type { MarketView, Portfolio } from "@/lib/portfolio";

export function useViewedKey() {
  const params = useSearchParams();
  const { publicKey } = useWallet();
  const view = params.get("view");
  let viewed: PublicKey | null = null;
  if (!publicKey && view) {
    try {
      viewed = new PublicKey(view);
    } catch {}
  }
  return { owner: publicKey ?? viewed ?? undefined, readOnly: !publicKey && !!viewed };
}

export function usePortfolio() {
  const { connection } = useConnection();
  const { owner, readOnly } = useViewedKey();
  const [data, setData] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await fetch("/api/refresh").catch(() => null);
      setData(await fetchPortfolio(connection, owner));
    } finally {
      setLoading(false);
    }
  }, [connection, owner]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, refresh, readOnly };
}
