import { describe, expect, it } from "vitest";
import {
  currencyExponent,
  formatBps,
  formatMinor,
  microsToMinor,
  minorToMicros,
  MoneyParseError,
  normalizeCurrency,
  parseDecimalToMinor,
  parseMoneyInput,
  roundHalfUpDiv,
} from "@/lib/money";

describe("money", () => {
  it("knows currency exponents", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("jpy")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
  });

  it.each([
    ["123.45", "USD", 12_345],
    ["123", "USD", 12_300],
    ["0.5", "USD", 50],
    ["0.005", "USD", 1], // half-up on the dropped digit
    ["0.004", "USD", 0],
    ["19.999", "USD", 2_000],
    ["1500", "JPY", 1_500],
    ["1500.5", "JPY", 1_501],
    ["1.2345", "KWD", 1_235],
    ["-10.25", "USD", -1_025],
  ])("parses %s %s → %i minor units", (value, currency, minor) => {
    expect(parseDecimalToMinor(value, currency)).toBe(minor);
  });

  it("parses numbers without floating point drift", () => {
    expect(parseDecimalToMinor(0.1 + 0.2, "USD")).toBe(30);
    expect(parseDecimalToMinor(19.99, "USD")).toBe(1_999);
  });

  it("rejects malformed amounts and currencies", () => {
    expect(() => parseDecimalToMinor("12,50", "USD")).toThrow(MoneyParseError);
    expect(() => parseDecimalToMinor("1e5", "USD")).toThrow(MoneyParseError);
    expect(() => parseDecimalToMinor("", "USD")).toThrow(MoneyParseError);
    expect(() => normalizeCurrency("US")).toThrow(MoneyParseError);
    expect(() => parseDecimalToMinor("99999999999999999999", "USD")).toThrow(MoneyParseError);
  });

  it("parses form input with separators and symbols", () => {
    expect(parseMoneyInput("$1,500.00", "USD")).toBe(150_000);
    expect(parseMoneyInput(" 2 000 ", "USD")).toBe(200_000);
  });

  it("rounds half up with BigInt division", () => {
    expect(roundHalfUpDiv(15n, 10n)).toBe(2n);
    expect(roundHalfUpDiv(14n, 10n)).toBe(1n);
    expect(roundHalfUpDiv(-15n, 10n)).toBe(-2n);
    expect(() => roundHalfUpDiv(1n, 0n)).toThrow(RangeError);
  });

  it("converts Google Ads micros", () => {
    expect(microsToMinor(1_234_567, "USD")).toBe(123); // $1.234567 → 123 cents
    expect(microsToMinor("5000", "USD")).toBe(1); // half-up
    expect(microsToMinor(1_000_000, "JPY")).toBe(1);
    expect(minorToMicros(5_000, "USD")).toBe(50_000_000);
  });

  it("formats amounts", () => {
    expect(formatMinor(123_456, "USD")).toBe("$1,234.56");
    expect(formatMinor(1_500, "JPY")).toBe("¥1,500");
    expect(formatBps(1000)).toBe("10%");
    expect(formatBps(1250)).toBe("12.5%");
  });
});
