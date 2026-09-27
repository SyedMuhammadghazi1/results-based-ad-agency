import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

type Base = { label: string; name: string; hint?: ReactNode };

export function Field({
  label,
  name,
  hint,
  ...rest
}: Base & InputHTMLAttributes<HTMLInputElement>) {
  const id = `f-${name}`;
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        name={name}
        className="input"
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...rest}
      />
      {hint ? (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextArea({
  label,
  name,
  hint,
  ...rest
}: Base & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = `f-${name}`;
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        className="input"
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...rest}
      />
      {hint ? (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Select({
  label,
  name,
  hint,
  options,
  defaultValue,
}: Base & { options: Array<{ value: string; label: string }>; defaultValue?: string }) {
  const id = `f-${name}`;
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <select id={id} name={name} defaultValue={defaultValue} className="input">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}
