"use client";

import { useEffect, useState } from "react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import QRCode from "qrcode";
import Link from "next/link";
import { DEMO_MERCHANT, PayRequest, findPayment, payQuery, phantomBrowseUrl, solanaPayUrl } from "@/lib/pay";
import { USDC_DECIMALS, USDC_MINT, ownerAta, usd } from "@/lib/program";
import { tokenBalance } from "@/lib/portfolio";

export default function Merchant() {
  const { connection } = useConnection();
  const [amount, setAmount] = useState("4.50");
  const [label, setLabel] = useState("Café Solana · flat white");
  const [recipient, setRecipient] = useState(DEMO_MERCHANT);
  const [req, setReq] = useState<PayRequest | null>(null);
  const [mode, setMode] = useState<"pay" | "checkout">("pay");
  const [qr, setQr] = useState<string>("");
  const [paid, setPaid] = useState<string | null>(null);
  const [balance, setBalance] = useState(0);

  const create = async () => {
    try {
      const r: PayRequest = { recipient: new PublicKey(recipient), amount: parseFloat(amount), reference: Keypair.generate().publicKey, label };
      setReq(r);
      setPaid(null);
    } catch (e) {
      alert(String(e));
    }
  };

  useEffect(() => {
    if (!req) return;
    const url = mode === "pay" ? solanaPayUrl(window.location.origin, req) : phantomBrowseUrl(window.location.origin, req);
    QRCode.toDataURL(url, { margin: 1, width: 280, color: { dark: "#000000", light: "#ffffff" } }).then(setQr);
  }, [req, mode]);

  useEffect(() => {
    if (!req || paid) return;
    const t = setInterval(async () => {
      const sig = await findPayment(connection, req.reference);
      if (sig) {
        setPaid(sig);
        setBalance(await tokenBalance(connection, ownerAta(USDC_MINT, req.recipient), USDC_DECIMALS));
      }
    }, 2000);
    return () => clearInterval(t);
  }, [req, paid, connection]);

  useEffect(() => {
    try {
      tokenBalance(connection, ownerAta(USDC_MINT, new PublicKey(recipient)), USDC_DECIMALS).then(setBalance);
    } catch {}
  }, [connection, recipient, paid]);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Merchant</h1>
          <p className="text-sm text-[var(--muted)]">Create a Solana Pay request. Customers pay in USDC, straight from their stocks.</p>
        </div>
        <Link href="/" className="text-xs text-[var(--muted)] hover:text-[var(--text)]">← portfolio</Link>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
          <Field label="Amount (USDC)"><input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" step="any" className={inputCls} /></Field>
          <Field label="Label"><input value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls} /></Field>
          <Field label="Recipient wallet"><input value={recipient} onChange={(e) => setRecipient(e.target.value)} className={inputCls + " font-mono text-xs"} /></Field>
          <div className="text-xs text-[var(--muted)]">Recipient USDC balance: <span className="text-[var(--text)]">{usd(balance)}</span></div>
          <button onClick={create} className="w-full rounded-lg bg-[var(--accent)] py-2 text-sm font-semibold text-black hover:opacity-90">
            Create payment request
          </button>
        </section>

        <section className="flex flex-col items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5 text-center">
          {!req ? (
            <p className="text-sm text-[var(--muted)]">The QR code will appear here.</p>
          ) : paid ? (
            <div className="space-y-2">
              <div className="text-4xl">✅</div>
              <div className="text-lg font-semibold" style={{ color: "var(--accent)" }}>Paid {usd(req.amount)}</div>
              <a href={`https://explorer.solana.com/tx/${paid}?cluster=custom&customUrl=${encodeURIComponent(connection.rpcEndpoint)}`} target="_blank" className="block break-all font-mono text-[10px] text-[var(--muted)] hover:text-[var(--text)]">
                {paid}
              </a>
            </div>
          ) : (
            <div className="space-y-3">
              {qr && <img src={qr} alt="Solana Pay QR" className="mx-auto rounded-xl" width={280} height={280} />}
              <div className="text-sm font-semibold">{usd(req.amount)} · {req.label}</div>
              <div className="flex justify-center gap-1 rounded-lg border border-[var(--border)] p-1 text-xs">
                {(["pay", "checkout"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`rounded-md px-3 py-1 ${mode === m ? "bg-[var(--accent2)] text-white" : "text-[var(--muted)] hover:text-[var(--text)]"}`}
                  >
                    {m === "pay" ? "One tap · Solana Pay" : "Choose collateral"}
                  </button>
                ))}
              </div>
              <div className="text-xs text-[var(--muted)]">
                {mode === "pay" ? "Scan with Phantom's scanner: borrow + pay in one approval, or" : "Scan with the phone camera: opens the checkout in Phantom, or"}
              </div>
              <Link href={`/checkout?${payQuery(req)}`} className="inline-block rounded-lg border border-[var(--accent2)] px-4 py-2 text-sm hover:bg-[var(--accent2)]/20">
                Pay from this device →
              </Link>
              <div className="text-[10px] text-[var(--muted)]">waiting for payment…</div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

const inputCls = "w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent2)]";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-[var(--muted)]">{label}</span>
      {children}
    </label>
  );
}
