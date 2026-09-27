"use client";

import { useId, useState } from "react";
import { applyRateBps, formatMinor } from "@/lib/money";

/** Public fee calculator: fee = rate × ad-driven revenue. Nothing else. */
export function FeeCalculator({ defaultRateBps }: { defaultRateBps: number }) {
  const revenueId = useId();
  const retainerId = useId();
  const [revenue, setRevenue] = useState("50000");
  const [retainer, setRetainer] = useState("5000");
  const revenueMinor = Math.max(0, Math.round(Number(revenue.replace(/[^\d.]/g, "")) * 100) || 0);
  const retainerMinor = Math.max(0, Math.round(Number(retainer.replace(/[^\d.]/g, "")) * 100) || 0);
  const fee = applyRateBps(revenueMinor, defaultRateBps);
  const keep = revenueMinor - fee;

  return (
    <div className="card">
      <h3 className="text-lg font-semibold">Fee calculator</h3>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={revenueId} className="label">
            Monthly revenue from our ads (USD)
          </label>
          <input
            id={revenueId}
            inputMode="decimal"
            className="input"
            value={revenue}
            onChange={(e) => setRevenue(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={retainerId} className="label">
            Retainer you pay today (USD / month)
          </label>
          <input
            id={retainerId}
            inputMode="decimal"
            className="input"
            value={retainer}
            onChange={(e) => setRetainer(e.target.value)}
          />
        </div>
      </div>
      <dl className="mt-6 grid gap-4 sm:grid-cols-3" aria-live="polite">
        <div>
          <dt className="text-sm text-ink-2">Our fee ({defaultRateBps / 100}%)</dt>
          <dd className="text-2xl font-semibold">{formatMinor(fee, "USD")}</dd>
        </div>
        <div>
          <dt className="text-sm text-ink-2">Revenue you keep</dt>
          <dd className="text-2xl font-semibold">{formatMinor(keep, "USD")}</dd>
        </div>
        <div>
          <dt className="text-sm text-ink-2">Fee if our ads sell nothing</dt>
          <dd className="text-2xl font-semibold">{formatMinor(0, "USD")}</dd>
        </div>
      </dl>
      <p className="mt-4 text-sm text-ink-2">
        {retainerMinor > fee
          ? `That's ${formatMinor(retainerMinor - fee, "USD")} less than your retainer this month — and the retainer doesn't care whether anything sold.`
          : "You pay more only when the ads earn more. Ad spend is paid by you, directly to the platforms, with a hard monthly cap."}
      </p>
    </div>
  );
}
