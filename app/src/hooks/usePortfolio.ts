"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { fetchPortfolio, Portfolio } from "@/lib/portfolio";

export type { MarketView, Portfolio } from "@/lib/portfolio";

export function usePortfolio() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [data, setData] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchPortfolio(connection, publicKey ?? undefined));
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, refresh };
}
