"use client";

import dynamic from "next/dynamic";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useActions } from "@/hooks/useActions";
import { MarketCard } from "@/components/MarketCard";
import { Summary } from "@/components/Summary";
import { STOCK_DECIMALS, USDC_DECIMALS, USDC_MINT } from "@/lib/program";

const WalletButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), { ssr: false });

export default function Home() {
  const { data, loading, refresh } = usePortfolio();
  const a = useActions(refresh);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Stock<span style={{ color: "var(--accent)" }}>Spend</span>
          </h1>
          <p className="text-sm text-[var(--muted)]">Spend your stocks without selling them.</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={refresh} disabled={loading} className="text-xs text-[var(--muted)] hover:text-[var(--text)] disabled:opacity-40">
            {loading ? "refreshing…" : "refresh"}
          </button>
          <WalletButton />
        </div>
      </header>

      {a.error && (
        <div className="mb-6 rounded-xl border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-4 py-3 text-sm text-[var(--danger)]">{a.error}</div>
      )}

      {!data ? (
        <p className="text-sm text-[var(--muted)]">Loading markets…</p>
      ) : (
        <div className="space-y-6">
          <Summary p={data} connected={a.connected} busy={a.busy} onFaucetUsdc={() => a.faucet(USDC_MINT, 1000, USDC_DECIMALS)} />
          <div className="grid gap-6 md:grid-cols-2">
            {data.markets.map((m) => (
              <MarketCard
                key={m.symbol}
                m={m}
                connected={a.connected}
                busy={a.busy}
                walletUsdc={data.walletUsdc}
                onFaucet={() => a.faucet(m.mint, 10, STOCK_DECIMALS)}
                onDeposit={(n) => a.deposit(m, n)}
                onWithdraw={(n) => a.withdraw(m, n)}
                onBorrow={(n) => a.borrow(m, n)}
                onRepay={(n) => a.repay(m, n)}
              />
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
