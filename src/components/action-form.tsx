"use client";

import { useActionState, type ReactNode } from "react";
import { initialActionState, type ActionState } from "@/lib/action-state";
import { CopyField } from "./copy-field";

type Props = {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children?: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  className?: string;
  buttonClassName?: string;
  successMessage?: string;
  /** Rendered next to the submit button. */
  extraActions?: ReactNode;
};

/** Progressive-enhancement form bound to a server action, with accessible status output. */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel = "Working…",
  className = "space-y-4",
  buttonClassName = "btn btn-primary",
  successMessage,
  extraActions,
}: Props) {
  const [state, formAction, pending] = useActionState(action, initialActionState);
  return (
    <form action={formAction} className={className} noValidate={false}>
      {children}
      {state.message || (state.ok && successMessage) ? (
        <div
          role={state.ok ? "status" : "alert"}
          className={`rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-brand-50 text-brand-800" : "bg-red-50 text-red-800"}`}
        >
          <p>{state.message ?? successMessage}</p>
          {state.errors && state.errors.length > 0 ? (
            <ul className="mt-1 list-disc pl-5">
              {state.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {state.secret ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="mb-2 text-sm font-medium text-amber-900">
            {state.secretLabel ?? "Copy this value now — it will not be shown again."}
          </p>
          <CopyField value={state.secret} label="Secret value" />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={buttonClassName} disabled={pending} aria-busy={pending}>
          {pending ? pendingLabel : submitLabel}
        </button>
        {extraActions}
      </div>
    </form>
  );
}
