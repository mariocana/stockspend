"use client";

import { MarketView } from "@/hooks/usePortfolio";
import { AmountAction } from "./AmountAction";
import { usd } from "@/lib/program";

type Props = {
  m: MarketView;
  connected: boolean;
  busy: string | null;
  onFaucet: () => void;
  onDeposit: (n: number) => void;
  onWithdraw: (n: number) => void;
  onBorrow: (n: number) => void;
  onRepay: (n: number) => void;
  walletUsdc: number;
};

function ago(ts: number) {
  if (!ts) return "no price";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function MarketCard({ m, connected, busy, onFaucet, onDeposit, onWithdraw, onBorrow, onRepay, walletUsdc }: Props) {
  const borrowRoom = Math.max(0, m.maxDebt - m.debtUsdc);
  const freeShares = m.price > 0 ? Math.max(0, m.collateralShares - m.debtUsdc / (m.price * 0.5)) : 0;
  const usage = m.maxDebt > 0 ? Math.min(100, (m.debtUsdc / m.maxDebt) * 100) : 0;
  const disabled = !connected;

  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
      <header className="mb-4 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{m.symbol}</h2>
            <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
              {m.feedId ? "pyth" : "mock"}
            </span>
          </div>
          <p className="text-sm text-[var(--muted)]">{m.name}</p>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tabular-nums">{usd(m.price)}</div>
          <div className="text-xs text-[var(--muted)]">{ago(m.priceTime)}</div>
        </div>
      </header>

      <dl className="mb-4 grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs text-[var(--muted)]">In wallet</dt>
          <dd className="tabular-nums">{m.walletShares.toLocaleString("en-US", { maximumFractionDigits: 4 })}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--muted)]">Collateral</dt>
          <dd className="tabular-nums">
            {m.collateralShares.toLocaleString("en-US", { maximumFractionDigits: 4 })}
            <span className="ml-1 text-xs text-[var(--muted)]">{usd(m.collateralValue)}</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--muted)]">Borrowed</dt>
          <dd className="tabular-nums">{usd(m.debtUsdc)}</dd>
        </div>
      </dl>

      <div className="mb-5">
        <div className="mb-1 flex justify-between text-xs text-[var(--muted)]">
          <span>LTV usage</span>
          <span>{usage.toFixed(0)}% · room {usd(borrowRoom)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${usage}%`, background: usage > 90 ? "var(--danger)" : "var(--accent)" }}
          />
        </div>
      </div>

      <div className="space-y-5">
        <AmountAction label="Deposit" unit={m.symbol} max={m.walletShares} disabled={disabled} busy={busy === "deposit"} onSubmit={onDeposit} />
        <AmountAction label="Borrow" unit="USDC" max={borrowRoom} disabled={disabled || borrowRoom <= 0} busy={busy === "borrow"} tone="accent" onSubmit={onBorrow} />
        <AmountAction label="Repay" unit="USDC" max={Math.min(m.debtUsdc, walletUsdc)} disabled={disabled || m.debtUsdc <= 0} busy={busy === "repay"} onSubmit={onRepay} />
        <AmountAction label="Withdraw" unit={m.symbol} max={freeShares} disabled={disabled || freeShares <= 0} busy={busy === "withdraw"} onSubmit={onWithdraw} />
      </div>

      <button
        onClick={onFaucet}
        disabled={disabled || busy === "faucet"}
        className="mt-5 w-full rounded-lg border border-dashed border-[var(--border)] py-2 text-xs text-[var(--muted)] hover:border-[var(--accent2)] hover:text-[var(--text)] disabled:opacity-40"
      >
        {busy === "faucet" ? "minting…" : `faucet · get 10 ${m.symbol} (devnet)`}
      </button>
    </section>
  );
}
