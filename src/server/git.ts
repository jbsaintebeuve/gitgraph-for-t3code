import { execFile } from "node:child_process";

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

export interface RunGitOptions {
  /** Extra environment variables (merged over process.env). */
  env?: Record<string, string>;
  /** Exit codes treated as success, e.g. 1 for `git diff --no-index` which means "differences found". */
  okExitCodes?: number[];
  /** Cap on captured stdout; see {@link runGitCapped}. */
  maxBuffer?: number;
  /** Kill git after this many milliseconds (default: no timeout). */
  timeoutMs?: number;
  /**
   * Run git in its own session (POSIX setsid) so it has no controlling terminal: ssh and friends
   * then fail immediately instead of waiting on /dev/tty for a passphrase / host-key answer.
   */
  noTty?: boolean;
}

interface GitResult {
  stdout: string;
  truncated: boolean;
}

function exec(cwd: string, args: string[], opts: RunGitOptions, allowTruncate: boolean): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=off", "-c", "color.ui=false", ...args],
      {
        cwd,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGTERM" as const } : {}),
        env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, truncated: false });
        if (allowTruncate && (error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return resolve({ stdout: String(stdout), truncated: true });
        }
        const code = typeof error.code === "number" ? error.code : null;
        if (code !== null && opts.okExitCodes?.includes(code)) return resolve({ stdout, truncated: false });
        reject(new GitError(stderr.trim() || error.message, stderr, code));
      },
    );
  });
}

/**
 * Runs git without a shell so arguments are never interpreted: portable across
 * macOS and Linux and safe against injection through ref names or paths.
 */
export async function runGit(cwd: string, args: string[], opts: RunGitOptions = {}): Promise<string> {
  return (await exec(cwd, args, opts, false)).stdout;
}

/** Like runGit but keeps the first `maxBuffer` bytes of output instead of failing when it is exceeded. */
export function runGitCapped(
  cwd: string,
  args: string[],
  opts: RunGitOptions & { maxBuffer: number },
): Promise<GitResult> {
  return exec(cwd, args, opts, true);
}

/** Returns the top-level directory of the repository (or worktree) containing `dir`. */
export async function resolveRepoRoot(dir: string): Promise<string> {
  return (await runGit(dir, ["rev-parse", "--show-toplevel"])).trim();
}

export interface GitOutcome {
  /** Exit code; null when git could not be started or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Like runGit but never rejects: returns exit code, stdout and stderr (used for user-triggered actions). */
export function runGitOutcome(cwd: string, args: string[], opts: RunGitOptions = {}): Promise<GitOutcome> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=off", "-c", "color.ui=false", ...args],
      {
        cwd,
        ...(opts.noTty && process.platform !== "win32" ? { detached: true } : {}),
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGTERM" as const } : {}),
        env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        const e = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        resolve({
          code: !e ? 0 : typeof e.code === "number" ? e.code : null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "") || (e && typeof e.code !== "number" ? e.message : ""),
          timedOut: !!e?.killed && e.signal === "SIGTERM",
        });
      },
    );
  });
}
