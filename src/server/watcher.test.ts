import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { runGit } from "./git.js";
import { RepoWatcher, type RepoWatcherOptions } from "./watcher.js";

const roots: string[] = [];
const env = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.com",
};
const git = (cwd: string, ...args: string[]) => runGit(cwd, args, { env });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newRepo(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gitgraph-watch-")));
  roots.push(root);
  await git(root, "init", "-q", "-b", "main");
  await writeFile(join(root, "a.txt"), "1\n");
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "init");
  return root;
}

async function commitFile(repo: string, name: string, content = "x\n") {
  await writeFile(join(repo, name), content);
  await git(repo, "add", name);
  await git(repo, "commit", "-q", "-m", `add ${name}`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(25);
  }
}

const active: RepoWatcher[] = [];

/** Starts a watcher on `repos`, waits for the baseline, and records emitted repo paths. */
async function watchRepos(repos: string[], options: RepoWatcherOptions = {}) {
  const watcher = new RepoWatcher({ log: () => undefined, ...options });
  active.push(watcher);
  const events: string[] = [];
  const unsubscribe = watcher.subscribe((repo) => events.push(repo));
  await Promise.all(repos.map((repo) => watcher.addRepo(repo)));
  await watcher.ready();
  // Let any startup noise settle, then forget it.
  await sleep(600);
  events.length = 0;
  return { watcher, events, unsubscribe };
}

afterEach(() => {
  while (active.length) active.pop()?.close();
});
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe.each([
  ["auto", {}],
  ["poll", { strategy: "poll" as const, pollIntervalMs: 400 }],
])("RepoWatcher (%s)", (_name, options) => {
  it("emits after a commit", async () => {
    const repo = await newRepo();
    const { events } = await watchRepos([repo], options);
    await commitFile(repo, "b.txt");
    await waitFor(() => events.length > 0, 3000);
    expect(events[0]).toBe(repo);
  });

  it("emits after a checkout", async () => {
    const repo = await newRepo();
    await git(repo, "branch", "other");
    const { events } = await watchRepos([repo], options);
    await git(repo, "checkout", "-q", "other");
    await waitFor(() => events.length > 0, 3000);
  });

  it("emits when an untracked file is written", async () => {
    const repo = await newRepo();
    const { events } = await watchRepos([repo], options);
    await writeFile(join(repo, "new.txt"), "hello\n");
    await waitFor(() => events.length > 0, 4000);
  });

  it("emits when a file is added inside an already-untracked directory", async () => {
    const repo = await newRepo();
    await mkdir(join(repo, "newdir", "sub"), { recursive: true });
    await writeFile(join(repo, "newdir", "sub", "one.txt"), "1\n");
    const { events } = await watchRepos([repo], options);
    await writeFile(join(repo, "newdir", "sub", "two.txt"), "2\n");
    await waitFor(() => events.length > 0, 4000);
  });

  it("emits when a file inside an untracked directory is edited", async () => {
    const repo = await newRepo();
    await mkdir(join(repo, "newdir"), { recursive: true });
    await writeFile(join(repo, "newdir", "one.txt"), "1\n");
    const { events } = await watchRepos([repo], options);
    await writeFile(join(repo, "newdir", "one.txt"), "changed, longer\n");
    await waitFor(() => events.length > 0, 4000);
  });

  it("emits when an already-modified file is edited again", async () => {
    const repo = await newRepo();
    await writeFile(join(repo, "a.txt"), "modified\n");
    const { events } = await watchRepos([repo], options);
    await writeFile(join(repo, "a.txt"), "modified again, longer\n");
    await waitFor(() => events.length > 0, 4000);
  });

  it("coalesces a burst of 20 commits", async () => {
    const repo = await newRepo();
    const { events } = await watchRepos([repo], options);
    for (let i = 0; i < 20; i++) await commitFile(repo, `f${i}.txt`);
    await waitFor(() => events.length > 0, 3000);
    await sleep(1500);
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThanOrEqual(6);
  });

  it("follows commits made in a linked worktree", async () => {
    const repo = await newRepo();
    const wt = join(await realpath(await mkdtemp(join(tmpdir(), "gitgraph-wt-"))), "wt");
    roots.push(join(wt, ".."));
    await git(repo, "worktree", "add", "-q", "-b", "feature", wt);
    const { events } = await watchRepos([wt], options);
    await commitFile(wt, "w.txt");
    await waitFor(() => events.length > 0, 3000);
    expect(events.every((e) => e === wt)).toBe(true);
  });
});

describe("RepoWatcher specifics", () => {
  it("ignores refs/t3/ updates and lock files", async () => {
    const repo = await newRepo();
    const { events } = await watchRepos([repo]);
    const head = (await git(repo, "rev-parse", "HEAD")).trim();
    for (let i = 0; i < 5; i++) await git(repo, "update-ref", `refs/t3/checkpoints/c${i}`, head);
    await mkdir(join(repo, ".git", "refs", "t3", "deep"), { recursive: true });
    await writeFile(join(repo, ".git", "refs", "t3", "deep", "x.lock"), "");
    await sleep(1500);
    expect(events).toEqual([]);
  });

  it("notices directories created later (stash, rebase state)", async () => {
    const repo = await newRepo();
    await writeFile(join(repo, "a.txt"), "dirty\n");
    const { events } = await watchRepos([repo]);
    await git(repo, "stash", "push", "-q");
    await waitFor(() => events.length > 0, 3000);
  });

  it("emits for a tag created in a new refs subdirectory", async () => {
    const repo = await newRepo();
    const { events } = await watchRepos([repo]);
    await git(repo, "branch", "feature/deep/name");
    await waitFor(() => events.length > 0, 3000);
    events.length = 0;
    await sleep(800);
    await git(repo, "update-ref", "refs/heads/feature/deep/name", (await git(repo, "rev-parse", "HEAD")).trim());
    await commitFile(repo, "again.txt");
    await waitFor(() => events.length > 0, 3000);
  });

  it("only watches while there are subscribers", async () => {
    const repo = await newRepo();
    const watcher = new RepoWatcher({ log: () => undefined });
    active.push(watcher);
    await watcher.addRepo(repo);
    expect(watcher.strategyOf(repo)).toBeUndefined();
    const unsubscribe = watcher.subscribe(() => undefined);
    await watcher.ready();
    expect(watcher.strategyOf(repo)).toBeDefined();
    unsubscribe();
    expect(watcher.strategyOf(repo)).toBeUndefined();
    expect(watcher.subscriberCount).toBe(0);
  });

  it("uses the requested strategy", async () => {
    const repo = await newRepo();
    const poll = await watchRepos([repo], { strategy: "poll" });
    expect(poll.watcher.strategyOf(repo)).toBe("poll");
    const auto = await watchRepos([repo]);
    expect(auto.watcher.strategyOf(repo)).toBe(process.platform === "linux" ? "poll" : "native");
  });
});
