import { Connection, PublicKey } from "@solana/web3.js";
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
} from "./program";

export type MarketView = MarketMeta & {
  price: number;
  priceTime: number;
  walletShares: number;
  collateralShares: number;
  debtUsdc: number;
  collateralValue: number;
  maxDebt: number;
  room: number;
};

export type Portfolio = {
  markets: MarketView[];
  walletUsdc: number;
  totalCollateral: number;
  totalDebt: number;
  totalMaxDebt: number;
  available: number;
};

export async function tokenBalance(connection: Connection, ata: PublicKey, decimals: number) {
  try {
    const acc = await getAccount(connection, ata);
    return fromUnits(acc.amount, decimals);
  } catch {
    return 0;
  }
}

export async function fetchPortfolio(connection: Connection, owner?: PublicKey): Promise<Portfolio> {
  const program = getProgram(connection);
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
      const maxDebt = (collateralValue * LTV_BPS) / 10_000;
      return { ...m, price, priceTime, walletShares, collateralShares, debtUsdc, collateralValue, maxDebt, room: Math.max(0, maxDebt - debtUsdc) };
    })
  );
  const walletUsdc = owner ? await tokenBalance(connection, ownerAta(USDC_MINT, owner), USDC_DECIMALS) : 0;
  const totalCollateral = markets.reduce((s, m) => s + m.collateralValue, 0);
  const totalDebt = markets.reduce((s, m) => s + m.debtUsdc, 0);
  const totalMaxDebt = markets.reduce((s, m) => s + m.maxDebt, 0);
  return { markets, walletUsdc, totalCollateral, totalDebt, totalMaxDebt, available: Math.max(0, totalMaxDebt - totalDebt) };
}
