const TONES = {
  good: "bg-green-100 text-green-900",
  warn: "bg-amber-100 text-amber-900",
  bad: "bg-red-100 text-red-900",
  neutral: "bg-zinc-100 text-zinc-800",
  info: "bg-blue-100 text-blue-900",
} as const;

const ICONS: Record<keyof typeof TONES, string> = {
  good: "✓",
  warn: "!",
  bad: "✕",
  neutral: "•",
  info: "i",
};

const STATUS_TONE: Record<string, keyof typeof TONES> = {
  active: "good",
  paid: "good",
  connected: "good",
  no_charge: "neutral",
  draft: "neutral",
  archived: "neutral",
  onboarding: "info",
  pending: "info",
  pending_invoice: "info",
  open: "info",
  paused: "warn",
  payment_failed: "bad",
  uncollectible: "bad",
  void: "neutral",
  error: "bad",
  churned: "neutral",
  critical: "bad",
  warning: "warn",
};

/** Status is never conveyed by color alone: every badge carries an icon and a text label. */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const tone = STATUS_TONE[status] ?? "neutral";
  return (
    <span className={`badge ${TONES[tone]}`}>
      <span aria-hidden="true">{ICONS[tone]}</span>
      {label ?? status.replace(/_/g, " ")}
    </span>
  );
}
