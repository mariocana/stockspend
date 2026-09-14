"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { PayPlan, buildPayTransaction, parsePayParams, planPayment } from "@/lib/pay";
import { Portfolio, fetchPortfolio } from "@/lib/portfolio";
import { usd } from "@/lib/program";
import { useViewedKey } from "@/hooks/usePortfolio";

const WalletButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), { ssr: false });

export default function CheckoutPage() {
  return (
    <Suspense>
      <Checkout />
    </Suspense>
  );
}

function Checkout() {
  const params = useSearchParams();
  const req = useMemo(() => parsePayParams(params), [params]);
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { owner, readOnly } = useViewedKey();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [preferred, setPreferred] = useState<string | undefined>(undefined);
  const [state, setState] = useState<"idle" | "signing" | "confirming" | "done">("idle");
  const [sig, setSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!req || !owner) return setPortfolio(null);
    fetchPortfolio(connection, owner).then(setPortfolio);
  }, [req, owner, connection]);

  const plan: PayPlan | null = useMemo(() => (req && portfolio ? planPayment(portfolio, req.amount, preferred) : null), [req, portfolio, preferred]);
  const choices = useMemo(() => (portfolio ? portfolio.markets.filter((m) => m.room > 0).sort((a, b) => b.room - a.room) : []), [portfolio]);

  const pay = async () => {
    if (!req || !publicKey) return;
    setError(null);
    try {
      setState("signing");
      await fetch("/api/refresh").catch(() => null);
      const { tx, lastValidBlockHeight } = await buildPayTransaction(connection, publicKey, req, preferred);
      const s = await sendTransaction(tx, connection);
      setState("confirming");
      await connection.confirmTransaction({ signature: s, blockhash: tx.recentBlockhash!, lastValidBlockHeight }, "confirmed");
      setSig(s);
      setState("done");
    } catch (e: any) {
      setError(e?.error?.errorMessage ?? e?.message ?? String(e));
      setState("idle");
    }
  };

  if (!req) return <Shell><p className="text-sm text-[var(--danger)]">Invalid payment link.</p></Shell>;

  return (
    <Shell>
      <div className="mx-auto max-w-md space-y-5">
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6 text-center">
          <div className="text-xs uppercase tracking-wide text-[var(--muted)]">{req.label}</div>
          <div className="mt-2 text-4xl font-bold tabular-nums">{usd(req.amount)}</div>
          <div className="mt-1 font-mono text-[10px] text-[var(--muted)]">to {req.recipient.toBase58().slice(0, 4)}…{req.recipient.toBase58().slice(-4)}</div>
        </section>

        {state === "done" ? (
          <section className="rounded-2xl border border-[var(--accent)]/40 bg-[var(--accent)]/10 p-6 text-center">
            <div className="text-3xl">✅</div>
            <div className="mt-2 font-semibold" style={{ color: "var(--accent)" }}>Paid. Your stocks are still yours.</div>
            <a href={`https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(connection.rpcEndpoint)}`} target="_blank" className="mt-2 block break-all font-mono text-[10px] text-[var(--muted)] hover:text-[var(--text)]">{sig}</a>
            <Link href="/" className="mt-4 inline-block text-sm text-[var(--muted)] hover:text-[var(--text)]">← back to portfolio</Link>
          </section>
        ) : !owner ? (
          <div className="flex justify-center"><WalletButton /></div>
        ) : !plan ? (
          <p className="text-center text-sm text-[var(--muted)]">Checking your portfolio…</p>
        ) : (
          <section className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
            <Row label="USDC in wallet" value={usd(plan.walletUsdc)} />
            {plan.shortfall > 0 ? (
              <>
                <Row label="Shortfall" value={usd(plan.shortfall)} />
                <div className="rounded-xl border border-[var(--accent2)]/40 bg-[var(--accent2)]/10 p-3 text-sm">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="font-semibold">Borrow against</span>
                    {choices.length > 1 ? (
                      <select
                        value={preferred ?? choices[0].symbol}
                        onChange={(e) => setPreferred(e.target.value)}
                        className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm outline-none focus:border-[var(--accent2)]"
                      >
                        {choices.map((m) => (
                          <option key={m.symbol} value={m.symbol}>
                            {m.symbol} · {usd(m.room)} available
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-[var(--muted)]">{choices[0]?.symbol ?? "—"}</span>
                    )}
                  </div>
                  {plan.borrows.map((b) => (
                    <div key={b.market.symbol} className="flex justify-between text-[var(--muted)]">
                      <span>{usd(b.amount)} from {b.market.symbol}</span>
                      <span>{b.market.collateralShares.toLocaleString("en-US", { maximumFractionDigits: 4 })} shares stay yours</span>
                    </div>
                  ))}
                  {!plan.ok && <div className="mt-2 text-[var(--danger)]">{plan.reason}</div>}
                </div>
              </>
            ) : (
              <div className="text-sm text-[var(--muted)]">Enough USDC in wallet, no borrowing needed.</div>
            )}
            {error && <div className="text-sm text-[var(--danger)]">{error}</div>}
            <button
              onClick={pay}
              disabled={!plan.ok || state !== "idle" || readOnly}
              className="w-full rounded-lg bg-[var(--accent)] py-3 text-sm font-semibold text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {state === "signing" ? "Waiting for wallet…" : state === "confirming" ? "Confirming…" : plan.shortfall > 0 ? `Borrow & pay ${usd(req.amount)}` : `Pay ${usd(req.amount)}`}
            </button>
            <div className="text-center text-[10px] text-[var(--muted)]">One transaction: borrow + transfer. No sale, no taxable event.</div>
          </section>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Stock<span style={{ color: "var(--accent)" }}>Spend</span> checkout</h1>
        <Link href="/merchant" className="text-xs text-[var(--muted)] hover:text-[var(--text)]">merchant →</Link>
      </header>
      {children}
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-[var(--muted)]">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
