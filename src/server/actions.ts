import type { ActionResult, GitAction, RepoOperation } from "../shared/types.js";
import { runGitOutcome, type RunGitOptions } from "./git.js";
import { BadRequestError, readOperation } from "./graph.js";

/* ------------------------------------------------------- input schema */

type FieldKind = "string" | "string?" | "boolean" | readonly string[];

/** Every accepted action with its fields. Unknown types/fields are rejected or dropped. */
const SCHEMA: Record<GitAction["type"], Record<string, FieldKind>> = {
  checkout: { ref: "string" },
  checkoutCommit: { hash: "string" },
  createBranch: { name: "string", startPoint: "string", checkout: "boolean" },
  deleteBranch: { name: "string", force: "boolean" },
  deleteRemoteBranch: { remote: "string", name: "string" },
  renameBranch: { oldName: "string", newName: "string" },
  merge: { ref: "string", noFastForward: "boolean", squash: "boolean" },
  rebase: { onto: "string" },
  cherryPick: { hash: "string", noCommit: "boolean" },
  revert: { hash: "string" },
  reset: { hash: "string", mode: ["soft", "mixed", "hard"] },
  createTag: { name: "string", hash: "string", message: "string?" },
  deleteTag: { name: "string" },
  pushTag: { remote: "string", name: "string" },
  stashPush: { message: "string?", includeUntracked: "boolean" },
  stashApply: { name: "string" },
  stashPop: { name: "string" },
  stashDrop: { name: "string" },
  stashBranch: { name: "string", branch: "string" },
  fetch: { remote: "string?", prune: "boolean" },
  pull: { rebase: "boolean" },
  push: { branch: "string", remote: "string", setUpstream: "boolean", force: ["none", "with-lease"] },
  abortOperation: {},
  continueOperation: {},
};

/** Validates the shape of an untrusted JSON body and returns a clean GitAction (throws BadRequestError). */
export function parseAction(body: unknown): GitAction {
  if (typeof body !== "object" || body === null) throw new BadRequestError("action must be a JSON object");
  const input = body as Record<string, unknown>;
  const type = input.type;
  if (typeof type !== "string" || !Object.hasOwn(SCHEMA, type)) throw new BadRequestError(`unknown action type: ${String(type)}`);
  const out: Record<string, unknown> = { type };
  for (const [field, kind] of Object.entries(SCHEMA[type as GitAction["type"]])) {
    const value = input[field];
    if (kind === "boolean") {
      if (value !== undefined && typeof value !== "boolean") throw new BadRequestError(`${field} must be a boolean`);
      out[field] = value ?? false;
    } else if (kind === "string?") {
      if (value !== undefined && value !== null && typeof value !== "string") throw new BadRequestError(`${field} must be a string`);
      if (typeof value === "string" && value !== "") out[field] = value;
    } else if (kind === "string") {
      if (typeof value !== "string" || value === "") throw new BadRequestError(`${field} is required`);
      out[field] = value;
    } else {
      if (typeof value !== "string" || !kind.includes(value)) throw new BadRequestError(`${field} must be one of ${kind.join(", ")}`);
      out[field] = value;
    }
  }
  return out as unknown as GitAction;
}

/* -------------------------------------------------------------- mutex */

const locks = new Map<string, Promise<unknown>>();

/** Runs `fn` after every previously queued job for the same repository (simple promise chain). */
export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(repo) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const tail = next.catch(() => undefined);
  locks.set(repo, tail);
  void tail.then(() => {
    if (locks.get(repo) === tail) locks.delete(repo);
  });
  return next;
}

/* --------------------------------------------------------- validation */

const NETWORK_TIMEOUT_MS = 120_000;
const LOCAL_TIMEOUT_MS = 300_000;
const HASH_RE = /^[0-9a-f]{4,64}$/i;
const STASH_RE = /^stash@\{\d+\}$/;
const NON_INTERACTIVE_ENV = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" };

const bad = (message: string): never => {
  throw new BadRequestError(message);
};

class Runner {
  constructor(readonly repo: string) {}

  run(args: string[], opts: RunGitOptions = {}) {
    return runGitOutcome(this.repo, args, { timeoutMs: LOCAL_TIMEOUT_MS, ...opts, env: { ...NON_INTERACTIVE_ENV, ...opts.env } });
  }

  async ok(args: string[]): Promise<boolean> {
    return (await this.run(args)).code === 0;
  }

  private noDash(value: string, label: string) {
    if (value.startsWith("-")) bad(`invalid ${label}: must not start with "-"`);
    if (/[\x00-\x1f\x7f]/.test(value)) bad(`invalid ${label}: control characters`);
  }

  /** Validates a NEW or existing local branch name with git itself. */
  async branchName(name: string, label = "branch name"): Promise<string> {
    this.noDash(name, label);
    if (name === "HEAD" || name.includes("@{")) bad(`invalid ${label}: ${name}`);
    if (!(await this.ok(["check-ref-format", "--branch", name]))) bad(`invalid ${label}: ${name}`);
    return name;
  }

  async tagName(name: string): Promise<string> {
    this.noDash(name, "tag name");
    if (!(await this.ok(["check-ref-format", `refs/tags/${name}`]))) bad(`invalid tag name: ${name}`);
    return name;
  }

  async commit(hash: string): Promise<string> {
    if (!HASH_RE.test(hash)) bad(`invalid commit hash: ${hash}`);
    const result = await this.run(["rev-parse", "--verify", "--end-of-options", `${hash}^{commit}`]);
    if (result.code !== 0) bad(`unknown commit: ${hash}`);
    return result.stdout.trim();
  }

  /** A branch, remote branch, tag, HEAD or commit hash that resolves to a commit. */
  async commitish(ref: string): Promise<string> {
    this.noDash(ref, "ref");
    if (!HASH_RE.test(ref) && ref !== "HEAD" && !(await this.ok(["check-ref-format", `refs/x/${ref}`]))) bad(`invalid ref: ${ref}`);
    const result = await this.run(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
    if (result.code !== 0) bad(`unknown ref: ${ref}`);
    return ref;
  }

  async localBranchExists(name: string): Promise<boolean> {
    return this.ok(["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
  }

  async remote(name: string): Promise<string> {
    this.noDash(name, "remote");
    const remotes = (await this.run(["remote"])).stdout.split("\n").filter(Boolean);
    if (!remotes.includes(name)) bad(`unknown remote: ${name}`);
    return name;
  }

  async stash(name: string): Promise<string> {
    if (!STASH_RE.test(name)) bad(`invalid stash: ${name}`);
    if (!(await this.ok(["rev-parse", "--verify", "--quiet", name]))) bad(`unknown stash: ${name}`);
    return name;
  }

  async isMerge(hash: string): Promise<boolean> {
    return this.ok(["rev-parse", "--verify", "--quiet", `${hash}^2`]);
  }

  async conflicts(): Promise<string[]> {
    const { stdout } = await this.run(["diff", "--name-only", "-z", "--diff-filter=U"]);
    return stdout.split("\0").filter(Boolean);
  }
}

/** Paths currently in a conflicted (unmerged) state. */
export async function listConflicts(repo: string): Promise<string[]> {
  return new Runner(repo).conflicts();
}

/* ------------------------------------------------------------ actions */

interface Plan {
  args: string[];
  network?: boolean;
}

async function plan(r: Runner, action: GitAction): Promise<Plan> {
  switch (action.type) {
    case "checkout": {
      const ref = action.ref;
      await r.commitish(ref);
      if (await r.localBranchExists(ref)) return { args: ["switch", "--end-of-options", ref] };
      if (await r.ok(["show-ref", "--verify", "--quiet", `refs/remotes/${ref}`])) {
        const slash = ref.indexOf("/");
        const local = slash < 0 ? ref : ref.slice(slash + 1);
        await r.branchName(local);
        if (await r.localBranchExists(local)) return { args: ["switch", "--end-of-options", local] };
        return { args: ["switch", "-c", local, "--track", ref] };
      }
      return bad(`not a branch: ${ref}`);
    }
    case "checkoutCommit":
      return { args: ["switch", "--detach", await r.commit(action.hash)] };
    case "createBranch": {
      const name = await r.branchName(action.name);
      const start = await r.commitish(action.startPoint);
      return { args: action.checkout ? ["switch", "-c", name, start] : ["branch", "--end-of-options", name, start] };
    }
    case "deleteBranch": {
      const name = await r.branchName(action.name);
      if (!(await r.localBranchExists(name))) bad(`unknown branch: ${name}`);
      return { args: ["branch", action.force ? "-D" : "-d", "--end-of-options", name] };
    }
    case "deleteRemoteBranch": {
      const remote = await r.remote(action.remote);
      const name = await r.branchName(action.name);
      return { args: ["push", remote, "--delete", name], network: true };
    }
    case "renameBranch": {
      const oldName = await r.branchName(action.oldName, "old branch name");
      const newName = await r.branchName(action.newName, "new branch name");
      if (!(await r.localBranchExists(oldName))) bad(`unknown branch: ${oldName}`);
      return { args: ["branch", "-m", oldName, newName] };
    }
    case "merge": {
      const ref = await r.commitish(action.ref);
      const flags = action.squash ? ["--squash"] : action.noFastForward ? ["--no-ff"] : [];
      return { args: ["merge", ...flags, "--no-edit", "--end-of-options", ref] };
    }
    case "rebase":
      return { args: ["rebase", "--end-of-options", await r.commitish(action.onto)] };
    case "cherryPick": {
      const hash = await r.commit(action.hash);
      return {
        args: ["cherry-pick", ...(action.noCommit ? ["-n"] : []), ...((await r.isMerge(hash)) ? ["-m", "1"] : []), hash],
      };
    }
    case "revert": {
      const hash = await r.commit(action.hash);
      return { args: ["revert", "--no-edit", ...((await r.isMerge(hash)) ? ["-m", "1"] : []), hash] };
    }
    case "reset":
      return { args: ["reset", `--${action.mode}`, await r.commit(action.hash), "--"] };
    case "createTag": {
      const name = await r.tagName(action.name);
      const hash = await r.commit(action.hash);
      return { args: action.message ? ["tag", "-a", "-m", action.message, name, hash] : ["tag", name, hash] };
    }
    case "deleteTag": {
      const name = await r.tagName(action.name);
      return { args: ["tag", "-d", name] };
    }
    case "pushTag": {
      const remote = await r.remote(action.remote);
      const name = await r.tagName(action.name);
      return { args: ["push", remote, `refs/tags/${name}`], network: true };
    }
    case "stashPush":
      return {
        args: ["stash", "push", ...(action.includeUntracked ? ["-u"] : []), ...(action.message ? ["-m", action.message] : [])],
      };
    case "stashApply":
      return { args: ["stash", "apply", await r.stash(action.name)] };
    case "stashPop":
      return { args: ["stash", "pop", await r.stash(action.name)] };
    case "stashDrop":
      return { args: ["stash", "drop", await r.stash(action.name)] };
    case "stashBranch":
      return { args: ["stash", "branch", await r.branchName(action.branch), await r.stash(action.name)] };
    case "fetch": {
      const target = action.remote ? await r.remote(action.remote) : "--all";
      return { args: ["fetch", ...(action.prune ? ["--prune"] : []), target], network: true };
    }
    case "pull":
      return { args: ["pull", ...(action.rebase ? ["--rebase"] : ["--no-rebase", "--no-edit"])], network: true };
    case "push": {
      const remote = await r.remote(action.remote);
      const branch = await r.branchName(action.branch);
      if (!(await r.localBranchExists(branch))) bad(`unknown branch: ${branch}`);
      return {
        args: ["push", ...(action.setUpstream ? ["-u"] : []), ...(action.force === "with-lease" ? ["--force-with-lease"] : []), remote, branch],
        network: true,
      };
    }
    case "abortOperation":
    case "continueOperation": {
      const operation: RepoOperation = await readOperation(r.repo);
      if (!operation) return bad("no operation in progress");
      return { args: [operation, action.type === "abortOperation" ? "--abort" : "--continue"] };
    }
  }
}

/**
 * Runs one validated git action. Throws BadRequestError for invalid input (nothing is executed);
 * git failures are reported as `ok: false` with git's output.
 * Calls are serialized per repository.
 */
export async function runAction(repoPath: string, rawAction: GitAction): Promise<ActionResult> {
  const action = parseAction(rawAction);
  return withRepoLock(repoPath, async () => {
    const runner = new Runner(repoPath);
    const { args, network } = await plan(runner, action);
    const result = await runner.run(args, { timeoutMs: network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS, noTty: network });
    let output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    if (result.timedOut) output += `${output ? "\n" : ""}git timed out and was stopped.`;
    if (result.code === 0) return { ok: true, output };
    const conflicts = await runner.conflicts();
    return conflicts.length > 0 ? { ok: false, output, conflicts } : { ok: false, output };
  });
}
