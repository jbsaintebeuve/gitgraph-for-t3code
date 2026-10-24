import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GitAction } from "../shared/types.js";
import { parseAction, runAction, withRepoLock } from "./actions.js";
import { createApp } from "./app.js";
import { runGit } from "./git.js";
import { BadRequestError, loadGraphPage } from "./graph.js";
import { RepoRegistry } from "./repos.js";

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.com",
};

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

const git = async (cwd: string, ...args: string[]) => (await runGit(cwd, args)).trim();

async function tmp(prefix: string): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), prefix));
  roots.push(base);
  return realpath(base);
}

async function newRepo(): Promise<string> {
  const dir = await tmp("gitgraph-actions-");
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "commit.gpgsign", "false");
  await git(dir, "config", "tag.gpgsign", "false");
  return dir;
}

async function commit(dir: string, message: string, files: Record<string, string> = {}): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** Repo with a bare "origin" that already has main. */
async function repoWithOrigin(): Promise<{ dir: string; origin: string }> {
  const dir = await newRepo();
  const origin = await tmp("gitgraph-origin-");
  await git(origin, "init", "-q", "--bare", "-b", "main");
  await commit(dir, "init", { "a.txt": "a\n" });
  await git(dir, "remote", "add", "origin", origin);
  await git(dir, "push", "-q", "-u", "origin", "main");
  return { dir, origin };
}

const branches = async (dir: string) => (await git(dir, "branch", "--format=%(refname:short)")).split("\n");
const run = (dir: string, action: GitAction) => runAction(dir, action);

/** main: base; topic: base + t.txt ; main: base + m.txt  (diverged, no conflict) */
async function diverged() {
  const dir = await newRepo();
  const base = await commit(dir, "base", { "f.txt": "base\n" });
  await git(dir, "switch", "-q", "-c", "topic");
  const topic = await commit(dir, "topic work", { "t.txt": "t\n" });
  await git(dir, "switch", "-q", "main");
  const main = await commit(dir, "main work", { "m.txt": "m\n" });
  return { dir, base, topic, main };
}

/** main and topic both edit f.txt differently. */
async function conflicting() {
  const dir = await newRepo();
  const base = await commit(dir, "base", { "f.txt": "base\n" });
  await git(dir, "switch", "-q", "-c", "topic");
  const topic = await commit(dir, "topic edit", { "f.txt": "topic\n" });
  await git(dir, "switch", "-q", "main");
  const main = await commit(dir, "main edit", { "f.txt": "main\n" });
  return { dir, base, topic, main };
}

describe("input validation", () => {
  it("rejects malformed bodies and unknown types", () => {
    expect(() => parseAction(null)).toThrow(BadRequestError);
    expect(() => parseAction({ type: "rm -rf" })).toThrow(BadRequestError);
    expect(() => parseAction({ type: "toString" })).toThrow(BadRequestError);
    expect(() => parseAction({ type: "checkout", ref: ["a"] })).toThrow(BadRequestError);
    expect(() => parseAction({ type: "reset", hash: "abcd", mode: "weird" })).toThrow(BadRequestError);
    expect(parseAction({ type: "fetch", extra: 1 })).toEqual({ type: "fetch", prune: false });
  });

  it("rejects bad branch/tag names without running git", async () => {
    const { dir, main } = await diverged();
    for (const name of ["has space", "-rf", "a..b", "x.lock", "a~b", "@{-1}", "HEAD", "--force", ""]) {
      await expect(run(dir, { type: "createBranch", name, startPoint: "main", checkout: false })).rejects.toThrow(BadRequestError);
    }
    for (const name of ["has space", "-rf", "a..b", "v1:2"]) {
      await expect(run(dir, { type: "createTag", name, hash: main })).rejects.toThrow(BadRequestError);
    }
    await expect(run(dir, { type: "createBranch", name: "ok", startPoint: "--orphan", checkout: false })).rejects.toThrow(BadRequestError);
    expect(await branches(dir)).toEqual(["main", "topic"]);
  });

  it("rejects bad hashes, refs, remotes and stashes", async () => {
    const { dir } = await diverged();
    for (const hash of ["zzzz", "abc", "-rf", "HEAD", "deadbeefdeadbeef", "main"]) {
      await expect(run(dir, { type: "reset", hash, mode: "hard" })).rejects.toThrow(BadRequestError);
    }
    await expect(run(dir, { type: "merge", ref: "-rf", noFastForward: false, squash: false })).rejects.toThrow(BadRequestError);
    await expect(run(dir, { type: "merge", ref: "nope", noFastForward: false, squash: false })).rejects.toThrow(BadRequestError);
    await expect(run(dir, { type: "fetch", remote: "origin", prune: false })).rejects.toThrow(/unknown remote/);
    await expect(run(dir, { type: "fetch", remote: "--upload-pack=x", prune: false })).rejects.toThrow(BadRequestError);
    await expect(run(dir, { type: "stashPop", name: "stash@{0}; rm" })).rejects.toThrow(BadRequestError);
    await expect(run(dir, { type: "stashDrop", name: "stash@{9}" })).rejects.toThrow(/unknown stash/);
    await expect(run(dir, { type: "abortOperation" })).rejects.toThrow(/no operation/);
  });
});

describe("branches", () => {
  it("checkout, create, rename, delete", async () => {
    const { dir, topic, main } = await diverged();
    expect((await run(dir, { type: "checkout", ref: "topic" })).ok).toBe(true);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(topic);

    expect((await run(dir, { type: "createBranch", name: "feature/x", startPoint: main, checkout: false })).ok).toBe(true);
    expect(await git(dir, "rev-parse", "feature/x")).toBe(main);
    expect(await git(dir, "branch", "--show-current")).toBe("topic");

    expect((await run(dir, { type: "createBranch", name: "y", startPoint: "main", checkout: true })).ok).toBe(true);
    expect(await git(dir, "branch", "--show-current")).toBe("y");

    expect((await run(dir, { type: "renameBranch", oldName: "feature/x", newName: "feature/z" })).ok).toBe(true);
    expect(await branches(dir)).toContain("feature/z");

    await run(dir, { type: "checkout", ref: "main" });
    // unmerged branch: -d refuses, -D works
    await run(dir, { type: "checkout", ref: "topic" });
    await run(dir, { type: "checkout", ref: "main" });
    const refused = await run(dir, { type: "deleteBranch", name: "topic", force: false });
    expect(refused.ok).toBe(false);
    expect(refused.output).toMatch(/not fully merged/);
    expect((await run(dir, { type: "deleteBranch", name: "topic", force: true })).ok).toBe(true);
    expect(await branches(dir)).not.toContain("topic");
  });

  it("detached checkout", async () => {
    const { dir, base } = await diverged();
    const result = await run(dir, { type: "checkoutCommit", hash: base.slice(0, 8) });
    expect(result.ok).toBe(true);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(base);
    expect(await git(dir, "branch", "--show-current")).toBe("");
  });
});

describe("remote", () => {
  it("checking out a remote branch creates a tracking branch (or reuses the local one)", async () => {
    const { dir, origin } = await repoWithOrigin();
    await git(dir, "push", "-q", "origin", "main:refs/heads/feat/one");
    await git(dir, "fetch", "-q", "origin");
    expect((await run(dir, { type: "checkout", ref: "origin/feat/one" })).ok).toBe(true);
    expect(await git(dir, "branch", "--show-current")).toBe("feat/one");
    expect(await git(dir, "rev-parse", "--abbrev-ref", "feat/one@{upstream}")).toBe("origin/feat/one");
    await run(dir, { type: "checkout", ref: "main" });
    expect((await run(dir, { type: "checkout", ref: "origin/feat/one" })).ok).toBe(true);
    expect(await git(dir, "branch", "--show-current")).toBe("feat/one");
    expect(origin).toBeTruthy();
  });

  it("fetch, pull (merge and rebase), push, force-with-lease, delete remote branch, push tag", async () => {
    const { dir, origin } = await repoWithOrigin();
    // another clone pushes a commit
    const other = await tmp("gitgraph-other-");
    await git(other, "clone", "-q", origin, ".");
    await commit(other, "from other", { "o.txt": "o\n" });
    await git(other, "push", "-q", "origin", "main");

    const fetched = await run(dir, { type: "fetch", prune: true });
    expect(fetched.ok).toBe(true);
    expect((await loadGraphPage({ repo: dir })).refs.find((r) => r.name === "main")?.behind).toBe(1);

    expect((await run(dir, { type: "pull", rebase: false })).ok).toBe(true);
    expect(await readFile(join(dir, "o.txt"), "utf8")).toBe("o\n");

    // diverge, pull --rebase
    await commit(other, "other 2", { "o2.txt": "o\n" });
    await git(other, "push", "-q", "origin", "main");
    await commit(dir, "local 2", { "l.txt": "l\n" });
    expect((await run(dir, { type: "pull", rebase: true })).ok).toBe(true);
    expect(await git(dir, "log", "--format=%s", "-3")).toBe("local 2\nother 2\nfrom other");

    // push + new branch with upstream
    expect((await run(dir, { type: "push", branch: "main", remote: "origin", setUpstream: false, force: "none" })).ok).toBe(true);
    await run(dir, { type: "createBranch", name: "side", startPoint: "main", checkout: false });
    const pushed = await run(dir, { type: "push", branch: "side", remote: "origin", setUpstream: true, force: "none" });
    expect(pushed.ok).toBe(true);
    expect(await git(dir, "rev-parse", "--abbrev-ref", "side@{upstream}")).toBe("origin/side");

    // rewrite + force-with-lease; plain push is rejected
    await git(dir, "switch", "-q", "side");
    await git(dir, "commit", "-q", "--amend", "--allow-empty", "-m", "rewritten");
    const rejected = await run(dir, { type: "push", branch: "side", remote: "origin", setUpstream: false, force: "none" });
    expect(rejected.ok).toBe(false);
    expect((await run(dir, { type: "push", branch: "side", remote: "origin", setUpstream: false, force: "with-lease" })).ok).toBe(true);
    expect(await git(origin, "log", "--format=%s", "-1", "side")).toBe("rewritten");

    // tags
    const head = await git(dir, "rev-parse", "HEAD");
    expect((await run(dir, { type: "createTag", name: "v1", hash: head })).ok).toBe(true);
    expect((await run(dir, { type: "pushTag", remote: "origin", name: "v1" })).ok).toBe(true);
    expect(await git(origin, "tag", "-l")).toBe("v1");

    await git(dir, "switch", "-q", "main");
    expect((await run(dir, { type: "deleteRemoteBranch", remote: "origin", name: "side" })).ok).toBe(true);
    expect(await git(origin, "branch", "--format=%(refname:short)")).not.toContain("side");
  });
});

describe("history actions", () => {
  it("merge (ff, no-ff, squash)", async () => {
    const { dir } = await diverged();
    expect((await run(dir, { type: "merge", ref: "topic", noFastForward: false, squash: false })).ok).toBe(true);
    expect(await git(dir, "rev-list", "--parents", "-1", "HEAD")).toMatch(/^\w+ \w+ \w+$/);

    const d2 = await newRepo();
    const base = await commit(d2, "base");
    await git(d2, "switch", "-q", "-c", "t");
    await commit(d2, "t1", { "t.txt": "t" });
    await git(d2, "switch", "-q", "main");
    expect((await run(d2, { type: "merge", ref: "t", noFastForward: true, squash: false })).ok).toBe(true);
    expect(await git(d2, "rev-list", "--parents", "-1", "HEAD")).toMatch(/^\w+ \w+ \w+$/);
    await git(d2, "reset", "-q", "--hard", base);
    expect((await run(d2, { type: "merge", ref: "t", noFastForward: true, squash: true })).ok).toBe(true);
    expect(await git(d2, "rev-parse", "HEAD")).toBe(base);
    expect(await git(d2, "status", "--porcelain")).toContain("t.txt");
  });

  it("merge conflict: ok=false + conflicts, continue after resolving", async () => {
    const { dir } = await conflicting();
    const result = await run(dir, { type: "merge", ref: "topic", noFastForward: false, squash: false });
    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual(["f.txt"]);
    expect((await loadGraphPage({ repo: dir })).operation).toBe("merge");

    const early = await run(dir, { type: "continueOperation" });
    expect(early.ok).toBe(false);

    await writeFile(join(dir, "f.txt"), "resolved\n");
    await git(dir, "add", "f.txt");
    const done = await run(dir, { type: "continueOperation" });
    expect(done.ok).toBe(true);
    expect((await loadGraphPage({ repo: dir })).operation).toBeNull();
    expect(await git(dir, "rev-list", "--parents", "-1", "HEAD")).toMatch(/^\w+ \w+ \w+$/);
  });

  it("merge conflict abort", async () => {
    const { dir, main } = await conflicting();
    await run(dir, { type: "merge", ref: "topic", noFastForward: false, squash: false });
    expect((await run(dir, { type: "abortOperation" })).ok).toBe(true);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(main);
    expect(await git(dir, "status", "--porcelain")).toBe("");
  });

  it("rebase (clean, conflict + abort, conflict + continue)", async () => {
    const { dir, main } = await diverged();
    await git(dir, "switch", "-q", "topic");
    const ok = await run(dir, { type: "rebase", onto: "main" });
    expect(ok.ok).toBe(true);
    expect(await git(dir, "rev-parse", "HEAD~1")).toBe(main);

    const c = await conflicting();
    await git(c.dir, "switch", "-q", "topic");
    const bad = await run(c.dir, { type: "rebase", onto: "main" });
    expect(bad.ok).toBe(false);
    expect(bad.conflicts).toEqual(["f.txt"]);
    expect((await loadGraphPage({ repo: c.dir })).operation).toBe("rebase");
    expect((await run(c.dir, { type: "abortOperation" })).ok).toBe(true);
    expect(await git(c.dir, "rev-parse", "HEAD")).toBe(c.topic);

    await run(c.dir, { type: "rebase", onto: "main" });
    await writeFile(join(c.dir, "f.txt"), "both\n");
    await git(c.dir, "add", "f.txt");
    expect((await run(c.dir, { type: "continueOperation" })).ok).toBe(true);
    expect(await git(c.dir, "rev-parse", "HEAD~1")).toBe(c.main);
    expect(await git(c.dir, "status", "--porcelain")).toBe("");
  });

  it("cherry-pick (plain, -n, merge commit) and conflict + abort", async () => {
    const { dir, topic } = await diverged();
    expect((await run(dir, { type: "cherryPick", hash: topic, noCommit: false })).ok).toBe(true);
    expect(await git(dir, "log", "--format=%s", "-1")).toBe("topic work");

    const d = await diverged();
    expect((await run(d.dir, { type: "cherryPick", hash: d.topic, noCommit: true })).ok).toBe(true);
    expect(await git(d.dir, "rev-parse", "HEAD")).toBe(d.main);
    expect(await git(d.dir, "status", "--porcelain")).toContain("t.txt");

    // merge commit needs -m 1 (applied automatically)
    const m = await diverged();
    await git(m.dir, "merge", "-q", "--no-edit", "topic");
    const mergeHash = await git(m.dir, "rev-parse", "HEAD");
    await git(m.dir, "reset", "-q", "--hard", m.base);
    expect((await run(m.dir, { type: "cherryPick", hash: mergeHash, noCommit: false })).ok).toBe(true);

    const c = await conflicting();
    const bad = await run(c.dir, { type: "cherryPick", hash: c.topic, noCommit: false });
    expect(bad.ok).toBe(false);
    expect(bad.conflicts).toEqual(["f.txt"]);
    expect((await loadGraphPage({ repo: c.dir })).operation).toBe("cherry-pick");
    expect((await run(c.dir, { type: "abortOperation" })).ok).toBe(true);
    expect(await git(c.dir, "rev-parse", "HEAD")).toBe(c.main);
    expect((await loadGraphPage({ repo: c.dir })).operation).toBeNull();
  });

  it("revert (normal, merge commit, conflict + abort)", async () => {
    const { dir, topic } = await diverged();
    await run(dir, { type: "cherryPick", hash: topic, noCommit: false });
    expect((await run(dir, { type: "revert", hash: await git(dir, "rev-parse", "HEAD") })).ok).toBe(true);
    expect(await git(dir, "log", "--format=%s", "-1")).toMatch(/^Revert "topic work"/);

    const m = await diverged();
    await git(m.dir, "merge", "-q", "--no-ff", "--no-edit", "topic");
    expect((await run(m.dir, { type: "revert", hash: await git(m.dir, "rev-parse", "HEAD") })).ok).toBe(true);

    const c = await conflicting();
    const bad = await run(c.dir, { type: "revert", hash: c.main });
    // reverting main's edit on top of itself is clean; make a conflict by editing again
    expect(bad.ok).toBe(true);
    await commit(c.dir, "edit again", { "f.txt": "again\n" });
    const target = await git(c.dir, "rev-parse", "HEAD~1");
    const conflict = await run(c.dir, { type: "revert", hash: target });
    expect(conflict.ok).toBe(false);
    expect(conflict.conflicts).toEqual(["f.txt"]);
    expect((await run(c.dir, { type: "abortOperation" })).ok).toBe(true);
  });

  it("reset soft / mixed / hard", async () => {
    const dir = await newRepo();
    const first = await commit(dir, "one", { "a.txt": "1\n" });
    await commit(dir, "two", { "a.txt": "2\n" });
    expect((await run(dir, { type: "reset", hash: first, mode: "soft" })).ok).toBe(true);
    expect(await git(dir, "status", "--porcelain")).toBe("M  a.txt");
    expect((await run(dir, { type: "reset", hash: first, mode: "mixed" })).ok).toBe(true);
    expect(await git(dir, "status", "--porcelain")).toBe("M a.txt");
    expect((await run(dir, { type: "reset", hash: first, mode: "hard" })).ok).toBe(true);
    expect(await git(dir, "status", "--porcelain")).toBe("");
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("1\n");
  });

  it("hard reset of HEAD discards local changes", async () => {
    const dir = await newRepo();
    await commit(dir, "one", { "a.txt": "1\n" });
    await writeFile(join(dir, "a.txt"), "dirty\n");
    expect((await run(dir, { type: "reset", hash: await git(dir, "rev-parse", "HEAD"), mode: "hard" })).ok).toBe(true);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("1\n");
  });
});

describe("tags and stashes", () => {
  it("lightweight and annotated tags, delete", async () => {
    const dir = await newRepo();
    const head = await commit(dir, "one");
    expect((await run(dir, { type: "createTag", name: "light", hash: head })).ok).toBe(true);
    expect(await git(dir, "cat-file", "-t", "light")).toBe("commit");
    expect((await run(dir, { type: "createTag", name: "ann", hash: head, message: "release notes" })).ok).toBe(true);
    expect(await git(dir, "cat-file", "-t", "ann")).toBe("tag");
    expect((await run(dir, { type: "deleteTag", name: "light" })).ok).toBe(true);
    expect(await git(dir, "tag", "-l")).toBe("ann");
    expect((await run(dir, { type: "createTag", name: "ann", hash: head })).ok).toBe(false);
  });

  it("stash push (with untracked) / apply / pop / drop / branch", async () => {
    const dir = await newRepo();
    await commit(dir, "one", { "a.txt": "1\n" });
    await writeFile(join(dir, "a.txt"), "changed\n");
    await writeFile(join(dir, "new.txt"), "untracked\n");

    expect((await run(dir, { type: "stashPush", message: "wip", includeUntracked: true })).ok).toBe(true);
    expect(await git(dir, "status", "--porcelain")).toBe("");
    expect(await git(dir, "stash", "list")).toContain("wip");

    expect((await run(dir, { type: "stashApply", name: "stash@{0}" })).ok).toBe(true);
    expect(await readFile(join(dir, "new.txt"), "utf8")).toBe("untracked\n");
    await run(dir, { type: "reset", hash: await git(dir, "rev-parse", "HEAD"), mode: "hard" });
    await rm(join(dir, "new.txt"));

    expect((await run(dir, { type: "stashPop", name: "stash@{0}" })).ok).toBe(true);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("changed\n");
    expect(await git(dir, "stash", "list")).toBe("");

    await run(dir, { type: "stashPush", includeUntracked: false });
    expect((await run(dir, { type: "stashBranch", name: "stash@{0}", branch: "from-stash" })).ok).toBe(true);
    expect(await git(dir, "branch", "--show-current")).toBe("from-stash");

    await run(dir, { type: "stashPush", includeUntracked: false });
    expect((await run(dir, { type: "stashDrop", name: "stash@{0}" })).ok).toBe(true);
    expect(await git(dir, "stash", "list")).toBe("");
  });

  it("stash with nothing to save is not an error", async () => {
    const dir = await newRepo();
    await commit(dir, "one");
    const result = await run(dir, { type: "stashPush", includeUntracked: false });
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/No local changes/);
  });
});

describe("serialization and HTTP", () => {
  it("runs jobs for one repo strictly one after another", async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = withRepoLock("/x", async () => {
      log.push("a:start");
      await gate;
      log.push("a:end");
    });
    const second = withRepoLock("/x", async () => void log.push("b"));
    const other = withRepoLock("/y", async () => void log.push("other"));
    await other;
    await new Promise((r) => setTimeout(r, 30));
    expect(log).toEqual(["a:start", "other"]);
    release();
    await Promise.all([first, second]);
    expect(log).toEqual(["a:start", "other", "a:end", "b"]);
  });

  it("runAction waits for a held lock, and a failing job does not block the queue", async () => {
    const dir = await newRepo();
    await commit(dir, "one");
    let release!: () => void;
    const held = withRepoLock(dir, () => new Promise<void>((r) => (release = r)));
    let finished = false;
    const pending = run(dir, { type: "createBranch", name: "late", startPoint: "main", checkout: false }).then((r) => {
      finished = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(finished).toBe(false);
    release();
    await held;
    expect((await pending).ok).toBe(true);
    await expect(withRepoLock(dir, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect((await run(dir, { type: "deleteBranch", name: "late", force: false })).ok).toBe(true);
  });

  it("POST /api/action requires token, validates, and runs", async () => {
    const dir = await newRepo();
    await commit(dir, "one");
    const registry = new RepoRegistry();
    await registry.register(dir, { activate: true });
    const app = createApp({ port: 4792, token: "tok", repos: registry });
    const post = (query: string, body: unknown, headers: Record<string, string> = { "x-gitgraph-token": "tok" }) =>
      app.request(`/api/action?repo=${encodeURIComponent(query)}`, {
        method: "POST",
        headers: { host: "127.0.0.1:4792", "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    expect((await post(dir, { type: "fetch", prune: false }, {})).status).toBe(401);
    expect((await post(dir, { type: "nope" })).status).toBe(400);
    expect((await post(dir, { type: "createBranch", name: "-rf", startPoint: "main", checkout: false })).status).toBe(400);
    expect((await post("/not/registered", { type: "stashPush", includeUntracked: false })).status).toBe(404);
    const res = await post(dir, { type: "createTag", name: "t1", hash: await git(dir, "rev-parse", "HEAD") });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    const evil = await app.request(`/api/action?repo=${encodeURIComponent(dir)}`, {
      method: "POST",
      headers: { host: "127.0.0.1:4792", origin: "http://evil.example", "x-gitgraph-token": "tok" },
      body: "{}",
    });
    expect(evil.status).toBe(403);
  });
});
