"use client";

import { useId, useState } from "react";

export function CopyField({
  value,
  label,
  multiline = false,
}: {
  value: string;
  label: string;
  multiline?: boolean;
}) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div className="flex items-start gap-2">
        {multiline ? (
          <textarea id={id} readOnly value={value} rows={3} className="input font-mono text-xs" />
        ) : (
          <input id={id} readOnly value={value} className="input font-mono text-xs" />
        )}
        <button type="button" onClick={copy} className="btn btn-secondary btn-sm shrink-0">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}
