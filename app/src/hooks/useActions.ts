"use client";

import { useCallback, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CONFIG,
  MarketMeta,
  STOCK_DECIMALS,
  TOKEN_PROGRAM_ID,
  TREASURY,
  USDC_DECIMALS,
  USDC_MINT,
  getProgram,
  ownerAta,
  positionPda,
  priceUpdateAccount,
  toUnits,
  vaultAta,
} from "@/lib/program";

export function useActions(onDone: () => void) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      if (!wallet) return;
      setBusy(label);
      setError(null);
      try {
        const sig = await fn();
        await connection.confirmTransaction(sig, "confirmed");
        onDone();
      } catch (e: any) {
        setError(e?.error?.errorMessage ?? e?.message ?? String(e));
      } finally {
        setBusy(null);
      }
    },
    [wallet, connection, onDone]
  );

  const program = () => getProgram(connection, wallet);
  const owner = () => wallet!.publicKey;

  const faucet = (mint: PublicKey, amount: number, decimals: number) =>
    run("faucet", () =>
      program()
        .methods.mintMock(toUnits(amount, decimals))
        .accountsPartial({
          signer: owner(),
          config: CONFIG,
          mint,
          destination: ownerAta(mint, owner()),
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );

  const deposit = (m: MarketMeta, shares: number) =>
    run("deposit", () =>
      program()
        .methods.deposit(toUnits(shares, STOCK_DECIMALS))
        .accountsPartial({
          owner: owner(),
          stockMint: m.mint,
          market: m.market,
          vault: vaultAta(m.mint, m.market),
          ownerStock: ownerAta(m.mint, owner()),
          position: positionPda(owner(), m.market),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );

  const withdraw = (m: MarketMeta, shares: number) =>
    run("withdraw", () =>
      program()
        .methods.withdraw(toUnits(shares, STOCK_DECIMALS))
        .accountsPartial({
          owner: owner(),
          config: CONFIG,
          stockMint: m.mint,
          market: m.market,
          vault: vaultAta(m.mint, m.market),
          ownerStock: ownerAta(m.mint, owner()),
          position: positionPda(owner(), m.market),
          priceUpdate: priceUpdateAccount(m.feedId) as any,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc()
    );

  const borrow = (m: MarketMeta, amount: number) =>
    run("borrow", () =>
      program()
        .methods.borrow(toUnits(amount, USDC_DECIMALS))
        .accountsPartial({
          owner: owner(),
          config: CONFIG,
          usdcMint: USDC_MINT,
          treasury: TREASURY,
          ownerUsdc: ownerAta(USDC_MINT, owner()),
          market: m.market,
          position: positionPda(owner(), m.market),
          priceUpdate: priceUpdateAccount(m.feedId) as any,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );

  const repay = (m: MarketMeta, amount: number) =>
    run("repay", () =>
      program()
        .methods.repay(toUnits(amount, USDC_DECIMALS))
        .accountsPartial({
          owner: owner(),
          config: CONFIG,
          usdcMint: USDC_MINT,
          treasury: TREASURY,
          ownerUsdc: ownerAta(USDC_MINT, owner()),
          market: m.market,
          position: positionPda(owner(), m.market),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc()
    );

  return { busy, error, faucet, deposit, withdraw, borrow, repay, connected: !!wallet };
}
