/**
 * RepoWatcher: turns filesystem activity in registered repositories into debounced
 * `repo-changed` notifications for the SSE endpoint.
 *
 * Lifecycle
 *   Repositories are only watched while at least one subscriber (an open SSE connection)
 *   exists; the last `unsubscribe` closes every watcher and timer, so idle cost is ~zero.
 *
 * What is watched (per repository)
 *   - Git metadata, using `git rev-parse --git-dir --git-common-dir` so linked worktrees work:
 *       per-worktree git dir : HEAD, index, MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD,
 *                              ORIG_HEAD, FETCH_HEAD, rebase-merge/, rebase-apply/
 *       common git dir       : packed-refs, refs/** (heads, remotes, tags, stash)
 *     The git dirs are watched non-recursively (so directories that do not exist yet, such as
 *     rebase-merge/, are noticed when created in their parent) except refs/, which is watched
 *     recursively. refs/stash is covered by refs/; logs/refs/stash is not needed because every
 *     stash operation also rewrites refs/stash. refs/t3/** (T3 Code checkpoints) and `*.lock`
 *     files are ignored.
 *   - The working tree, which only affects the "uncommitted changes" row.
 *
 * Working-tree strategy (`strategy` option, default "auto")
 *   - "native": `fs.watch(root, {recursive: true})`, filtered to skip .git/ and node_modules/.
 *     Default on macOS (FSEvents, cheap) and Windows.
 *   - "poll": no tree watcher; the repository state is re-checked every `pollIntervalMs`
 *     (2 s) while watched. Default on Linux, where recursive fs.watch is emulated in JS with
 *     one inotify watch per directory (expensive on big trees, unsupported before Node 20).
 *     "native" can still be forced on Linux for small repositories.
 *   - Any native failure at runtime (ENOSPC / inotify limit, EMFILE, unsupported recursive
 *     watch) downgrades that repository to "poll" and logs once with a hint about
 *     `fs.inotify.max_user_watches`.
 *   In poll mode refs are part of the polled signature as well, so even if the git-dir
 *   watchers fail, ref changes are still noticed (with up to 2 s latency).
 *   On Linux the git-dir `refs/` tree is watched with a small hand-rolled recursive watcher
 *   (one inotify watch per directory) instead of the JS recursive implementation.
 *
 * Debounce
 *   Raw events are coalesced: trailing `debounceMs` (250 ms) with a `maxWaitMs` (1 s) cap, so a
 *   long rebase yields about one event per second instead of hundreds.
 *   After the debounce, the signature (hash of `git status --porcelain=v2 -z --branch`, the
 *   mtime/size of changed files, and the refs listing) is computed. An event is emitted if the
 *   trigger was a git metadata change or if the signature differs from the last one. Working
 *   tree-only triggers (and `index`, which git rewrites on plain reads) never emit when the
 *   signature is unchanged. Git is run with GIT_OPTIONAL_LOCKS=0 so our own status call does
 *   not rewrite the index and re-trigger the watcher.
 *
 * Why not chokidar: fs.watch (recursive on macOS/Windows, per-directory on git dirs) plus a
 * poll fallback covers every requirement; an extra dependency brings nothing here.
 */
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runGit, runGitCapped } from "./git.js";
import type { RepoRegistry } from "./repos.js";

export type WatchStrategy = "auto" | "native" | "poll";

export interface RepoWatcherOptions {
  /** Repositories are picked up from the registry (now and when registered later). */
  registry?: RepoRegistry;
  strategy?: WatchStrategy;
  debounceMs?: number;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  log?: (message: string) => void;
}

type Listener = (repo: string) => void;
type Kind = "meta" | "tree";

/** Entries of the (per-worktree) git dir that matter. */
const GIT_DIR_NAMES = new Set([
  "HEAD",
  "ORIG_HEAD",
  "FETCH_HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
  "refs",
]);
const PACKED_REFS = new Set(["packed-refs"]);
const MAX_STAT_FILES = 500;
/**
 * The signature lists untracked files individually (`--untracked-files=all`) so that a file added
 * inside an already-untracked directory changes it. On huge untracked trees git's output is capped
 * and the repository permanently falls back to git's default (one entry per directory, whose
 * mtime is hashed instead), so polling never gets expensive.
 */
const MAX_STATUS_BYTES = 4 * 1024 * 1024;

function isLock(name: string): boolean {
  return name.endsWith(".lock");
}

/** `name` is relative to the watched directory; null when the platform does not report it. */
function relevantGitDirEntry(name: string | null, extra: Set<string>): Kind | undefined {
  if (name === null) return "meta";
  const first = name.split(/[\\/]/)[0] ?? "";
  if (isLock(first)) return undefined;
  if (first === "index") return "tree";
  if (GIT_DIR_NAMES.has(first) || extra.has(first)) return "meta";
  return undefined;
}

function isIgnoredRefPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  return parts[0] === "t3" || parts.some(isLock);
}

function isIgnoredTreePath(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  return parts[0] === ".git" || parts.includes("node_modules");
}

/** Recursive watch of a (small) directory tree without relying on fs.watch's `recursive`. */
function watchTreeManually(
  root: string,
  onEvent: (rel: string) => void,
  onError: (error: NodeJS.ErrnoException) => void,
  skipTopLevel: string,
): () => void {
  const watchers = new Map<string, FSWatcher>();
  let closed = false;

  const add = async (dir: string): Promise<void> => {
    if (closed || watchers.has(dir)) return;
    try {
      const watcher = watch(dir, (_type, name) => {
        const rel = name ? join(relative(root, dir), String(name)) : relative(root, dir);
        onEvent(rel);
        if (name) void add(join(dir, String(name)));
      });
      watcher.on("error", (error) => {
        watchers.delete(dir);
        watcher.close();
        onError(error as NodeJS.ErrnoException);
      });
      watchers.set(dir, watcher);
    } catch (error) {
      onError(error as NodeJS.ErrnoException);
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (dir === root && entry.name === skipTopLevel) continue;
      await add(join(dir, entry.name));
    }
  };

  const relative = (from: string, to: string) => (to === from ? "" : to.slice(from.length + 1));
  void add(root).then(() => undefined);
  return () => {
    closed = true;
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
}

/** Extracts changed paths from `git status --porcelain=v2 -z` output. */
function statusPaths(output: string): string[] {
  const records = output.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? "";
    const type = record[0];
    if (type === "1") paths.push(record.split(" ").slice(8).join(" "));
    else if (type === "2") {
      paths.push(record.split(" ").slice(9).join(" "));
      i++; // original path follows as its own record
    } else if (type === "u") paths.push(record.split(" ").slice(10).join(" "));
    else if (type === "?") paths.push(record.slice(2));
  }
  return paths;
}

class RepoWatch {
  strategy: "native" | "poll";
  private closers: Array<() => void> = [];
  private timer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private firstEventAt = 0;
  private pending = new Set<Kind>();
  private running = false;
  private rerun = false;
  private stopped = false;
  private lastSignature: string | undefined;
  private baseline: Promise<void> = Promise.resolve();
  private untrackedAll = true;

  constructor(
    readonly path: string,
    private readonly config: Required<Pick<RepoWatcherOptions, "debounceMs" | "maxWaitMs" | "pollIntervalMs">> & {
      strategy: "native" | "poll";
      log: (message: string) => void;
      onResourceLimit: (error: NodeJS.ErrnoException) => void;
      emit: (repo: string) => void;
    },
  ) {
    this.strategy = config.strategy;
  }

  /** Resolves once watchers are installed and the baseline signature is known. */
  async start(): Promise<void> {
    let gitDir: string;
    let commonDir: string;
    try {
      const out = await runGit(this.path, ["rev-parse", "--git-dir", "--git-common-dir"]);
      const [a, b] = out.trim().split("\n");
      gitDir = resolve(this.path, a ?? ".git");
      commonDir = resolve(this.path, b ?? a ?? ".git");
    } catch (error) {
      this.config.log(`cannot watch ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (this.stopped) return;

    this.watchDir(gitDir, PACKED_REFS);
    if (commonDir !== gitDir) this.watchDir(commonDir, PACKED_REFS);
    this.watchRefs(join(commonDir, "refs"));
    if (this.strategy === "native") this.watchTree();
    if (this.strategy === "poll") this.startPolling();

    this.baseline = this.signature().then((sig) => {
      this.lastSignature = sig;
    });
    await this.baseline;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.pollTimer);
    for (const close of this.closers) close();
    this.closers = [];
  }

  private onError(what: string, error: NodeJS.ErrnoException): void {
    if (error.code === "ENOSPC" || error.code === "EMFILE") {
      this.config.onResourceLimit(error);
      this.fallbackToPolling();
    } else {
      this.config.log(`watch error (${what}) on ${this.path}: ${error.message}`);
    }
  }

  private fallbackToPolling(): void {
    if (this.strategy === "poll" || this.stopped) return;
    this.strategy = "poll";
    this.startPolling();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.flush(new Set()), this.config.pollIntervalMs);
    this.pollTimer.unref();
  }

  private watchDir(dir: string, extra: Set<string>): void {
    try {
      const watcher = watch(dir, (_type, name) => {
        const kind = relevantGitDirEntry(name === null ? null : String(name), extra);
        if (kind) this.trigger(kind);
      });
      watcher.on("error", (error) => this.onError("git dir", error as NodeJS.ErrnoException));
      this.closers.push(() => watcher.close());
    } catch (error) {
      this.onError("git dir", error as NodeJS.ErrnoException);
    }
  }

  private watchRefs(refsDir: string): void {
    const onEvent = (rel: string) => {
      if (!isIgnoredRefPath(rel)) this.trigger("meta");
    };
    if (process.platform === "darwin" || process.platform === "win32") {
      try {
        const watcher = watch(refsDir, { recursive: true }, (_type, name) => onEvent(name ? String(name) : ""));
        watcher.on("error", (error) => this.onError("refs", error as NodeJS.ErrnoException));
        this.closers.push(() => watcher.close());
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOSPC") return this.onError("refs", error as NodeJS.ErrnoException);
        // recursive unsupported: fall through to the manual implementation
      }
    }
    this.closers.push(watchTreeManually(refsDir, onEvent, (e) => this.onError("refs", e), "t3"));
  }

  private watchTree(): void {
    try {
      const watcher = watch(this.path, { recursive: true }, (_type, name) => {
        if (name === null || !isIgnoredTreePath(String(name))) this.trigger("tree");
      });
      watcher.on("error", (error) => this.onError("worktree", error as NodeJS.ErrnoException));
      this.closers.push(() => watcher.close());
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOSPC" || err.code === "EMFILE") this.onError("worktree", err);
      else {
        this.config.log(`recursive watch unavailable for ${this.path} (${err.code ?? err.message}); polling instead`);
        this.fallbackToPolling();
      }
    }
  }

  private trigger(kind: Kind): void {
    if (this.stopped) return;
    this.pending.add(kind);
    const now = Date.now();
    if (!this.timer) this.firstEventAt = now;
    clearTimeout(this.timer);
    const delay = Math.max(0, Math.min(this.config.debounceMs, this.firstEventAt + this.config.maxWaitMs - now));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const kinds = this.pending;
      this.pending = new Set();
      void this.flush(kinds);
    }, delay);
  }

  private async flush(kinds: Set<Kind>): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      for (const kind of kinds) this.pending.add(kind);
      return;
    }
    this.running = true;
    try {
      await this.baseline;
      const signature = await this.signature();
      if (this.stopped) return;
      const changed = signature !== this.lastSignature;
      this.lastSignature = signature;
      if (changed || kinds.has("meta")) this.config.emit(this.path);
    } finally {
      this.running = false;
      if (this.rerun && !this.stopped) {
        this.rerun = false;
        const kinds = this.pending;
        this.pending = new Set();
        void this.flush(kinds);
      }
    }
  }

  private async status(env: Record<string, string>): Promise<string> {
    const base = ["status", "--porcelain=v2", "-z", "--branch"];
    if (this.untrackedAll) {
      const result = await runGitCapped(this.path, [...base, "--untracked-files=all"], { env, maxBuffer: MAX_STATUS_BYTES });
      if (!result.truncated) return result.stdout;
      this.untrackedAll = false;
      this.config.log(`${this.path} has a very large number of untracked files; change detection inside untracked directories is reduced`);
    }
    return runGit(this.path, base, { env });
  }

  private async signature(): Promise<string> {
    const env = { GIT_OPTIONAL_LOCKS: "0" };
    try {
      const [status, refs] = await Promise.all([
        this.status(env),
        runGit(
          this.path,
          ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes", "refs/tags", "refs/stash"],
          { env },
        ),
      ]);
      const hash = createHash("sha1").update(status).update("\0\0").update(refs);
      // porcelain v2 does not change when an already-modified file is edited again.
      const files = statusPaths(status).slice(0, MAX_STAT_FILES);
      const stats = await Promise.all(
        files.map((file) =>
          stat(join(this.path, file)).then(
            (s) => `${file}:${s.mtimeMs}:${s.size}`,
            () => `${file}:gone`,
          ),
        ),
      );
      return hash.update("\0\0").update(stats.join("\n")).digest("hex");
    } catch {
      return "error";
    }
  }
}

export class RepoWatcher {
  private readonly listeners = new Set<Listener>();
  private readonly known = new Set<string>();
  private readonly watches = new Map<string, RepoWatch>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly options: Required<Omit<RepoWatcherOptions, "registry">>;
  private limitLogged = false;
  private unregister: (() => void) | undefined;

  constructor(options: RepoWatcherOptions = {}) {
    this.options = {
      strategy: options.strategy ?? "auto",
      debounceMs: options.debounceMs ?? 250,
      maxWaitMs: options.maxWaitMs ?? 1000,
      pollIntervalMs: options.pollIntervalMs ?? 2000,
      log: options.log ?? ((message) => console.warn(`[gitgraph] ${message}`)),
    };
    const registry = options.registry;
    if (registry) {
      const sync = () => registry.list().forEach((entry) => void this.addRepo(entry.path));
      sync();
      this.unregister = registry.onChange(sync);
    }
  }

  /** Number of active subscribers (open SSE connections). */
  get subscriberCount(): number {
    return this.listeners.size;
  }

  /** Strategy currently used for a repo, or undefined when it is not being watched. */
  strategyOf(repo: string): "native" | "poll" | undefined {
    return this.watches.get(repo)?.strategy;
  }

  /** Registers a repository; it is watched while at least one subscriber exists. */
  addRepo(repo: string): Promise<void> {
    this.known.add(repo);
    return this.listeners.size > 0 ? this.startRepo(repo) : Promise.resolve();
  }

  /** Subscribes to change notifications; returns the unsubscribe function. */
  subscribe(listener: Listener): () => void {
    const wrapped: Listener = (repo) => listener(repo);
    this.listeners.add(wrapped);
    if (this.listeners.size === 1) for (const repo of this.known) void this.startRepo(repo);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.listeners.delete(wrapped);
      if (this.listeners.size === 0) this.stopAll();
    };
  }

  /** Resolves when every known repo is watched and has its baseline signature. */
  async ready(): Promise<void> {
    await Promise.all([...this.starting.values()]);
  }

  close(): void {
    this.unregister?.();
    this.listeners.clear();
    this.stopAll();
  }

  private startRepo(repo: string): Promise<void> {
    const existing = this.starting.get(repo);
    if (existing) return existing;
    const strategy =
      this.options.strategy === "auto"
        ? process.platform === "linux"
          ? "poll"
          : "native"
        : this.options.strategy;
    const watch = new RepoWatch(repo, {
      ...this.options,
      strategy,
      onResourceLimit: (error) => this.logResourceLimit(error),
      emit: (path) => {
        for (const listener of [...this.listeners]) {
          try {
            listener(path);
          } catch {
            // a broken subscriber must not affect the others
          }
        }
      },
    });
    this.watches.set(repo, watch);
    const started = watch.start().catch((error) => this.options.log(`watch failed for ${repo}: ${String(error)}`));
    this.starting.set(repo, started);
    return started;
  }

  private stopAll(): void {
    for (const watch of this.watches.values()) watch.stop();
    this.watches.clear();
    this.starting.clear();
  }

  private logResourceLimit(error: NodeJS.ErrnoException): void {
    if (this.limitLogged) return;
    this.limitLogged = true;
    this.options.log(
      `file watcher limit reached (${error.code}); falling back to polling every ${this.options.pollIntervalMs} ms. ` +
        "On Linux, consider raising fs.inotify.max_user_watches.",
    );
  }
}
