"use client";

import { useCallback, useEffect, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import {
  MARKETS,
  MarketMeta,
  LTV_BPS,
  USDC_MINT,
  USDC_DECIMALS,
  STOCK_DECIMALS,
  getProgram,
  ownerAta,
  positionPda,
  fromUnits,
  readPythPrice,
} from "@/lib/program";

export type MarketView = MarketMeta & {
  price: number;
  priceTime: number;
  walletShares: number;
  collateralShares: number;
  debtUsdc: number;
  collateralValue: number;
  maxDebt: number;
};

export type Portfolio = {
  markets: MarketView[];
  walletUsdc: number;
  totalCollateral: number;
  totalDebt: number;
  totalMaxDebt: number;
  available: number;
};

async function tokenBalance(connection: any, ata: PublicKey, decimals: number) {
  try {
    const acc = await getAccount(connection, ata);
    return fromUnits(acc.amount, decimals);
  } catch {
    return 0;
  }
}

export function usePortfolio() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const [data, setData] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const program = getProgram(connection, wallet);
      const owner = wallet?.publicKey;
      const markets: MarketView[] = await Promise.all(
        MARKETS.map(async (m) => {
          const acc: any = await (program.account as any).market.fetch(m.market);
          const pyth = m.feedId ? await readPythPrice(connection, m.feedId) : null;
          const price = pyth ? pyth.price : fromUnits(acc.price, 6);
          const priceTime = pyth ? pyth.publishTime : Number(acc.priceUpdatedAt);
          const walletShares = owner ? await tokenBalance(connection, ownerAta(m.mint, owner), STOCK_DECIMALS) : 0;
          let collateralShares = 0;
          let debtUsdc = 0;
          if (owner) {
            const pos: any = await (program.account as any).position.fetchNullable(positionPda(owner, m.market));
            if (pos) {
              collateralShares = fromUnits(pos.collateral, STOCK_DECIMALS);
              debtUsdc = fromUnits(pos.debt, USDC_DECIMALS);
            }
          }
          const collateralValue = collateralShares * price;
          return { ...m, price, priceTime, walletShares, collateralShares, debtUsdc, collateralValue, maxDebt: (collateralValue * LTV_BPS) / 10_000 };
        })
      );
      const walletUsdc = owner ? await tokenBalance(connection, ownerAta(USDC_MINT, owner), USDC_DECIMALS) : 0;
      const totalCollateral = markets.reduce((s, m) => s + m.collateralValue, 0);
      const totalDebt = markets.reduce((s, m) => s + m.debtUsdc, 0);
      const totalMaxDebt = markets.reduce((s, m) => s + m.maxDebt, 0);
      setData({ markets, walletUsdc, totalCollateral, totalDebt, totalMaxDebt, available: Math.max(0, totalMaxDebt - totalDebt) });
    } finally {
      setLoading(false);
    }
  }, [connection, wallet]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, refresh };
}
