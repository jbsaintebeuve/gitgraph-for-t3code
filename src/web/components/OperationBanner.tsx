import type { GraphPage, RepoOperation } from "../../shared/types.js";
import { apiUrl } from "../api";
import { useApi } from "../hooks/useAsync";

const LABEL: Record<Exclude<RepoOperation, null>, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
};

export interface OperationBannerProps {
  repo: string;
  page: GraphPage;
  /** Conflicted files reported by the last action (used until the status list loads). */
  conflicts: string[];
  reloadKey: unknown;
  running: boolean;
  onContinue: () => void;
  onAbort: () => void;
}

/** Banner shown while a merge/rebase/cherry-pick/revert is stopped: conflicted files + Continue / Abort. */
export function OperationBanner({ repo, page, conflicts, reloadKey, running, onContinue, onAbort }: OperationBannerProps) {
  const operation = page.operation;
  const changes = useApi<string[]>(operation && page.workingTree?.conflicted ? apiUrl("/api/conflicts", { repo }) : null, reloadKey);
  if (!operation) return null;
  const fromStatus = changes.data ?? [];
  const files = fromStatus.length > 0 ? fromStatus : conflicts;
  const count = page.workingTree?.conflicted ?? files.length;
  return (
    <div className="banner banner-operation" role="status">
      <div className="banner-row">
        <span>
          <strong>{LABEL[operation]}</strong> in progress
          {count > 0 ? ` — ${count} conflicted file${count === 1 ? "" : "s"}` : " — no conflicts left, ready to continue"}.
        </span>
        <span className="banner-actions">
          <button type="button" className="btn btn-primary" disabled={running || count > 0} title={count > 0 ? "Resolve and stage the conflicted files first" : undefined} onClick={onContinue}>
            Continue
          </button>
          <button type="button" className="btn btn-danger" disabled={running} onClick={onAbort}>
            Abort
          </button>
        </span>
      </div>
      {files.length > 0 && (
        <ul className="conflict-list mono" aria-label="Conflicted files">
          {files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {count > 0 && <div className="muted">Resolve them in your editor, stage them (<code>git add</code>), then click Continue.</div>}
    </div>
  );
}
