import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Styles the confirm button as destructive; the dialog then focuses "Cancel" first. */
  danger?: boolean;
  /** Disables the confirm button (e.g. invalid input). */
  canSubmit?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}

/** Modal dialog: Esc cancels, Enter submits (native form), Tab is trapped, focus is restored on close. */
export function Dialog({ title, children, confirmLabel, danger, canSubmit = true, onSubmit, onCancel }: DialogProps) {
  const root = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = root.current!;
    const preferred = danger ? el.querySelector<HTMLElement>("[data-cancel]") : null;
    (preferred ?? el.querySelector<HTMLElement>("input:not([type=checkbox]):not([type=radio]), select, textarea") ?? el.querySelector<HTMLElement>("[data-confirm]"))?.focus();
    return () => previous?.focus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus once on mount
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Tab") {
      const items = [...root.current!.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !root.current!.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !root.current!.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) onSubmit();
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div ref={root} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <form onSubmit={submit}>
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          <div className="dialog-body">{children}</div>
          <div className="dialog-actions">
            <button type="button" className="btn" data-cancel onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} data-confirm disabled={!canSubmit}>
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- form dialog */

export type FieldValue = string | boolean;
export type FormValues = Record<string, FieldValue>;

interface FieldBase {
  name: string;
  label: string;
  hint?: string;
}
export type FieldSpec =
  | (FieldBase & { kind: "text"; initial?: string; placeholder?: string; /** Returns an error message, or undefined when valid. */ validate?: (value: string) => string | undefined })
  | (FieldBase & { kind: "checkbox"; initial?: boolean })
  | (FieldBase & { kind: "select"; options: { value: string; label: string }[]; initial?: string })
  | (FieldBase & { kind: "radio"; options: { value: string; label: string; hint?: string }[]; initial?: string });

export interface FormDialogSpec {
  title: string;
  /** Plain statement of what will happen; may depend on the current values. */
  description?: ReactNode | ((values: FormValues) => ReactNode);
  fields?: FieldSpec[];
  confirmLabel: string;
  danger?: boolean | ((values: FormValues) => boolean);
  onConfirm: (values: FormValues) => void;
}

function initialValues(fields: FieldSpec[]): FormValues {
  const values: FormValues = {};
  for (const f of fields) {
    values[f.name] = f.kind === "checkbox" ? (f.initial ?? false) : f.kind === "text" ? (f.initial ?? "") : (f.initial ?? f.options[0]?.value ?? "");
  }
  return values;
}

export function FormDialog({ spec, onClose }: { spec: FormDialogSpec; onClose: () => void }) {
  const fields = spec.fields ?? [];
  const [values, setValues] = useState<FormValues>(() => initialValues(fields));
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const set = (name: string, value: FieldValue) => setValues((v) => ({ ...v, [name]: value }));
  const errors = new Map<string, string>();
  for (const f of fields) {
    if (f.kind === "text" && f.validate) {
      const error = f.validate(String(values[f.name]));
      if (error) errors.set(f.name, error);
    }
  }
  const description = typeof spec.description === "function" ? spec.description(values) : spec.description;
  const danger = typeof spec.danger === "function" ? spec.danger(values) : spec.danger;

  return (
    <Dialog
      title={spec.title}
      confirmLabel={spec.confirmLabel}
      danger={danger}
      canSubmit={errors.size === 0}
      onCancel={onClose}
      onSubmit={() => {
        onClose();
        spec.onConfirm(values);
      }}
    >
      {description && <div className="dialog-desc">{description}</div>}
      {fields.map((f) => {
        const id = `field-${f.name}`;
        if (f.kind === "checkbox") {
          return (
            <label key={f.name} className="field-check">
              <input type="checkbox" checked={values[f.name] as boolean} onChange={(e) => set(f.name, e.target.checked)} />
              <span>
                {f.label}
                {f.hint && <small className="muted"> {f.hint}</small>}
              </span>
            </label>
          );
        }
        if (f.kind === "radio") {
          return (
            <fieldset key={f.name} className="field">
              <legend>{f.label}</legend>
              {f.options.map((o) => (
                <label key={o.value} className="field-check">
                  <input type="radio" name={f.name} value={o.value} checked={values[f.name] === o.value} onChange={() => set(f.name, o.value)} />
                  <span>
                    {o.label}
                    {o.hint && <small className="muted"> {o.hint}</small>}
                  </span>
                </label>
              ))}
            </fieldset>
          );
        }
        const error = errors.get(f.name);
        const showError = error && (touched.has(f.name) || String(values[f.name]) !== "");
        return (
          <div key={f.name} className="field">
            <label htmlFor={id}>{f.label}</label>
            {f.kind === "select" ? (
              <select id={id} className="input" value={values[f.name] as string} onChange={(e) => set(f.name, e.target.value)}>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                className={`input${showError ? " invalid" : ""}`}
                value={values[f.name] as string}
                placeholder={f.placeholder}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={showError ? true : undefined}
                aria-describedby={`${id}-msg`}
                onChange={(e) => set(f.name, e.target.value)}
                onBlur={() => setTouched((t) => new Set(t).add(f.name))}
              />
            )}
            <small id={`${id}-msg`} className={showError ? "error" : "muted"} role={showError ? "alert" : undefined}>
              {showError ? error : f.hint}
            </small>
          </div>
        );
      })}
    </Dialog>
  );
}
