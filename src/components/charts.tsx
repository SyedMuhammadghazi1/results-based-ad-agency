"use client";

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { formatMinor, formatMinorCompact } from "@/lib/money";

/*
 * Lightweight dependency-free SVG charts.
 * Specs: columns <= 24px with a 4px rounded data-end and square baseline, 2px surface gaps,
 * 2px lines, hairline recessive grid, one y-axis, text in ink tokens (never series colors),
 * hover/focus tooltip, and a table view so no value is gated behind hover.
 */

type Point = { date: string; amountMinor: number };

const W = 720;
const H = 220;
const PAD = { top: 16, right: 16, bottom: 28, left: 64 };

function niceMax(v: number): number {
  if (v <= 0) return 100;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function useKeyboardIndex(length: number) {
  const [active, setActive] = useState<number | null>(null);
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowRight") setActive((a) => Math.min((a ?? -1) + 1, length - 1));
    else if (e.key === "ArrowLeft") setActive((a) => Math.max((a ?? length) - 1, 0));
    else if (e.key === "Escape") setActive(null);
    else return;
    e.preventDefault();
  }
  return { active, setActive, onKeyDown };
}

function YAxis({ max, currency }: { max: number; currency: string }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const innerH = H - PAD.top - PAD.bottom;
  return (
    <g>
      {ticks.map((t) => {
        const y = PAD.top + innerH - (t / max) * innerH;
        return (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y}
              y2={y}
              stroke="var(--color-hairline)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--color-muted)"
              className="tabular"
            >
              {formatMinorCompact(t, currency)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function XLabels({ dates, x }: { dates: string[]; x: (i: number) => number }) {
  if (dates.length === 0) return null;
  const idx = [...new Set([0, Math.floor((dates.length - 1) / 2), dates.length - 1])];
  return (
    <g>
      {idx.map((i) => (
        <text
          key={i}
          x={x(i)}
          y={H - 8}
          textAnchor="middle"
          fontSize={11}
          fill="var(--color-muted)"
        >
          {shortDate(dates[i]!)}
        </text>
      ))}
    </g>
  );
}

function Tooltip({ leftPct, children }: { leftPct: number; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-lg border border-hairline bg-white px-3 py-2 text-xs shadow-md"
      style={{ left: `${Math.min(Math.max(leftPct, 12), 88)}%` }}
    >
      {children}
    </div>
  );
}

/** Single-series daily column chart (client dashboard). No legend: the title names the series. */
export function RevenueColumnChart({
  data,
  currency,
  title,
}: {
  data: Point[];
  currency: string;
  title: string;
}) {
  const titleId = useId();
  const { active, setActive, onKeyDown } = useKeyboardIndex(data.length);
  const max = useMemo(() => niceMax(Math.max(0, ...data.map((d) => d.amountMinor))), [data]);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const band = innerW / Math.max(data.length, 1);
  const barW = Math.min(24, Math.max(band - 2, 2));
  const cx = (i: number) => PAD.left + band * i + band / 2;
  const baseY = PAD.top + innerH;
  const current = active !== null ? data[active] : null;

  return (
    <figure className="relative">
      <figcaption id={titleId} className="sr-only">
        {title}
      </figcaption>
      {current ? (
        <Tooltip leftPct={(cx(active!) / W) * 100}>
          <p className="text-sm font-semibold text-ink tabular">
            {formatMinor(current.amountMinor, currency)}
          </p>
          <p className="text-ink-2">{shortDate(current.date)}</p>
        </Tooltip>
      ) : null}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full rounded-md focus-visible:outline-2 focus-visible:outline-brand-600"
        role="img"
        aria-labelledby={titleId}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
      >
        <rect x={0} y={0} width={W} height={H} fill="var(--color-surface)" />
        <YAxis max={max} currency={currency} />
        {data.map((d, i) => {
          const h = (Math.max(d.amountMinor, 0) / max) * innerH;
          const x = cx(i) - barW / 2;
          const r = Math.min(4, h, barW / 2);
          const y = baseY - h;
          const path =
            h <= 0
              ? ""
              : `M${x},${baseY} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${baseY} Z`;
          return (
            <g key={d.date}>
              {path ? (
                <path
                  d={path}
                  fill="var(--color-series-1)"
                  opacity={active === null || active === i ? 1 : 0.55}
                />
              ) : null}
              <rect
                x={PAD.left + band * i}
                y={PAD.top}
                width={band}
                height={innerH}
                fill="transparent"
                onPointerEnter={() => setActive(i)}
                onPointerMove={() => setActive(i)}
              />
            </g>
          );
        })}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={baseY}
          y2={baseY}
          stroke="#c3c2b7"
          strokeWidth={1}
        />
        <XLabels dates={data.map((d) => d.date)} x={cx} />
      </svg>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-ink-2">Show data table</summary>
        <DataTable
          rows={data.map((d) => ({ date: d.date, values: [d.amountMinor] }))}
          headers={["Attributed revenue"]}
          currency={currency}
        />
      </details>
    </figure>
  );
}

type Series = { name: string; color: string; points: Point[] };

/** Two-series line chart with a crosshair (operator view: spend vs attributed revenue). */
export function DualLineChart({
  series,
  currency,
  title,
}: {
  series: [Series, Series];
  currency: string;
  title: string;
}) {
  const titleId = useId();
  const dates = series[0].points.map((p) => p.date);
  const { active, setActive, onKeyDown } = useKeyboardIndex(dates.length);
  const max = useMemo(
    () => niceMax(Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.amountMinor)))),
    [series],
  );
  const innerW = W - PAD.left - PAD.right - 56;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (dates.length <= 1 ? 0 : (innerW * i) / (dates.length - 1));
  const y = (v: number) => PAD.top + innerH - (Math.max(v, 0) / max) * innerH;

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.left) / innerW) * (dates.length - 1));
    setActive(Math.min(Math.max(i, 0), dates.length - 1));
  }

  return (
    <figure className="relative">
      <figcaption id={titleId} className="sr-only">
        {title}
      </figcaption>
      <ul className="mb-2 flex flex-wrap gap-4 text-xs text-ink-2" aria-label="Legend">
        {series.map((s) => (
          <li key={s.name} className="flex items-center gap-2">
            <svg width="16" height="4" aria-hidden="true">
              <line
                x1="0"
                x2="16"
                y1="2"
                y2="2"
                stroke={s.color}
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            {s.name}
          </li>
        ))}
      </ul>
      {active !== null ? (
        <Tooltip leftPct={(x(active) / W) * 100}>
          <p className="mb-1 text-ink-2">{shortDate(dates[active]!)}</p>
          {series.map((s) => (
            <p key={s.name} className="flex items-center gap-2">
              <svg width="12" height="4" aria-hidden="true">
                <line x1="0" x2="12" y1="2" y2="2" stroke={s.color} strokeWidth="2" />
              </svg>
              <span className="font-semibold text-ink tabular">
                {formatMinor(s.points[active]!.amountMinor, currency)}
              </span>
              <span className="text-ink-2">{s.name}</span>
            </p>
          ))}
        </Tooltip>
      ) : null}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full rounded-md focus-visible:outline-2 focus-visible:outline-brand-600"
        role="img"
        aria-labelledby={titleId}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
      >
        <rect x={0} y={0} width={W} height={H} fill="var(--color-surface)" />
        <YAxis max={max} currency={currency} />
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={PAD.top + innerH}
          y2={PAD.top + innerH}
          stroke="#c3c2b7"
          strokeWidth={1}
        />
        {active !== null ? (
          <line
            x1={x(active)}
            x2={x(active)}
            y1={PAD.top}
            y2={PAD.top + innerH}
            stroke="#898781"
            strokeWidth={1}
          />
        ) : null}
        {series.map((s) => {
          const d = s.points
            .map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.amountMinor)}`)
            .join(" ");
          const last = s.points[s.points.length - 1];
          return (
            <g key={s.name}>
              <path
                d={d}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {last ? (
                <>
                  <circle
                    cx={x(s.points.length - 1)}
                    cy={y(last.amountMinor)}
                    r={4}
                    fill={s.color}
                    stroke="var(--color-surface)"
                    strokeWidth={2}
                  />
                  <text
                    x={x(s.points.length - 1) + 8}
                    y={y(last.amountMinor) + 4}
                    fontSize={11}
                    fill="var(--color-ink-2)"
                  >
                    {s.name}
                  </text>
                </>
              ) : null}
              {active !== null && s.points[active] ? (
                <circle
                  cx={x(active)}
                  cy={y(s.points[active]!.amountMinor)}
                  r={4}
                  fill={s.color}
                  stroke="var(--color-surface)"
                  strokeWidth={2}
                />
              ) : null}
            </g>
          );
        })}
        <XLabels dates={dates} x={x} />
      </svg>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-ink-2">Show data table</summary>
        <DataTable
          rows={dates.map((date, i) => ({
            date,
            values: series.map((s) => s.points[i]?.amountMinor ?? 0),
          }))}
          headers={series.map((s) => s.name)}
          currency={currency}
        />
      </details>
    </figure>
  );
}

function DataTable({
  rows,
  headers,
  currency,
}: {
  rows: Array<{ date: string; values: number[] }>;
  headers: string[];
  currency: string;
}) {
  return (
    <div className="mt-2 max-h-64 overflow-auto">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            {headers.map((h) => (
              <th key={h} scope="col" className="text-right">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.date}>
              <td>{r.date}</td>
              {r.values.map((v, i) => (
                <td key={i} className="text-right tabular">
                  {formatMinor(v, currency)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
