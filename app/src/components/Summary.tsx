"use client";

import { Portfolio } from "@/hooks/usePortfolio";
import { usd } from "@/lib/program";

export function Summary({ p, onFaucetUsdc, busy, connected }: { p: Portfolio; onFaucetUsdc: () => void; busy: string | null; connected: boolean }) {
  const health = p.totalDebt > 0 ? p.totalMaxDebt / p.totalDebt : Infinity;
  const tiles = [
    { label: "Portfolio value", value: usd(p.totalCollateral) },
    { label: "Borrowed", value: usd(p.totalDebt) },
    { label: "Available to spend", value: usd(p.available), accent: true },
    { label: "Health", value: health === Infinity ? "∞" : health.toFixed(2) + "×", danger: health < 1.1 },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4">
          <div className="text-xs text-[var(--muted)]">{t.label}</div>
          <div
            className="mt-1 text-xl font-semibold tabular-nums"
            style={{ color: t.accent ? "var(--accent)" : t.danger ? "var(--danger)" : undefined }}
          >
            {t.value}
          </div>
        </div>
      ))}
      <div className="col-span-2 flex items-center justify-between rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 md:col-span-4">
        <div>
          <div className="text-xs text-[var(--muted)]">USDC in wallet</div>
          <div className="text-lg font-semibold tabular-nums">{usd(p.walletUsdc)}</div>
        </div>
        <button
          onClick={onFaucetUsdc}
          disabled={!connected || busy === "faucet"}
          className="rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)] hover:border-[var(--accent2)] hover:text-[var(--text)] disabled:opacity-40"
        >
          faucet · 1,000 USDC
        </button>
      </div>
    </div>
  );
}
