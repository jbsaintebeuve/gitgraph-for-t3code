import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { GitRef, GraphOrder } from "../../shared/types.js";
import type { RepoEntry } from "../api";

export interface ToolbarProps {
  repos: RepoEntry[];
  repo: string | undefined;
  onRepo: (path: string) => void;
  refs: GitRef[];
  branches: string[];
  onBranches: (branches: string[]) => void;
  remotes: boolean;
  onRemotes: (v: boolean) => void;
  stashes: boolean;
  onStashes: (v: boolean) => void;
  firstParent: boolean;
  onFirstParent: (v: boolean) => void;
  order: GraphOrder;
  onOrder: (v: GraphOrder) => void;
  query: string;
  onQuery: (q: string) => void;
  searchInput: RefObject<HTMLInputElement | null>;
  matchLabel: string;
  onNextMatch: () => void;
  onPrevMatch: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** Git actions (disabled while one is running or when `undefined` handlers are not applicable). */
  actionsBusy: boolean;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  /** Reasons why pull/push are unavailable (shown as tooltip), if any. */
  pullDisabled?: string;
  pushDisabled?: string;
}

function BranchFilter({ refs, selected, onChange, remotes }: { refs: GitRef[]; selected: string[]; onChange: (b: string[]) => void; remotes: boolean }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setOpen(false));
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const options = useMemo(
    () =>
      [
        ...new Set(
          refs
            .filter((r) => r.kind === "branch" || (remotes && r.kind === "remote" && !r.name.endsWith("/HEAD")))
            .map((r) => r.name),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [refs, remotes],
  );
  const shown = options.filter((n) => n.toLowerCase().includes(filter.toLowerCase()));
  const label = selected.length === 0 ? "All branches" : selected.length === 1 ? selected[0]! : `${selected.length} branches`;
  const toggle = (name: string) =>
    onChange(selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]);

  return (
    <div className="dropdown" ref={root}>
      <button type="button" className="btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="btn-label">{label}</span> ▾
      </button>
      {open && (
        <div className="popover" role="listbox" aria-multiselectable="true">
          <input
            autoFocus
            className="input"
            placeholder="Filter branches…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label className="opt">
            <input type="checkbox" checked={selected.length === 0} onChange={() => onChange([])} />
            <span>All branches</span>
          </label>
          <div className="opt-list">
            {shown.map((name) => (
              <label key={name} className="opt">
                <input type="checkbox" checked={selected.includes(name)} onChange={() => toggle(name)} />
                <span className="mono">{name}</span>
              </label>
            ))}
            {shown.length === 0 && <p className="muted pad">No match.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ label, value, onChange, title }: { label: string; value: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button type="button" className="btn toggle" aria-pressed={value} title={title} onClick={() => onChange(!value)}>
      {label}
    </button>
  );
}

export function Toolbar(p: ToolbarProps) {
  return (
    <div className="toolbar" role="toolbar" aria-label="Graph options">
      <select className="btn" value={p.repo ?? ""} onChange={(e) => p.onRepo(e.target.value)} aria-label="Repository" title={p.repo}>
        {p.repos.map((r) => (
          <option key={r.path} value={r.path}>
            {r.name}
          </option>
        ))}
      </select>
      <BranchFilter refs={p.refs} selected={p.branches} onChange={p.onBranches} remotes={p.remotes} />
      <Toggle label="Remotes" value={p.remotes} onChange={p.onRemotes} title="Show remote branches" />
      <Toggle label="Stashes" value={p.stashes} onChange={p.onStashes} title="Show stashes" />
      <Toggle label="First parent" value={p.firstParent} onChange={p.onFirstParent} title="Follow only the first parent of merges" />
      <select className="btn" value={p.order} onChange={(e) => p.onOrder(e.target.value as GraphOrder)} aria-label="Order" title="Commit order">
        <option value="topo">Topological</option>
        <option value="date">Commit date</option>
        <option value="author-date">Author date</option>
      </select>
      <div className="search">
        <input
          ref={p.searchInput}
          className="input"
          type="search"
          placeholder="Search message, author, hash…"
          value={p.query}
          aria-label="Search commits"
          onChange={(e) => p.onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) p.onPrevMatch();
              else p.onNextMatch();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              if (p.query) p.onQuery("");
              else e.currentTarget.blur();
            }
          }}
        />
        {p.matchLabel && <span className="match-count muted">{p.matchLabel}</span>}
        {p.query && (
          <>
            <button type="button" className="icon-btn" title="Previous match (Shift+Enter)" onClick={p.onPrevMatch}>
              ↑
            </button>
            <button type="button" className="icon-btn" title="Next match (Enter)" onClick={p.onNextMatch}>
              ↓
            </button>
          </>
        )}
      </div>
      <button type="button" className={`btn${p.refreshing ? " spin" : ""}`} onClick={p.onRefresh} title="Refresh" aria-label="Refresh">
        <span className="refresh-icon">↻</span>
      </button>
      <span className="toolbar-sep" aria-hidden="true" />
      <button type="button" className="btn" disabled={p.actionsBusy || !p.repo} onClick={p.onFetch} title="Fetch all remotes (--prune)">
        Fetch
      </button>
      <button type="button" className="btn" disabled={p.actionsBusy || !!p.pullDisabled} onClick={p.onPull} title={p.pullDisabled ?? "Pull the current branch"}>
        Pull
      </button>
      <button type="button" className="btn" disabled={p.actionsBusy || !!p.pushDisabled} onClick={p.onPush} title={p.pushDisabled ?? "Push the current branch"}>
        Push
      </button>
    </div>
  );
}
