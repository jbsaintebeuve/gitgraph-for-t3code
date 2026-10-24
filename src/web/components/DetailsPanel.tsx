import { useEffect, useState } from "react";
import { UNCOMMITTED_HASH, type CommitDetails, type FileChange, type FileDiff } from "../../shared/types.js";
import { apiUrl } from "../api";
import { useApi } from "../hooks/useAsync";
import { useSessionState } from "../hooks/useSessionState";
import { absoluteTime, plural, relativeTime, shortHash } from "../lib/format";
import { DiffView } from "./DiffView";
import { FileList, type FileViewMode } from "./FileList";

export interface DetailsPanelProps {
  repo: string;
  /** Commit shown (the newer one in compare mode) or UNCOMMITTED_HASH. */
  hash: string;
  /** Compare mode: the older commit; the diff goes compareTo → hash. */
  compareTo?: string;
  /** Bumped when the repository changed, to refetch. */
  reloadKey: unknown;
  onClose: () => void;
  onJump: (hash: string) => void;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn"
      title={`Copy ${label}`}
      onClick={() => {
        const finish = () => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        };
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(finish, () => undefined);
        else {
          const area = document.createElement("textarea");
          area.value = text;
          document.body.appendChild(area);
          area.select();
          document.execCommand("copy");
          area.remove();
          finish();
        }
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function HashLink({ hash, onJump }: { hash: string; onJump: (hash: string) => void }) {
  return (
    <button type="button" className="link mono" title={`Go to ${hash}`} onClick={() => onJump(hash)}>
      {shortHash(hash)}
    </button>
  );
}

export function DetailsPanel({ repo, hash, compareTo, reloadKey, onClose, onJump }: DetailsPanelProps) {
  const isUncommitted = hash === UNCOMMITTED_HASH;
  const [mode, setMode] = useSessionState<FileViewMode>("fileMode", "tree");
  const [selectedFile, setSelectedFile] = useState<FileChange>();

  const commitUrl = !isUncommitted && !compareTo ? apiUrl("/api/commit", { repo, hash }) : null;
  const filesUrl = isUncommitted
    ? apiUrl("/api/uncommitted", { repo })
    : compareTo
      ? apiUrl("/api/compare", { repo, from: compareTo, to: hash })
      : null;
  const commit = useApi<CommitDetails>(commitUrl, reloadKey);
  const compareFiles = useApi<FileChange[]>(filesUrl, reloadKey);

  const files: FileChange[] | undefined = commitUrl ? commit.data?.files : compareFiles.data;
  const filesLoading = commitUrl ? commit.loading : compareFiles.loading;
  const filesError = commitUrl ? commit.error : compareFiles.error;

  // Forget the open file when the subject changes.
  useEffect(() => setSelectedFile(undefined), [hash, compareTo]);

  const diffUrl = selectedFile
    ? apiUrl("/api/diff", { repo, hash, path: selectedFile.path, oldPath: selectedFile.oldPath, compareTo })
    : null;
  const diff = useApi<FileDiff>(diffUrl, reloadKey);

  const details = commit.data;
  const totals = files?.reduce((t, f) => ({ a: t.a + f.additions, d: t.d + f.deletions }), { a: 0, d: 0 });

  return (
    <section className="details" aria-label="Commit details">
      <header className="details-head">
        <div className="details-title">
          {isUncommitted && <strong>Uncommitted changes</strong>}
          {!isUncommitted && !compareTo && (
            <>
              <strong>Commit</strong> <span className="mono">{shortHash(hash)}</span>
            </>
          )}
          {compareTo && (
            <>
              <strong>Compare</strong> <HashLink hash={compareTo} onJump={onJump} /> → <HashLink hash={hash} onJump={onJump} />
            </>
          )}
        </div>
        <button type="button" className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close details">
          ✕
        </button>
      </header>
      <div className="details-body">
        <div className="details-left">
          {details && (
            <div className="meta">
              <div className="meta-row">
                <span className="meta-key">Commit</span>
                <span className="mono hash-full">{details.hash}</span>
                <CopyButton text={details.hash} label="full hash" />
              </div>
              {details.parents.length > 0 && (
                <div className="meta-row">
                  <span className="meta-key">{details.parents.length > 1 ? "Parents" : "Parent"}</span>
                  <span className="parents">
                    {details.parents.map((p) => (
                      <HashLink key={p} hash={p} onJump={onJump} />
                    ))}
                  </span>
                </div>
              )}
              <div className="meta-row">
                <span className="meta-key">Author</span>
                <span>
                  {details.author} <span className="muted">&lt;{details.authorEmail}&gt;</span>
                  {" · "}
                  <span title={absoluteTime(details.authorDate)}>{relativeTime(details.authorDate)}</span>
                </span>
              </div>
              {(details.committer !== details.author || details.committerDate !== details.authorDate) && (
                <div className="meta-row">
                  <span className="meta-key">Committer</span>
                  <span>
                    {details.committer} <span className="muted">&lt;{details.committerEmail}&gt;</span>
                    {" · "}
                    <span title={absoluteTime(details.committerDate)}>{relativeTime(details.committerDate)}</span>
                  </span>
                </div>
              )}
              <div className="message">
                <div className="message-subject">{details.subject}</div>
                {details.body.trim() && <pre className="message-body">{details.body.trim()}</pre>}
              </div>
            </div>
          )}
          {compareTo && <p className="muted pad">Changes from {shortHash(compareTo)} to {shortHash(hash)}.</p>}
          <div className="files-head">
            <span>
              {files ? plural(files.length, "file") : "Files"}
              {totals && (totals.a > 0 || totals.d > 0) && (
                <span className="counts mono">
                  {totals.a > 0 && <span className="add">+{totals.a}</span>}
                  {totals.d > 0 && <span className="del">−{totals.d}</span>}
                </span>
              )}
            </span>
            <span className="seg" role="group" aria-label="File view">
              <button type="button" aria-pressed={mode === "tree"} onClick={() => setMode("tree")}>
                Tree
              </button>
              <button type="button" aria-pressed={mode === "flat"} onClick={() => setMode("flat")}>
                List
              </button>
            </span>
          </div>
          {filesLoading && !files && <p className="muted pad">Loading…</p>}
          {filesError && <p className="error pad">{filesError}</p>}
          {files && <FileList files={files} mode={mode} selectedPath={selectedFile?.path} onSelect={setSelectedFile} />}
        </div>
        <div className="details-right">
          {selectedFile ? (
            <DiffView key={`${hash}|${compareTo}|${selectedFile.path}`} file={selectedFile} diff={diff.data} loading={diff.loading} error={diff.error} />
          ) : (
            <p className="muted pad">Select a file to view its diff.</p>
          )}
        </div>
      </div>
    </section>
  );
}
