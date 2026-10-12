import { memo, useMemo, useState } from "react";
import type { FileChange, FileDiff } from "../../shared/types.js";
import { isVisibleMeta, parseDiff } from "../lib/diff";

const RENDER_LIMIT = 4000;

export interface DiffViewProps {
  file: FileChange;
  diff: FileDiff | undefined;
  loading: boolean;
  error: string | undefined;
}

const MARK = { add: "+", del: "−", ctx: " ", hunk: "", meta: "", note: "" } as const;

const Lines = memo(function Lines({ patch, limit }: { patch: string; limit: number }) {
  const lines = useMemo(() => parseDiff(patch).filter(isVisibleMeta), [patch]);
  const shown = lines.length > limit ? lines.slice(0, limit) : lines;
  return (
    <table className="diff mono">
      <tbody>
        {shown.map((line, i) => (
          <tr key={i} className={`dl dl-${line.kind}`}>
            <td className="ln">{line.oldNo ?? ""}</td>
            <td className="ln">{line.newNo ?? ""}</td>
            {line.kind === "hunk" || line.kind === "meta" || line.kind === "note" ? (
              <td className="code" colSpan={2}>
                {line.text}
              </td>
            ) : (
              <>
                <td className="mark">{MARK[line.kind]}</td>
                <td className="code">{line.text}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
});

export function DiffView({ file, diff, loading, error }: DiffViewProps) {
  const [showAll, setShowAll] = useState(false);
  const totalLines = diff ? diff.patch.split("\n").length : 0;
  return (
    <div className="diff-view">
      <div className="diff-title">
        <span className="mono diff-path" title={file.path}>
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="counts mono">
          {file.additions > 0 && <span className="add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="del">−{file.deletions}</span>}
        </span>
      </div>
      {loading && !diff && <p className="muted pad">Loading diff…</p>}
      {error && <p className="error pad">{error}</p>}
      {diff?.truncated && (
        <p className="warn pad" role="alert">
          Large diff: the output was truncated by the server, only the beginning is shown.
        </p>
      )}
      {diff && file.binary && <p className="muted pad">Binary file not shown.</p>}
      {diff && !file.binary && diff.patch.trim() === "" && <p className="muted pad">No textual changes (mode change or empty file).</p>}
      {diff && !file.binary && diff.patch.trim() !== "" && (
        <>
          <Lines patch={diff.patch} limit={showAll ? Infinity : RENDER_LIMIT} />
          {!showAll && totalLines > RENDER_LIMIT && (
            <p className="warn pad">
              Showing the first {RENDER_LIMIT} of {totalLines} lines.{" "}
              <button type="button" className="link" onClick={() => setShowAll(true)}>
                Show all
              </button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
