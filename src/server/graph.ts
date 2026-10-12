import { lstat, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
  CommitDetails,
  FileChange,
  FileChangeStatus,
  FileDiff,
  GitRef,
  GraphCommit,
  GraphOrder,
  GraphPage,
  GraphQuery,
  HeadInfo,
  RepoOperation,
  StashEntry,
  WorkingTreeStatus,
} from "../shared/types.js";
import { GitError, runGit, runGitCapped } from "./git.js";

/** Invalid user input (maps to HTTP 400). */
export class BadRequestError extends Error {}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 1000;
const MAX_COUNTED_FILE_BYTES = 1024 * 1024;
/** Field/record separators that cannot realistically appear in names or subjects. */
const FS = "\x1f";
type S8 = [string, string, string, string, string, string, string, string];
const HASH_RE = /^[0-9a-f]{4,64}$/i;
const COMMIT_FORMAT = ["%H", "%P", "%an", "%ae", "%at", "%cn", "%ct", "%s"].join("%x1f");
/** Refs are listed per namespace on purpose: `--all` would pull in refs/t3/* checkpoint refs. */
const REF_FORMAT = [
  "%(refname)",
  "%(objectname)",
  "%(objecttype)",
  "%(*objectname)",
  "%(*objecttype)",
  "%(upstream:short)",
  "%(upstream:track)",
  "%(HEAD)",
].join("%1f");

/** Splits a separator-delimited record into a fixed-size tuple (missing trailing fields become ""). */
function fields<T extends string[]>(line: string, count: T["length"]): T {
  const parts = line.split(FS);
  while (parts.length < count) parts.push("");
  return parts as T;
}

/* ------------------------------------------------------------ validation */

function assertHash(hash: string): void {
  if (!HASH_RE.test(hash)) throw new BadRequestError("invalid commit hash");
}

function assertPath(path: string): void {
  const invalid =
    path === "" ||
    path.startsWith("-") ||
    path.includes("\0") ||
    isAbsolute(path) ||
    path.split("/").some((segment) => segment === "..");
  if (invalid) throw new BadRequestError("invalid path");
}

/** Resolves a user-supplied hash to a full commit id, or throws a 400. */
async function resolveCommit(repo: string, hash: string): Promise<string> {
  assertHash(hash);
  try {
    return (await runGit(repo, ["rev-parse", "--verify", "-q", `${hash}^{commit}`])).trim();
  } catch (error) {
    if (error instanceof GitError) throw new BadRequestError(`unknown commit ${hash}`);
    throw error;
  }
}

async function hasHead(repo: string): Promise<boolean> {
  return runGit(repo, ["rev-parse", "--verify", "-q", "HEAD"]).then(
    () => true,
    () => false,
  );
}

/* ------------------------------------------------------------------ refs */

async function readHead(repo: string): Promise<HeadInfo> {
  const [branch, hash] = await Promise.all([
    runGit(repo, ["symbolic-ref", "-q", "--short", "HEAD"]).then(
      (out) => out.trim(),
      () => undefined,
    ),
    runGit(repo, ["rev-parse", "--verify", "-q", "HEAD"]).then(
      (out) => out.trim(),
      () => undefined,
    ),
  ]);
  const head: HeadInfo = { detached: branch === undefined && hash !== undefined };
  if (branch) head.branch = branch;
  if (hash) head.hash = hash;
  return head;
}

function parseTrack(track: string): Pick<GitRef, "ahead" | "behind" | "upstreamGone"> {
  if (track === "[gone]") return { upstreamGone: true };
  return {
    ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
  };
}

async function readRefs(repo: string): Promise<GitRef[]> {
  const out = await runGit(repo, [
    "for-each-ref",
    `--format=${REF_FORMAT}`,
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]);
  const refs: GitRef[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [fullName, oid, type, peeledOid, peeledType, upstream, track, headMark] = fields<S8>(line, 8);
    // Only refs resolving to a commit can be drawn (tags on trees/blobs are skipped).
    const target = peeledOid ? (peeledType === "commit" ? peeledOid : "") : type === "commit" ? oid : "";
    if (!target) continue;
    if (fullName.startsWith("refs/heads/")) {
      const ref: GitRef = { name: fullName.slice(11), fullName, kind: "branch", target };
      if (headMark === "*") ref.isHead = true;
      if (upstream) Object.assign(ref, { upstream }, parseTrack(track));
      refs.push(ref);
    } else if (fullName.startsWith("refs/remotes/")) {
      // refs/remotes/<remote>/HEAD is a symbolic pointer, not a branch.
      if (fullName.endsWith("/HEAD")) continue;
      refs.push({ name: fullName.slice(13), fullName, kind: "remote", target });
    } else if (fullName.startsWith("refs/tags/")) {
      refs.push({ name: fullName.slice(10), fullName, kind: "tag", target });
    }
  }
  return refs;
}

async function readStashes(repo: string): Promise<StashEntry[]> {
  const out = await runGit(repo, ["stash", "list", "--format=%H%x1f%gd%x1f%P%x1f%ct%x1f%gs"]);
  const stashes: StashEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [hash, name, parents, date, message] = fields<[string, string, string, string, string]>(line, 5);
    stashes.push({ name, hash, base: parents.split(" ")[0] ?? "", message, date: Number(date) });
  }
  return stashes;
}

/* ----------------------------------------------------- working tree state */

async function readWorkingTree(repo: string): Promise<WorkingTreeStatus | null> {
  // --no-optional-locks: do not fight the user's own git commands over index.lock.
  const out = await runGit(repo, ["--no-optional-locks", "status", "--porcelain=v2", "-z"]).catch(() => "");
  const tokens = out.split("\0");
  const status: WorkingTreeStatus = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i] ?? "";
    if (entry.startsWith("1 ") || entry.startsWith("2 ")) {
      if (entry[2] !== ".") status.staged++;
      if (entry[3] !== ".") status.unstaged++;
      if (entry[0] === "2") i++; // renamed entries carry the original path as an extra token
    } else if (entry.startsWith("u ")) {
      status.conflicted++;
    } else if (entry.startsWith("? ")) {
      status.untracked++;
    }
  }
  const dirty = status.staged + status.unstaged + status.untracked + status.conflicted > 0;
  return dirty ? status : null;
}

export async function readOperation(repo: string): Promise<RepoOperation> {
  const markers: Array<[string, RepoOperation]> = [
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
  ];
  // --git-path resolves per-worktree files correctly in linked worktrees.
  const out = await runGit(repo, ["rev-parse", ...markers.flatMap(([name]) => ["--git-path", name])]).catch(() => "");
  const paths = out.split("\n");
  for (const [index, [, operation]] of markers.entries()) {
    const path = paths[index];
    if (path && (await stat(resolve(repo, path)).then(() => true, () => false))) return operation;
  }
  return null;
}

/* ----------------------------------------------------------------- graph */

const ORDER_FLAGS: Record<GraphOrder, string> = {
  topo: "--topo-order",
  date: "--date-order",
  "author-date": "--author-date-order",
};

/** Revisions making up the default view; null when there is nothing to walk (git would default to HEAD). */
function defaultRevs(refs: GitRef[], head: HeadInfo): string[] | null {
  const revs: string[] = [];
  if (refs.some((r) => r.kind === "branch")) revs.push("--branches");
  if (refs.some((r) => r.kind === "remote")) revs.push("--remotes");
  if (refs.some((r) => r.kind === "tag")) revs.push("--tags");
  if (head.detached) revs.push("HEAD");
  return revs.length ? revs : null;
}

function parseCommits(out: string): GraphCommit[] {
  const commits: GraphCommit[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [hash, parents, author, authorEmail, authorDate, committer, committerDate, subject] = fields<S8>(line, 8);
    commits.push({
      hash,
      parents: parents ? parents.split(" ") : [],
      author,
      authorEmail,
      authorDate: Number(authorDate),
      committer,
      committerDate: Number(committerDate),
      subject,
    });
  }
  return commits;
}

export async function loadGraphPage(query: GraphQuery): Promise<GraphPage> {
  const repo = query.repo;
  const skip = Math.max(0, Math.floor(query.skip ?? 0));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)));
  const order = query.order ?? "date";
  if (!(order in ORDER_FLAGS)) throw new BadRequestError("invalid order");
  const includeRemotes = query.includeRemotes ?? true;
  const includeStashes = query.includeStashes ?? true;

  const [head, allRefs, stashes, workingTree, operation] = await Promise.all([
    readHead(repo),
    readRefs(repo),
    includeStashes ? readStashes(repo) : Promise.resolve([]),
    readWorkingTree(repo),
    readOperation(repo),
  ]);

  let revs: string[] | null;
  if (query.branches?.length) {
    revs = query.branches.map((name) => {
      const ref =
        allRefs.find((r) => r.kind === "branch" && r.name === name) ??
        allRefs.find((r) => r.kind === "remote" && r.name === name);
      if (!ref) throw new BadRequestError(`unknown branch ${name}`);
      return ref.fullName;
    });
    // An explicit branch selection is exact: remote branches only appear when selected by name.
  } else {
    revs = defaultRevs(allRefs.filter((r) => includeRemotes || r.kind !== "remote"), head);
  }
  const stashRevs = stashes.map((s) => s.hash);
  const walk = [...(revs ?? []), ...stashRevs];

  let commits: GraphCommit[] = [];
  let hasMore = false;
  if (walk.length) {
    const out = await runGit(repo, [
      "log",
      `--format=${COMMIT_FORMAT}`,
      ORDER_FLAGS[order],
      ...(query.firstParent ? ["--first-parent"] : []),
      `--skip=${skip}`,
      `--max-count=${limit + 1}`,
      ...walk,
      "--",
    ]);
    commits = parseCommits(out);
    hasMore = commits.length > limit;
    commits = commits.slice(0, limit);
  }

  if (stashes.length) {
    // A stash commit has extra parents (index / untracked-files commits) that are
    // implementation details: drop them and draw the stash as a child of its base only.
    const hidden = new Set<string>();
    const stashHashes = new Set(stashes.map((s) => s.hash));
    for (const stash of stashes) {
      const parents = (await runGit(repo, ["rev-list", "--parents", "-n", "1", stash.hash])).trim().split(" ");
      for (const extra of parents.slice(2)) hidden.add(extra);
    }
    commits = commits
      .filter((c) => !hidden.has(c.hash))
      .map((c) => (stashHashes.has(c.hash) ? { ...c, parents: c.parents.slice(0, 1) } : c));
  }

  const refs = allRefs.filter((r) => includeRemotes || r.kind !== "remote");
  for (const stash of stashes) {
    refs.push({ name: stash.name, fullName: `refs/${stash.name}`, kind: "stash", target: stash.hash });
  }

  return { repo, head, commits, refs, stashes, workingTree, operation, hasMore };
}

/* ---------------------------------------------------------- file changes */

function mapStatus(letter: string): FileChangeStatus {
  return "AMDRCTU".includes(letter) ? (letter as FileChangeStatus) : "M";
}

/** Parses `--name-status -z` and `--numstat -z` outputs of the same diff into FileChange[]. */
function parseChanges(nameStatus: string, numstat: string): FileChange[] {
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const numTokens = numstat.split("\0");
  for (let i = 0; i < numTokens.length; i++) {
    const token = numTokens[i];
    if (!token) continue;
    const firstTab = token.indexOf("\t");
    const secondTab = token.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = token.slice(0, firstTab);
    const deleted = token.slice(firstTab + 1, secondTab);
    let path = token.slice(secondTab + 1);
    if (path === "") {
      i += 2; // rename: old path, then new path in the following tokens
      path = numTokens[i] ?? "";
    }
    const binary = added === "-";
    stats.set(path, { additions: binary ? 0 : Number(added), deletions: binary ? 0 : Number(deleted), binary });
  }

  const files: FileChange[] = [];
  const tokens = nameStatus.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (!code) continue;
    const status = mapStatus(code[0] ?? "M");
    const isMove = status === "R" || status === "C";
    const oldPath = isMove ? (tokens[++i] ?? "") : undefined;
    const path = tokens[++i] ?? "";
    const stat = stats.get(path) ?? { additions: 0, deletions: 0, binary: false };
    files.push({ path, ...(oldPath !== undefined ? { oldPath } : {}), status, ...stat });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function changedFiles(repo: string, command: string[], revs: string[]): Promise<FileChange[]> {
  const common = ["-M", "-z", "--no-ext-diff"];
  const [nameStatus, numstat] = await Promise.all([
    runGit(repo, [...command, ...common, "--name-status", ...revs, "--"]),
    runGit(repo, [...command, ...common, "--numstat", ...revs, "--"]),
  ]);
  return parseChanges(nameStatus, numstat);
}

const TREE_DIFF = ["diff-tree", "-r", "--no-commit-id"];

/** Diff arguments of a commit against its first parent (or the empty tree for a root commit). */
async function commitDiffBase(repo: string, hash: string): Promise<{ command: string[]; revs: string[] }> {
  const parents = (await runGit(repo, ["rev-list", "--parents", "-n", "1", hash])).trim().split(" ");
  const firstParent = parents[1];
  return firstParent
    ? { command: TREE_DIFF, revs: [firstParent, hash] }
    : { command: [...TREE_DIFF, "--root"], revs: [hash] };
}

export async function loadCommitDetails(repo: string, hash: string): Promise<CommitDetails> {
  const full = await resolveCommit(repo, hash);
  const [meta, base] = await Promise.all([
    runGit(repo, ["show", "-s", `--format=${COMMIT_FORMAT}%x1f%ce%x1f%b`, full, "--"]),
    commitDiffBase(repo, full),
  ]);
  const files = await changedFiles(repo, base.command, base.revs);
  const parts = meta.split(FS);
  const [commit] = parseCommits(parts.slice(0, 8).join(FS));
  if (!commit) throw new BadRequestError(`unknown commit ${hash}`);
  return { ...commit, committerEmail: parts[8] ?? "", body: parts.slice(9).join(FS).trim(), files };
}

export async function compareCommits(repo: string, from: string, to: string): Promise<FileChange[]> {
  const [a, b] = await Promise.all([resolveCommit(repo, from), resolveCommit(repo, to)]);
  return changedFiles(repo, ["diff-tree", "-r", "--no-commit-id"], [a, b]);
}

/* ----------------------------------------------------------------- diffs */

const PATCH_FLAGS = ["-M", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

async function capped(repo: string, args: string[], path: string, okExitCodes?: number[]): Promise<FileDiff> {
  const { stdout, truncated } = await runGitCapped(repo, args, { maxBuffer: MAX_PATCH_BYTES, okExitCodes });
  if (!truncated) return { path, patch: stdout, truncated: false };
  // Drop the possibly half-written last line.
  return { path, patch: stdout.slice(0, stdout.lastIndexOf("\n") + 1), truncated: true };
}

/**
 * Patch of a single file in `hash` (against its first parent), or from `compareTo` to `hash`
 * when given. `oldPath` must be passed for renames, otherwise git reports the file as added.
 */
export async function loadFileDiff(
  repo: string,
  hash: string,
  path: string,
  opts: { compareTo?: string; oldPath?: string } = {},
): Promise<FileDiff> {
  assertPath(path);
  if (opts.oldPath !== undefined) assertPath(opts.oldPath);
  const full = await resolveCommit(repo, hash);
  const base = opts.compareTo
    ? { command: TREE_DIFF, revs: [await resolveCommit(repo, opts.compareTo), full] }
    : await commitDiffBase(repo, full);
  const paths = opts.oldPath !== undefined && opts.oldPath !== path ? [path, opts.oldPath] : [path];
  return capped(
    repo,
    ["--literal-pathspecs", ...base.command, "-p", ...PATCH_FLAGS, ...base.revs, "--", ...paths],
    path,
  );
}

/* ---------------------------------------------------- uncommitted changes */

async function listUntracked(repo: string): Promise<string[]> {
  const out = await runGit(repo, ["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"]);
  return out.split("\0").filter(Boolean);
}

/** Counts lines of a small text file so untracked files get an "additions" figure. */
async function countUntracked(repo: string, path: string): Promise<Pick<FileChange, "additions" | "binary">> {
  const full = resolve(repo, path);
  const info = await lstat(full).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_COUNTED_FILE_BYTES) return { additions: 0, binary: false };
  const data = await readFile(full).catch(() => Buffer.alloc(0));
  if (data.subarray(0, 8000).includes(0)) return { additions: 0, binary: true };
  let lines = 0;
  for (const byte of data) if (byte === 10) lines++;
  if (data.length > 0 && data[data.length - 1] !== 10) lines++;
  return { additions: lines, binary: false };
}

/** Working tree (staged + unstaged + untracked) versus HEAD. */
export async function loadUncommittedChanges(repo: string): Promise<FileChange[]> {
  // Before the first commit there is no HEAD: fall back to what is staged.
  const base = (await hasHead(repo)) ? ["HEAD"] : ["--cached"];
  const [tracked, untracked] = await Promise.all([changedFiles(repo, ["diff"], base), listUntracked(repo)]);
  const known = new Set(tracked.map((f) => f.path));
  const added = await Promise.all(
    untracked
      .filter((path) => !known.has(path))
      .map(async (path): Promise<FileChange> => ({ path, status: "A", deletions: 0, ...(await countUntracked(repo, path)) })),
  );
  return [...tracked, ...added].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function loadUncommittedFileDiff(
  repo: string,
  path: string,
  opts: { oldPath?: string } = {},
): Promise<FileDiff> {
  assertPath(path);
  if (opts.oldPath !== undefined) assertPath(opts.oldPath);
  const base = (await hasHead(repo)) ? ["HEAD"] : ["--cached"];
  const paths = opts.oldPath !== undefined && opts.oldPath !== path ? [path, opts.oldPath] : [path];
  const tracked = await capped(
    repo,
    ["--literal-pathspecs", "diff", ...PATCH_FLAGS, ...base, "--", ...paths],
    path,
  );
  if (tracked.patch !== "") return tracked;
  // Untracked: only accept paths git itself lists, so --no-index can never read arbitrary files.
  if (!(await listUntracked(repo)).includes(path)) return tracked;
  return capped(
    repo,
    ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--", "/dev/null", path],
    path,
    [1],
  );
}

/* ---------------------------------------------------------------- search */

/** Hashes of commits matching `text` in message, author or hash prefix (literal, case-insensitive). */
export async function searchCommits(repo: string, text: string): Promise<string[]> {
  const needle = text.trim();
  if (needle === "") return [];
  if (needle.length > 200 || /[\0-\x1f]/.test(needle)) throw new BadRequestError("invalid search text");

  const [head, refs] = await Promise.all([readHead(repo), readRefs(repo)]);
  const revs = defaultRevs(refs, head);
  const results = new Set<string>();

  if (/^[0-9a-f]{4,40}$/i.test(needle)) {
    const candidates = (await runGit(repo, ["rev-parse", `--disambiguate=${needle.toLowerCase()}`])).split("\n").filter(Boolean);
    for (const candidate of candidates.slice(0, 20)) {
      const commit = await runGit(repo, ["rev-parse", "--verify", "-q", `${candidate}^{commit}`]).then(
        (out) => out.trim(),
        () => undefined,
      );
      if (commit) results.add(commit);
    }
  }

  if (revs) {
    // --grep and --author are ANDed by git, so each criterion needs its own walk.
    const walks = ["--grep", "--author"].map((flag) =>
      runGit(repo, ["log", "-i", "-F", `${flag}=${needle}`, "--format=%H", `--max-count=${MAX_SEARCH_RESULTS}`, ...revs, "--"]),
    );
    for (const out of await Promise.all(walks)) for (const hash of out.split("\n")) if (hash) results.add(hash);
  }
  return [...results].slice(0, MAX_SEARCH_RESULTS);
}
