import type { FileChange } from "../../shared/types.js";

export type TreeNode =
  | { type: "dir"; name: string; path: string; children: TreeNode[]; additions: number; deletions: number }
  | { type: "file"; name: string; path: string; file: FileChange };

/** Builds a directory tree; chains of single-child directories are collapsed ("src/web/lib"). */
export function buildFileTree(files: readonly FileChange[]): TreeNode[] {
  type MutableDir = { name: string; path: string; dirs: Map<string, MutableDir>; files: FileChange[] };
  const root: MutableDir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      let next = dir.dirs.get(name);
      if (!next) {
        next = { name, path: dir.path ? `${dir.path}/${name}` : name, dirs: new Map(), files: [] };
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    dir.files.push(file);
  }

  const convert = (dir: MutableDir): TreeNode[] => {
    const nodes: TreeNode[] = [];
    for (const child of [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      let current = child;
      let name = child.name;
      while (current.files.length === 0 && current.dirs.size === 1) {
        current = [...current.dirs.values()][0]!;
        name += `/${current.name}`;
      }
      const children = convert(current);
      const sum = (key: "additions" | "deletions") =>
        children.reduce((n, c) => n + (c.type === "file" ? c.file[key] : c[key]), 0);
      nodes.push({ type: "dir", name, path: current.path, children, additions: sum("additions"), deletions: sum("deletions") });
    }
    for (const file of [...dir.files].sort((a, b) => a.path.localeCompare(b.path))) {
      nodes.push({ type: "file", name: file.path.slice(file.path.lastIndexOf("/") + 1), path: file.path, file });
    }
    return nodes;
  };
  return convert(root);
}
