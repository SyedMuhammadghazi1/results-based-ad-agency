/**
 * Money helpers. All amounts are integers in the currency's minor unit.
 * Floating point is never used for stored amounts.
 */

/** ISO-4217 currencies whose minor unit is not 2 decimals. */
const EXPONENT_OVERRIDES: Record<string, number> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

export const SUPPORTED_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "NZD",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "JPY",
  "SGD",
  "INR",
  "BRL",
  "MXN",
] as const;

export class MoneyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyParseError";
  }
}

export function normalizeCurrency(code: string): string {
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) throw new MoneyParseError(`Invalid currency code: ${code}`);
  return upper;
}

export function currencyExponent(currency: string): number {
  return EXPONENT_OVERRIDES[normalizeCurrency(currency)] ?? 2;
}

/**
 * Parses a decimal string in major units ("123.45", "1000", "0.5") into minor units without
 * floating point. Extra precision beyond the currency's exponent is rounded half-up.
 */
export function parseDecimalToMinor(value: string | number, currency: string): number {
  const raw = typeof value === "number" ? numberToPlainString(value) : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) throw new MoneyParseError(`Invalid decimal amount: ${String(value)}`);
  const [, sign, whole = "0", fraction = ""] = match;
  const exp = currencyExponent(currency);
  const padded = fraction.padEnd(exp + 1, "0");
  let minor = BigInt(whole) * 10n ** BigInt(exp) + BigInt(padded.slice(0, exp) || "0");
  // Round half-up on the first dropped digit.
  const nextDigit = Number(padded.charAt(exp) || "0");
  if (nextDigit >= 5) minor += 1n;
  const result = sign ? -minor : minor;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyParseError("Amount out of range");
  }
  return Number(result);
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new MoneyParseError("Amount must be finite");
  // toFixed(10) avoids exponent notation for typical money values.
  return n.toFixed(10).replace(/\.?0+$/, "");
}

/**
 * Integer division rounding half up (half away from zero for negative numerators).
 * Uses BigInt so `amount × rate` can never lose precision.
 */
export function roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  if (numerator < 0n) return -roundHalfUpDiv(-numerator, denominator);
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** fee = round-half-up(amount × rateBps / 10 000). */
export function applyRateBps(amountMinor: number, rateBps: number): number {
  assertSafeInteger(amountMinor, "amountMinor");
  assertSafeInteger(rateBps, "rateBps");
  if (rateBps < 0 || rateBps > 10_000) throw new RangeError("rateBps must be between 0 and 10000");
  return Number(roundHalfUpDiv(BigInt(amountMinor) * BigInt(rateBps), 10_000n));
}

/** Google Ads reports money in micros (1/1 000 000 of the major unit). */
export function microsToMinor(micros: number | string | bigint, currency: string): number {
  const exp = currencyExponent(currency);
  const divisor = 10n ** BigInt(6 - exp);
  return Number(roundHalfUpDiv(BigInt(micros), divisor));
}

export function minorToMicros(minor: number, currency: string): number {
  const exp = currencyExponent(currency);
  return minor * 10 ** (6 - exp);
}

export function formatMinor(amountMinor: number, currency: string, locale = "en-US"): string {
  const exp = currencyExponent(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: normalizeCurrency(currency),
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  }).format(amountMinor / 10 ** exp);
}

export function formatMinorCompact(
  amountMinor: number,
  currency: string,
  locale = "en-US",
): string {
  const exp = currencyExponent(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: normalizeCurrency(currency),
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(amountMinor / 10 ** exp);
}

/** Converts a major-unit form input ("1,234.50") to minor units. */
export function parseMoneyInput(value: string, currency: string): number {
  return parseDecimalToMinor(value.replace(/[,\s]/g, "").replace(/^[^\d-]+/, ""), currency);
}

export function formatBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(2).replace(/0$/, "")}%`;
}

function assertSafeInteger(n: number, name: string): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${name} must be a safe integer`);
}
