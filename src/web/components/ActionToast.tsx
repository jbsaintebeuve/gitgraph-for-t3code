import { useEffect, useState } from "react";
import type { ActionToast as Toast } from "../hooks/useGitActions";
import { copyText } from "../lib/clipboard";

export interface ActionToastProps {
  running: string | undefined;
  toast: Toast | undefined;
  onDismiss: () => void;
}

/** Bottom-right status area: spinner while an action runs, then success / git output (scrollable, copyable). */
export function ActionToast({ running, toast, onDismiss }: ActionToastProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
    if (!toast || !toast.ok) return;
    const timer = setTimeout(onDismiss, toast.info ? 2000 : 8000);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  if (running) {
    return (
      <div className="toast" role="status" aria-live="polite">
        <div className="toast-head">
          <span className="spinner" aria-hidden="true" />
          <span>{running}…</span>
        </div>
      </div>
    );
  }
  if (!toast) return null;
  return (
    <div className={`toast${toast.ok ? "" : " toast-error"}`} role={toast.ok ? "status" : "alert"}>
      <div className="toast-head">
        <span className={toast.ok ? "add" : "del"} aria-hidden="true">
          {toast.ok ? "✓" : "✕"}
        </span>
        <strong className="toast-title">
          {toast.label}
          {!toast.info && (toast.ok ? "" : " failed")}
        </strong>
        {!toast.info && toast.output && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => void copyText(toast.output).then((ok) => setCopied(ok))}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
        <button type="button" className="icon-btn" onClick={onDismiss} aria-label="Dismiss">
          ✕
        </button>
      </div>
      {!toast.info && toast.output && (
        <pre className="toast-output" tabIndex={0}>
          {toast.output}
        </pre>
      )}
    </div>
  );
}
