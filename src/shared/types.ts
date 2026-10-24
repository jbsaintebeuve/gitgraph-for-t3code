/**
 * Contract shared by the server (src/server) and the UI (src/web).
 * Keep this file dependency-free: it is compiled by both tsconfigs.
 */

/** Pseudo-hash used for the "uncommitted changes" row the UI inserts above HEAD. */
export const UNCOMMITTED_HASH = "__uncommitted__";

export interface GraphCommit {
  hash: string;
  /** Parent hashes, first parent first. Empty for root commits. */
  parents: string[];
  author: string;
  authorEmail: string;
  /** Unix seconds. */
  authorDate: number;
  committer: string;
  /** Unix seconds. */
  committerDate: number;
  subject: string;
}

export type RefKind = "branch" | "remote" | "tag" | "stash";

export interface GitRef {
  /** Short display name: "main", "origin/main", "v1.0", "stash@{0}". */
  name: string;
  /** Full ref name: "refs/heads/main". */
  fullName: string;
  kind: RefKind;
  /** Commit the ref points to (peeled for annotated tags). */
  target: string;
  /** Local branch currently checked out in this worktree. */
  isHead?: boolean;
  /** Local branch upstream, e.g. "origin/main". */
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** The configured upstream no longer exists on the remote ("[gone]"). */
  upstreamGone?: boolean;
}

export interface StashEntry {
  /** "stash@{0}" */
  name: string;
  hash: string;
  /** Commit the stash was based on (first parent of the stash commit). */
  base: string;
  message: string;
  /** Unix seconds. */
  date: number;
}

export interface WorkingTreeStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

/** Operation in progress in the repository (merge/rebase/cherry-pick/revert stopped on conflicts). */
export type RepoOperation = "merge" | "rebase" | "cherry-pick" | "revert" | null;

export interface HeadInfo {
  /** Short branch name, absent when detached. */
  branch?: string;
  /** Absent in an empty repository. */
  hash?: string;
  detached: boolean;
}

export type GraphOrder = "topo" | "date" | "author-date";

export interface GraphQuery {
  repo: string;
  /** Number of commits to skip (pagination). Default 0. */
  skip?: number;
  /** Page size. Default 500, max 5000. */
  limit?: number;
  order?: GraphOrder;
  /** Restrict to these branches (short names); default: all branches, remotes and tags. */
  branches?: string[];
  includeRemotes?: boolean;
  includeStashes?: boolean;
  firstParent?: boolean;
}

export interface GraphPage {
  repo: string;
  head: HeadInfo;
  commits: GraphCommit[];
  /** Branches, remotes, tags and stashes. Refs under refs/t3/ (T3 Code checkpoints) are never included. */
  refs: GitRef[];
  stashes: StashEntry[];
  /** Null when the working tree is clean. */
  workingTree: WorkingTreeStatus | null;
  operation: RepoOperation;
  hasMore: boolean;
}

export type FileChangeStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U";

export interface FileChange {
  path: string;
  /** Previous path for renames/copies. */
  oldPath?: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface CommitDetails extends GraphCommit {
  body: string;
  committerEmail: string;
  files: FileChange[];
}

export interface FileDiff {
  path: string;
  /** Unified diff text for that single file (may be truncated). */
  patch: string;
  truncated: boolean;
}

/* ---------------------------------------------------------------- layout */

export interface LayoutNode {
  hash: string;
  parents: string[];
  /**
   * Pseudo row (the "uncommitted changes" row above HEAD). It takes a lane but never consumes
   * a palette colour: it inherits the colour of its first parent, so adding or removing it
   * does not change the colour of any real commit or edge.
   */
  pseudo?: boolean;
}

export interface LayoutRow {
  hash: string;
  /** Column of the commit dot. */
  lane: number;
  /** Palette index (UI maps it to a colour). */
  color: number;
}

export interface LayoutPoint {
  row: number;
  lane: number;
}

/**
 * A line from a commit to one of its parents. `points` goes top → bottom, one point per row
 * crossed (the line may shift lanes between rows). When the parent is not in the loaded
 * page, the last point has row === rows.length (line continues below the loaded window).
 */
export interface LayoutEdge {
  from: string;
  to: string;
  color: number;
  points: LayoutPoint[];
  /** True when this edge goes to a non-first parent (merge edge). */
  merge: boolean;
}

export interface GraphLayout {
  rows: LayoutRow[];
  edges: LayoutEdge[];
  /** Max lane index + 1. */
  laneCount: number;
}

/* --------------------------------------------------------------- actions */

export type GitAction =
  | { type: "checkout"; ref: string }
  | { type: "checkoutCommit"; hash: string }
  | { type: "createBranch"; name: string; startPoint: string; checkout: boolean }
  | { type: "deleteBranch"; name: string; force: boolean }
  | { type: "deleteRemoteBranch"; remote: string; name: string }
  | { type: "renameBranch"; oldName: string; newName: string }
  | { type: "merge"; ref: string; noFastForward: boolean; squash: boolean }
  | { type: "rebase"; onto: string }
  | { type: "cherryPick"; hash: string; noCommit: boolean }
  | { type: "revert"; hash: string }
  | { type: "reset"; hash: string; mode: "soft" | "mixed" | "hard" }
  | { type: "createTag"; name: string; hash: string; message?: string }
  | { type: "deleteTag"; name: string }
  | { type: "pushTag"; remote: string; name: string }
  | { type: "stashPush"; message?: string; includeUntracked: boolean }
  | { type: "stashApply"; name: string }
  | { type: "stashPop"; name: string }
  | { type: "stashDrop"; name: string }
  | { type: "stashBranch"; name: string; branch: string }
  | { type: "fetch"; remote?: string; prune: boolean }
  | { type: "pull"; rebase: boolean }
  | { type: "push"; branch: string; remote: string; setUpstream: boolean; force: "none" | "with-lease" }
  | { type: "abortOperation" }
  | { type: "continueOperation" };

export interface ActionResult {
  ok: boolean;
  /** Combined git stdout/stderr, shown to the user. */
  output: string;
  /** Set when the action stopped on conflicts. */
  conflicts?: string[];
}

/* ---------------------------------------------------------------- events */

/** Server-sent event names on /api/events. */
export type ServerEvent =
  | { event: "repos"; data: unknown }
  | { event: "repo-changed"; data: { repo: string } }
  | { event: "heartbeat"; data: string };
