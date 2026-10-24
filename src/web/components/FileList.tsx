import { useMemo, useState } from "react";
import type { FileChange } from "../../shared/types.js";
import { buildFileTree, type TreeNode } from "../lib/tree";

export type FileViewMode = "tree" | "flat";

export interface FileListProps {
  files: FileChange[];
  mode: FileViewMode;
  selectedPath: string | undefined;
  onSelect: (file: FileChange) => void;
}

const STATUS_TITLE: Record<string, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Unmerged",
};

function Counts({ additions, deletions, binary }: { additions: number; deletions: number; binary?: boolean }) {
  if (binary) return <span className="counts muted">bin</span>;
  return (
    <span className="counts mono">
      {additions > 0 && <span className="add">+{additions}</span>}
      {deletions > 0 && <span className="del">−{deletions}</span>}
    </span>
  );
}

function FileRow({
  file,
  label,
  depth,
  selected,
  onSelect,
}: {
  file: FileChange;
  label: string;
  depth: number;
  selected: boolean;
  onSelect: (file: FileChange) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`file-row${selected ? " selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(file)}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      >
        <span className={`status status-${file.status}`} title={STATUS_TITLE[file.status]}>
          {file.status}
        </span>
        <span className="file-name">{label}</span>
        {file.oldPath && <span className="muted file-old">← {file.oldPath}</span>}
        <Counts additions={file.additions} deletions={file.deletions} binary={file.binary} />
      </button>
    </li>
  );
}

function Tree({
  nodes,
  depth,
  selectedPath,
  onSelect,
}: {
  nodes: TreeNode[];
  depth: number;
  selectedPath: string | undefined;
  onSelect: (file: FileChange) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  return (
    <>
      {nodes.map((node) => {
        if (node.type === "file") {
          return <FileRow key={node.path} file={node.file} label={node.name} depth={depth} selected={node.path === selectedPath} onSelect={onSelect} />;
        }
        const isCollapsed = collapsed.has(node.path);
        return (
          <li key={`d:${node.path}`}>
            <button
              type="button"
              className="file-row dir"
              style={{ paddingLeft: 8 + depth * 14 }}
              aria-expanded={!isCollapsed}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(node.path)) next.add(node.path);
                  return next;
                })
              }
            >
              <span className="chevron">{isCollapsed ? "▸" : "▾"}</span>
              <span className="file-name">{node.name}</span>
              <Counts additions={node.additions} deletions={node.deletions} />
            </button>
            {!isCollapsed && (
              <ul>
                <Tree nodes={node.children} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}

export function FileList({ files, mode, selectedPath, onSelect }: FileListProps) {
  const tree = useMemo(() => (mode === "tree" ? buildFileTree(files) : []), [files, mode]);
  if (files.length === 0) return <p className="muted pad">No file changes.</p>;
  return (
    <ul className="file-list">
      {mode === "tree" ? (
        <Tree nodes={tree} depth={0} selectedPath={selectedPath} onSelect={onSelect} />
      ) : (
        files.map((file) => (
          <FileRow key={file.path} file={file} label={file.path} depth={0} selected={file.path === selectedPath} onSelect={onSelect} />
        ))
      )}
    </ul>
  );
}
