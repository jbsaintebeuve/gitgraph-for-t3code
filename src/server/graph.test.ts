import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UNCOMMITTED_HASH } from "../shared/types.js";
import { createApp } from "./app.js";
import { runGit } from "./git.js";
import {
  BadRequestError,
  compareCommits,
  loadCommitDetails,
  loadFileDiff,
  loadGraphPage,
  loadUncommittedChanges,
  loadUncommittedFileDiff,
  searchCommits,
} from "./graph.js";
import { RepoRegistry } from "./repos.js";

const roots: string[] = [];
let clock = 1_700_000_000;

/** Isolated git environment: no user/system config, deterministic identity and dates. */
function gitEnv(): Record<string, string> {
  const date = `${(clock += 60)} +0000`;
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Ada",
    GIT_AUTHOR_EMAIL: "ada@example.com",
    GIT_COMMITTER_NAME: "Ada",
    GIT_COMMITTER_EMAIL: "ada@example.com",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
}

const git = (cwd: string, ...args: string[]) => runGit(cwd, args, { env: gitEnv() });

async function newRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "gitgraph-test-"));
  roots.push(base);
  const dir = await realpath(base);
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "commit.gpgsign", "false");
  await git(dir, "config", "tag.gpgsign", "false");
  return dir;
}

async function commit(dir: string, message: string, files: Record<string, string | Buffer> = {}): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "--allow-empty", "-m", message);
  return (await git(dir, "rev-parse", "HEAD")).trim();
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadGraphPage", () => {
  it("handles an empty repository", async () => {
    const repo = await newRepo();
    const page = await loadGraphPage({ repo });
    expect(page.commits).toEqual([]);
    expect(page.refs).toEqual([]);
    expect(page.head).toEqual({ detached: false, branch: "main" });
    expect(page.hasMore).toBe(false);
    expect(page.workingTree).toBeNull();
    expect(page.operation).toBeNull();
  });

  it("lists a linear history newest first with head info", async () => {
    const repo = await newRepo();
    const a = await commit(repo, "first", { "a.txt": "1\n" });
    const b = await commit(repo, "second", { "a.txt": "2\n" });
    const page = await loadGraphPage({ repo });
    expect(page.commits.map((c) => c.hash)).toEqual([b, a]);
    expect(page.commits[0]).toMatchObject({ parents: [a], author: "Ada", authorEmail: "ada@example.com", subject: "second" });
    expect(page.commits[1]?.parents).toEqual([]);
    expect(page.head).toEqual({ branch: "main", hash: b, detached: false });
    expect(page.refs).toEqual([{ name: "main", fullName: "refs/heads/main", kind: "branch", target: b, isHead: true }]);
  });

  it("represents a branch and a merge", async () => {
    const repo = await newRepo();
    const base = await commit(repo, "base", { "a.txt": "a\n" });
    await git(repo, "checkout", "-q", "-b", "feature");
    const f = await commit(repo, "feature work", { "f.txt": "f\n" });
    await git(repo, "checkout", "-q", "main");
    const m = await commit(repo, "main work", { "m.txt": "m\n" });
    await git(repo, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    const merge = (await git(repo, "rev-parse", "HEAD")).trim();
    const page = await loadGraphPage({ repo });
    const mergeCommit = page.commits.find((c) => c.hash === merge);
    expect(mergeCommit?.parents).toEqual([m, f]);
    expect(page.commits).toHaveLength(4);
    expect(page.refs.map((r) => r.name).sort()).toEqual(["feature", "main"]);
    // Branch filter keeps only the selected branch history.
    const only = await loadGraphPage({ repo, branches: ["feature"] });
    expect(only.commits.map((c) => c.hash)).toEqual([f, base]);
    await expect(loadGraphPage({ repo, branches: ["--oops"] })).rejects.toBeInstanceOf(BadRequestError);
    // First-parent view skips the merged-in branch.
    const fp = await loadGraphPage({ repo, branches: ["main"], firstParent: true });
    expect(fp.commits.map((c) => c.hash)).toEqual([merge, m, base]);
  });

  it("supports octopus merges", async () => {
    const repo = await newRepo();
    await commit(repo, "base", { "a.txt": "a\n" });
    const mainTip = await commit(repo, "main tip", { "m.txt": "m\n" });
    const tips: string[] = [];
    for (const name of ["x", "y", "z"]) {
      await git(repo, "checkout", "-q", "-b", name, mainTip);
      tips.push(await commit(repo, `work ${name}`, { [`${name}.txt`]: `${name}\n` }));
    }
    await git(repo, "checkout", "-q", "main");
    await commit(repo, "main after", { "after.txt": "x\n" });
    await git(repo, "merge", "-q", "-m", "octopus", "x", "y", "z");
    const page = await loadGraphPage({ repo });
    expect(page.commits[0]?.parents).toHaveLength(4);
    expect(page.commits[0]?.parents.slice(1)).toEqual(tips);
    expect(page.commits[0]?.parents[0]).not.toBe(mainTip);
  });

  it("peels annotated tags and keeps lightweight ones", async () => {
    const repo = await newRepo();
    const a = await commit(repo, "first", { "a.txt": "1\n" });
    const b = await commit(repo, "second", { "a.txt": "2\n" });
    await git(repo, "tag", "-a", "v1", "-m", "release", a);
    await git(repo, "tag", "light", b);
    const page = await loadGraphPage({ repo });
    const tags = Object.fromEntries(page.refs.filter((r) => r.kind === "tag").map((r) => [r.name, r.target]));
    expect(tags).toEqual({ v1: a, light: b });
  });

  it("reports upstream, ahead/behind and remote refs without the symbolic HEAD", async () => {
    const origin = await newRepo();
    await commit(origin, "one", { "a.txt": "1\n" });
    const clone = await mkdtemp(join(tmpdir(), "gitgraph-clone-"));
    roots.push(clone);
    const dir = join(clone, "c");
    await git(clone, "clone", "-q", origin, dir);
    await git(dir, "config", "commit.gpgsign", "false");
    await commit(dir, "local", { "b.txt": "b\n" });
    await commit(origin, "remote two", { "c.txt": "c\n" });
    await git(dir, "fetch", "-q");
    const page = await loadGraphPage({ repo: dir });
    const main = page.refs.find((r) => r.fullName === "refs/heads/main");
    expect(main).toMatchObject({ upstream: "origin/main", ahead: 1, behind: 1 });
    expect(page.refs.some((r) => r.fullName === "refs/remotes/origin/HEAD")).toBe(false);
    expect(page.refs.some((r) => r.name === "origin/main" && r.kind === "remote")).toBe(true);
    const noRemotes = await loadGraphPage({ repo: dir, includeRemotes: false });
    expect(noRemotes.refs.some((r) => r.kind === "remote")).toBe(false);
    expect(noRemotes.commits).toHaveLength(2);
    // An explicit branch selection is exact, even with remotes switched on: origin's extra commit stays hidden.
    const filtered = await loadGraphPage({ repo: dir, branches: ["main"], includeRemotes: true });
    expect(filtered.commits.map((c) => c.subject)).toEqual(["local", "one"]);
    expect(filtered.refs.some((r) => r.name === "origin/main")).toBe(true);
    // ...and a remote branch can be selected by name.
    const remoteOnly = await loadGraphPage({ repo: dir, branches: ["origin/main"], includeRemotes: true });
    expect(remoteOnly.commits.map((c) => c.subject)).toEqual(["remote two", "one"]);
    // Upstream deleted on the remote side.
    await git(dir, "branch", "-q", "--set-upstream-to=origin/main");
    await git(dir, "update-ref", "-d", "refs/remotes/origin/main");
    const gone = await loadGraphPage({ repo: dir });
    expect(gone.refs.find((r) => r.name === "main")).toMatchObject({ upstream: "origin/main", upstreamGone: true });
  });

  it("includes stashes as children of their base and hides internal commits", async () => {
    const repo = await newRepo();
    const base = await commit(repo, "base", { "a.txt": "1\n" });
    await writeFile(join(repo, "a.txt"), "2\n");
    await writeFile(join(repo, "new.txt"), "n\n");
    await git(repo, "add", "new.txt");
    await git(repo, "stash", "push", "-q", "-m", "wip");
    const page = await loadGraphPage({ repo });
    expect(page.stashes).toHaveLength(1);
    expect(page.stashes[0]).toMatchObject({ name: "stash@{0}", base });
    expect(page.stashes[0]?.message).toContain("wip");
    const stashCommit = page.commits.find((c) => c.hash === page.stashes[0]?.hash);
    expect(stashCommit?.parents).toEqual([base]);
    expect(page.commits).toHaveLength(2);
    expect(page.refs.find((r) => r.kind === "stash")?.target).toBe(page.stashes[0]?.hash);
    const without = await loadGraphPage({ repo, includeStashes: false });
    expect(without.stashes).toEqual([]);
    expect(without.commits).toHaveLength(1);
  });

  it("shows a detached HEAD that no branch contains", async () => {
    const repo = await newRepo();
    await commit(repo, "one", { "a.txt": "1\n" });
    await git(repo, "checkout", "-q", "--detach");
    const loose = await commit(repo, "loose", { "a.txt": "2\n" });
    const page = await loadGraphPage({ repo });
    expect(page.head).toEqual({ hash: loose, detached: true });
    expect(page.commits[0]?.hash).toBe(loose);
    expect(page.refs.some((r) => r.isHead)).toBe(false);
  });

  it("never exposes refs/t3/* checkpoint refs", async () => {
    const repo = await newRepo();
    await commit(repo, "one", { "a.txt": "1\n" });
    await git(repo, "checkout", "-q", "--detach");
    const hidden = await commit(repo, "checkpoint only", { "a.txt": "2\n" });
    await git(repo, "update-ref", "refs/t3/orchestration-v2/checkpoints/x", hidden);
    await git(repo, "checkout", "-q", "main");
    const page = await loadGraphPage({ repo });
    expect(page.commits.map((c) => c.hash)).not.toContain(hidden);
    expect(page.refs.some((r) => r.fullName.startsWith("refs/t3/"))).toBe(false);
    expect(await searchCommits(repo, "checkpoint only")).toEqual([]);
  });

  it("paginates with hasMore", async () => {
    const repo = await newRepo();
    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) hashes.push(await commit(repo, `c${i}`));
    const first = await loadGraphPage({ repo, limit: 2 });
    expect(first.commits.map((c) => c.subject)).toEqual(["c4", "c3"]);
    expect(first.hasMore).toBe(true);
    const last = await loadGraphPage({ repo, skip: 4, limit: 2 });
    expect(last.commits.map((c) => c.hash)).toEqual([hashes[0]]);
    expect(last.hasMore).toBe(false);
    const exact = await loadGraphPage({ repo, skip: 3, limit: 2 });
    expect(exact.hasMore).toBe(false);
  });

  it("reads linked worktrees with their own HEAD", async () => {
    const repo = await newRepo();
    await commit(repo, "one", { "a.txt": "1\n" });
    const wt = join(await realpath(await mkdtemp(join(tmpdir(), "gitgraph-wt-"))), "wt");
    roots.push(join(wt, ".."));
    await git(repo, "worktree", "add", "-q", "-b", "wt-branch", wt);
    const inWt = await commit(wt, "in worktree", { "w.txt": "w\n" });
    await writeFile(join(wt, "w.txt"), "dirty\n");
    const page = await loadGraphPage({ repo: wt });
    expect(page.head).toEqual({ branch: "wt-branch", hash: inWt, detached: false });
    expect(page.refs.find((r) => r.name === "wt-branch")?.isHead).toBe(true);
    expect(page.refs.find((r) => r.name === "main")?.isHead).toBeUndefined();
    expect(page.workingTree).toEqual({ staged: 0, unstaged: 1, untracked: 0, conflicted: 0 });
    expect((await loadGraphPage({ repo })).head.branch).toBe("main");
  });

  it("detects a merge in progress with conflicts, per worktree", async () => {
    const repo = await newRepo();
    await commit(repo, "base", { "a.txt": "base\n" });
    await git(repo, "checkout", "-q", "-b", "other");
    await commit(repo, "other", { "a.txt": "other\n" });
    await git(repo, "checkout", "-q", "main");
    await commit(repo, "mine", { "a.txt": "mine\n" });
    await expect(git(repo, "merge", "other")).rejects.toThrow();
    await writeFile(join(repo, "untracked.txt"), "u\n");
    const page = await loadGraphPage({ repo });
    expect(page.operation).toBe("merge");
    expect(page.workingTree).toMatchObject({ conflicted: 1, untracked: 1 });
    await git(repo, "merge", "--abort");
    expect((await loadGraphPage({ repo })).operation).toBeNull();
  });

  it("detects cherry-pick and rebase in progress", async () => {
    const repo = await newRepo();
    await commit(repo, "base", { "a.txt": "base\n" });
    await git(repo, "checkout", "-q", "-b", "other");
    const other = await commit(repo, "other", { "a.txt": "other\n" });
    await git(repo, "checkout", "-q", "main");
    await commit(repo, "mine", { "a.txt": "mine\n" });
    await expect(git(repo, "cherry-pick", other)).rejects.toThrow();
    expect((await loadGraphPage({ repo })).operation).toBe("cherry-pick");
    await git(repo, "cherry-pick", "--abort");
    await git(repo, "checkout", "-q", "other");
    await expect(git(repo, "rebase", "main")).rejects.toThrow();
    expect((await loadGraphPage({ repo })).operation).toBe("rebase");
  });

  it("counts staged, unstaged and untracked files", async () => {
    const repo = await newRepo();
    await commit(repo, "one", { "a.txt": "1\n", "b.txt": "1\n" });
    await writeFile(join(repo, "a.txt"), "2\n");
    await writeFile(join(repo, "b.txt"), "2\n");
    await git(repo, "add", "b.txt");
    await writeFile(join(repo, "c.txt"), "c\n");
    expect((await loadGraphPage({ repo })).workingTree).toEqual({ staged: 1, unstaged: 1, untracked: 1, conflicted: 0 });
  });
});

describe("commit details and diffs", () => {
  it("describes a root commit", async () => {
    const repo = await newRepo();
    const root = await commit(repo, "initial\n\nLong body\nwith lines", { "a.txt": "1\n2\n" });
    const details = await loadCommitDetails(repo, root.slice(0, 8));
    expect(details).toMatchObject({ hash: root, subject: "initial", body: "Long body\nwith lines", committerEmail: "ada@example.com" });
    expect(details.files).toEqual([{ path: "a.txt", status: "A", additions: 2, deletions: 0, binary: false }]);
    const diff = await loadFileDiff(repo, root, "a.txt");
    expect(diff.patch).toContain("+++ b/a.txt");
    expect(diff.truncated).toBe(false);
  });

  it("diffs a merge commit against its first parent", async () => {
    const repo = await newRepo();
    await commit(repo, "base", { "a.txt": "a\n" });
    await git(repo, "checkout", "-q", "-b", "feature");
    await commit(repo, "feature", { "f.txt": "f\n" });
    await git(repo, "checkout", "-q", "main");
    await commit(repo, "main", { "m.txt": "m\n" });
    await git(repo, "merge", "-q", "--no-ff", "-m", "merge", "feature");
    const merge = (await git(repo, "rev-parse", "HEAD")).trim();
    const details = await loadCommitDetails(repo, merge);
    expect(details.files.map((f) => f.path)).toEqual(["f.txt"]);
    expect(details.parents).toHaveLength(2);
  });

  it("detects renames and binary files", async () => {
    const repo = await newRepo();
    const content = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
    await commit(repo, "add", { "old name.txt": content, "bin.dat": Buffer.from([0, 1, 2, 3, 0, 255]) });
    await git(repo, "mv", "old name.txt", "new.txt");
    await writeFile(join(repo, "new.txt"), content + "extra\n");
    const rename = await commit(repo, "rename", { "bin.dat": Buffer.from([0, 9, 9, 9, 0, 255]) });
    const details = await loadCommitDetails(repo, rename);
    expect(details.files).toEqual([
      { path: "bin.dat", status: "M", additions: 0, deletions: 0, binary: true },
      { path: "new.txt", oldPath: "old name.txt", status: "R", additions: 1, deletions: 0, binary: false },
    ]);
    const diff = await loadFileDiff(repo, rename, "new.txt", { oldPath: "old name.txt" });
    expect(diff.patch).toContain("rename from old name.txt");
    expect(diff.patch).toContain("+extra");
  });

  it("compares two commits and diffs with compareTo", async () => {
    const repo = await newRepo();
    const a = await commit(repo, "a", { "a.txt": "1\n" });
    await commit(repo, "b", { "a.txt": "2\n", "b.txt": "b\n" });
    const c = await commit(repo, "c", { "a.txt": "3\n" });
    const files = await compareCommits(repo, a, c);
    expect(files.map((f) => `${f.status}:${f.path}`)).toEqual(["M:a.txt", "A:b.txt"]);
    const diff = await loadFileDiff(repo, c, "a.txt", { compareTo: a });
    expect(diff.patch).toContain("-1");
    expect(diff.patch).toContain("+3");
  });

  it("truncates huge patches", async () => {
    const repo = await newRepo();
    const big = Array.from({ length: 200_000 }, (_, i) => `line number ${i}`).join("\n") + "\n";
    const hash = await commit(repo, "big", { "big.txt": big });
    const diff = await loadFileDiff(repo, hash, "big.txt");
    expect(diff.truncated).toBe(true);
    expect(diff.patch.length).toBeLessThanOrEqual(1024 * 1024);
    expect(diff.patch.endsWith("\n")).toBe(true);
  });

  it("validates hashes and paths", async () => {
    const repo = await newRepo();
    const hash = await commit(repo, "a", { "a.txt": "1\n" });
    await expect(loadCommitDetails(repo, "--output=/tmp/x")).rejects.toBeInstanceOf(BadRequestError);
    await expect(loadCommitDetails(repo, "deadbeef")).rejects.toBeInstanceOf(BadRequestError);
    await expect(loadFileDiff(repo, hash, "--stat")).rejects.toBeInstanceOf(BadRequestError);
    await expect(loadFileDiff(repo, hash, "../x")).rejects.toBeInstanceOf(BadRequestError);
    await expect(loadFileDiff(repo, hash, "a.txt", { compareTo: "-x" })).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("uncommitted changes", () => {
  it("lists tracked and untracked changes with patches", async () => {
    const repo = await newRepo();
    await commit(repo, "one", { "a.txt": "1\n", "gone.txt": "x\n" });
    await writeFile(join(repo, "a.txt"), "1\n2\n");
    await rm(join(repo, "gone.txt"));
    await writeFile(join(repo, "new.txt"), "n1\nn2\nn3");
    const files = await loadUncommittedChanges(repo);
    expect(files).toEqual([
      { path: "a.txt", status: "M", additions: 1, deletions: 0, binary: false },
      { path: "gone.txt", status: "D", additions: 0, deletions: 1, binary: false },
      { path: "new.txt", status: "A", additions: 3, deletions: 0, binary: false },
    ]);
    expect((await loadUncommittedFileDiff(repo, "a.txt")).patch).toContain("+2");
    const untracked = await loadUncommittedFileDiff(repo, "new.txt");
    expect(untracked.patch).toContain("new file mode");
    expect(untracked.patch).toContain("+n3");
    // Only files git reports as untracked may be read via --no-index.
    expect((await loadUncommittedFileDiff(repo, "nonexistent.txt")).patch).toBe("");
  });

  it("works before the first commit", async () => {
    const repo = await newRepo();
    await writeFile(join(repo, "s.txt"), "staged\n");
    await git(repo, "add", "s.txt");
    await writeFile(join(repo, "u.txt"), "untracked\n");
    const files = await loadUncommittedChanges(repo);
    expect(files.map((f) => `${f.status}:${f.path}`)).toEqual(["A:s.txt", "A:u.txt"]);
    expect((await loadUncommittedFileDiff(repo, "s.txt")).patch).toContain("+staged");
  });
});

describe("searchCommits", () => {
  it("treats regex characters literally and matches author and hash prefix", async () => {
    const repo = await newRepo();
    const a = await commit(repo, "fix (bug) [#12] a.b*");
    const b = await commit(repo, "plain commit", {});
    expect(await searchCommits(repo, "(bug) [#12]")).toEqual([a]);
    expect(await searchCommits(repo, "a.b*")).toEqual([a]);
    expect(await searchCommits(repo, "b*")).toEqual([a]);
    expect(await searchCommits(repo, ".*")).toEqual([]);
    expect(await searchCommits(repo, "FIX")).toEqual([a]);
    expect(new Set(await searchCommits(repo, "ada"))).toEqual(new Set([a, b]));
    expect(await searchCommits(repo, b.slice(0, 10))).toEqual([b]);
    expect(await searchCommits(repo, "no such thing")).toEqual([]);
    expect(await searchCommits(repo, "-oops")).toEqual([]);
    expect(await searchCommits(repo, "   ")).toEqual([]);
  });

  it("returns nothing in an empty repository", async () => {
    expect(await searchCommits(await newRepo(), "abcd")).toEqual([]);
  });
});

describe("HTTP routes", () => {
  const port = 4567;
  const token = "test-token";
  let repo: string;
  let app: ReturnType<typeof createApp>;
  let hash: string;

  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(path, { headers: { host: `127.0.0.1:${port}`, "x-gitgraph-token": token, ...headers } });

  beforeAll(async () => {
    repo = await newRepo();
    hash = await commit(repo, "route test", { "a.txt": "1\n" });
    await writeFile(join(repo, "a.txt"), "1\n2\n");
    const repos = new RepoRegistry();
    await repos.register(repo, { activate: true });
    app = createApp({ port, token, repos });
  });

  const q = (params: Record<string, string>) => new URLSearchParams({ repo, ...params }).toString();

  it("requires the token", async () => {
    const res = await app.request(`/api/graph?${q({})}`, { headers: { host: `127.0.0.1:${port}` } });
    expect(res.status).toBe(401);
  });

  it("serves the graph", async () => {
    const res = await get(`/api/graph?${q({ limit: "10", order: "topo", remotes: "1", stashes: "1", firstParent: "0" })}`);
    expect(res.status).toBe(200);
    const page = await res.json();
    expect(page.commits[0].hash).toBe(hash);
    expect(page.workingTree).toMatchObject({ unstaged: 1 });
  });

  it("serves commit, diff, uncommitted, compare and search", async () => {
    expect(((await (await get(`/api/commit?${q({ hash })}`)).json()) as { files: unknown[] }).files).toHaveLength(1);
    const diff = (await (await get(`/api/diff?${q({ hash, path: "a.txt" })}`)).json()) as { patch: string };
    expect(diff.patch).toContain("+1");
    const wt = (await (await get(`/api/diff?${q({ hash: UNCOMMITTED_HASH, path: "a.txt" })}`)).json()) as { patch: string };
    expect(wt.patch).toContain("+2");
    expect(await (await get(`/api/uncommitted?${q({})}`)).json()).toHaveLength(1);
    expect(await (await get(`/api/compare?${q({ from: hash, to: hash })}`)).json()).toEqual([]);
    expect(await (await get(`/api/search?${q({ q: "route" })}`)).json()).toEqual([hash]);
  });

  it("maps errors to status codes", async () => {
    expect((await get(`/api/graph?repo=${encodeURIComponent("/not/registered")}`)).status).toBe(404);
    expect((await get(`/api/graph?${q({ skip: "-1" })}`)).status).toBe(400);
    expect((await get(`/api/graph?${q({ order: "bogus" })}`)).status).toBe(400);
    expect((await get(`/api/graph?${q({ skip: "99999999999999999999" })}`)).status).toBe(400);
    expect((await get(`/api/graph?${q({ branches: "nope" })}`)).status).toBe(400);
    expect((await get(`/api/commit?${q({})}`)).status).toBe(400);
    expect((await get(`/api/commit?${q({ hash: "zzzz" })}`)).status).toBe(400);
    expect((await get(`/api/diff?${q({ hash, path: "--stat" })}`)).status).toBe(400);
    const body = (await (await get(`/api/commit?${q({ hash: "zzzz" })}`)).json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("answers unknown API paths with a JSON 404 instead of the SPA page", async () => {
    const res = await get("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect((await app.request("/api/nope", { headers: { host: `127.0.0.1:${port}` } })).status).toBe(401);
  });

  it("does not leak files outside the web root or crash on malformed paths", async () => {
    for (const path of ["/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/package.json", "/assets/%2e%2e/%2e%2e/%2e%2e/package.json", "/%00", "/%E0%A4%A"]) {
      const res = await get(path);
      expect([200, 400, 500], path).toContain(res.status);
      expect(await res.text(), path).not.toContain('"gitgraph-for-t3code"');
    }
  });

  it("keeps the host guard", async () => {
    expect((await get(`/api/graph?${q({})}`, { host: "evil.example" })).status).toBe(403);
  });
});
