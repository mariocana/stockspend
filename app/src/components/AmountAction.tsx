"use client";

import { useState } from "react";

type Props = {
  label: string;
  unit: string;
  max?: number;
  disabled?: boolean;
  busy?: boolean;
  tone?: "accent" | "neutral" | "danger";
  onSubmit: (amount: number) => void;
};

const tones = {
  accent: "bg-[var(--accent)] text-black hover:opacity-90",
  neutral: "bg-[var(--border)] text-[var(--text)] hover:bg-[#2d3549]",
  danger: "bg-[var(--danger)] text-black hover:opacity-90",
};

export function AmountAction({ label, unit, max, disabled, busy, tone = "neutral", onSubmit }: Props) {
  const [value, setValue] = useState("");
  const amount = parseFloat(value);
  const valid = amount > 0 && (max === undefined || amount <= max + 1e-9);
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) {
          onSubmit(amount);
          setValue("");
        }
      }}
    >
      <div className="relative flex-1">
        <input
          type="number"
          step="any"
          min="0"
          placeholder="0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled || busy}
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 pr-16 text-sm outline-none focus:border-[var(--accent2)] disabled:opacity-50"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--muted)]">{unit}</span>
        {max !== undefined && (
          <button
            type="button"
            onClick={() => setValue(String(Math.floor(max * 1e6) / 1e6))}
            className="absolute -top-5 right-0 text-[10px] uppercase tracking-wide text-[var(--muted)] hover:text-[var(--text)]"
          >
            max {max.toLocaleString("en-US", { maximumFractionDigits: 4 })}
          </button>
        )}
      </div>
      <button
        type="submit"
        disabled={!valid || disabled || busy}
        className={`rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]}`}
      >
        {busy ? "…" : label}
      </button>
    </form>
  );
}
