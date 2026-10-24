import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { runCompat, runDoctor, runInit } from "./commands.js";
import { resolveRepoRoot } from "./git.js";
import { readInstance, removeInstanceIfOwned, writeInstance, type InstanceInfo } from "./instance.js";
import { RepoRegistry } from "./repos.js";
import { checkInstalledT3, missingFields } from "./t3compat.js";
import { RepoWatcher } from "./watcher.js";

const DEFAULT_PORT = 4777;
const FOLLOW_INTERVAL_MS = 3000;

const HELP = `Usage:
  gitgraph [serve] [--repo <dir>] [--port <port>]   serve the graph UI (default command)
  gitgraph init [--global-snippet]                  add the "Git Graph" script to ./t3.json
  gitgraph doctor                                   check the local setup
  gitgraph compat [--online] [--json]               check the installed T3 Code (and, online,
                                                    its public t3.json schema) still supports
                                                    previewUrl / autoOpenPreview
  gitgraph --version | help

Options:
  --repo <dir>   repository to show (default: .)
  --port <port>  port to listen on (default ${DEFAULT_PORT}, or $GITGRAPH_PORT)

Serves a commit graph UI on http://127.0.0.1:<port>. If another gitgraph already serves
that port, the repository is registered with it and this process stays alive to take over
if that server stops.`;

function packageVersion(): string {
  try {
    const url = new URL("../../../package.json", import.meta.url);
    return (JSON.parse(readFileSync(url, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

let parsed: ReturnType<typeof parseCli>;
function parseCli() {
  return parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string", default: "." },
      port: { type: "string", default: process.env.GITGRAPH_PORT ?? String(DEFAULT_PORT) },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
      "global-snippet": { type: "boolean", default: false },
      online: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
}
try {
  parsed = parseCli();
} catch (error) {
  console.error(`[gitgraph] ${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
  process.exit(2);
}
const { values, positionals } = parsed;
const command = positionals[0] ?? "serve";

if (values.version || command === "version") {
  console.log(packageVersion());
  process.exit(0);
}
if (values.help || command === "help") {
  console.log(HELP);
  process.exit(0);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[gitgraph] invalid port: ${values.port}`);
  process.exit(2);
}
const repoDir = resolve(values.repo ?? ".");
const log = (message: string) => console.log(`[gitgraph] ${message}`);

async function api<T>(instance: InstanceInfo, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${instance.port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-gitgraph-token": instance.token, ...init?.headers },
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

/** Registers our repo with the running server. Returns false if no healthy server is reachable. */
async function registerWithExisting(activate: boolean): Promise<boolean> {
  const instance = await readInstance();
  if (!instance || instance.port !== port) return false;
  try {
    await api(instance, "/api/repos", { method: "POST", body: JSON.stringify({ path: repoDir, activate }) });
    return true;
  } catch {
    return false;
  }
}

/** What answers on our port: a gitgraph server, another program, or nothing we can talk to. */
async function probePort(): Promise<"gitgraph" | "foreign" | "unreachable"> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    const body = (await response.json().catch(() => ({}))) as { app?: string };
    return body.app === "gitgraph-t3" ? "gitgraph" : "foreign";
  } catch {
    return "unreachable";
  }
}

function startServer(): Promise<boolean> {
  const token = randomBytes(24).toString("base64url");
  const repos = new RepoRegistry();
  // Watches registered repos (via registry notifications) only while SSE clients are connected.
  const watcher = new RepoWatcher({ registry: repos });
  const app = createApp({ port, token, repos, watcher });

  return new Promise((resolveStart, rejectStart) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, async () => {
      try {
        const entry = await repos.register(repoDir, { activate: true });
        await writeInstance({ port, token, pid: process.pid });
        log(`serving ${entry.path} on http://127.0.0.1:${port}`);
        log(`if T3 Code's Preview does not open by itself, open http://127.0.0.1:${port} there (or in a browser)`);
        void warnIfT3Incompatible();
        resolveStart(true);
      } catch (error) {
        rejectStart(error);
      }
    });
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolveStart(false);
      else rejectStart(error);
    });
  });
}

/**
 * Fallback when a T3 Code update drops the script fields we rely on: say so loudly in the
 * script's terminal instead of leaving an empty Preview. Best effort, never blocks serving.
 */
async function warnIfT3Incompatible(): Promise<void> {
  const bundle = await checkInstalledT3().catch(() => undefined);
  const missing = bundle ? missingFields(bundle.fields) : [];
  if (!bundle || missing.length === 0) return;
  log(`warning: T3 Code ${bundle.version ?? ""} no longer seems to support ${missing.join(", ")} in t3.json scripts.`);
  log(`         Open http://127.0.0.1:${port} by hand in T3's Preview or a browser; see AGENTS.md to adapt gitgraph.`);
}

/**
 * One server per port, shared by every repository: T3's `previewUrl` is static, so every
 * project points at the same URL. Followers keep re-registering and take over if the
 * serving process exits (e.g. its T3 thread was closed).
 */
async function main() {
  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Never let cleanup keep the process alive (a second signal also exits at once).
    setTimeout(() => process.exit(code), 2000).unref();
    await removeInstanceIfOwned(process.pid).catch(() => undefined);
    process.exit(code);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => void shutdown(0));
  // A stray rejection (e.g. a write on a closed SSE stream) must not take the shared server down.
  process.on("unhandledRejection", (reason) => log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`));
  process.on("uncaughtException", (error) => {
    console.error(`[gitgraph] fatal: ${error.stack ?? error.message}`);
    void shutdown(1);
  });

  // Fail fast on a wrong --repo instead of waiting forever as a "follower" that can never register.
  try {
    await resolveRepoRoot(repoDir);
  } catch {
    console.error(`[gitgraph] ${repoDir} is not inside a git repository`);
    process.exit(1);
  }

  let registered = false;
  let waitingLogged = false;
  for (;;) {
    // Only the first registration activates: periodic re-registration must not steal focus.
    if (await registerWithExisting(!registered)) {
      if (!registered) log(`registered ${repoDir} with the running server on port ${port}`);
      registered = true;
    } else {
      if (await startServer()) return;
      // Port taken: by a gitgraph server (wait and follow it), or by an unrelated program (give up).
      const owner = await probePort();
      if (owner === "foreign") {
        console.error(`[gitgraph] port ${port} is used by another program. Free it or choose another port (--port / $GITGRAPH_PORT, and the same port in previewUrl).`);
        process.exit(1);
      }
      if (!waitingLogged) log(`port ${port} is busy; waiting for a gitgraph server to appear…`);
      waitingLogged = true;
    }
    await new Promise((r) => setTimeout(r, FOLLOW_INTERVAL_MS));
  }
}

async function run(): Promise<void> {
  if (command === "init") {
    process.exit(await runInit({ repo: values.repo ?? ".", port, defaultPort: DEFAULT_PORT, globalSnippet: values["global-snippet"] }));
  }
  if (command === "compat") process.exit(await runCompat({ online: values.online, json: values.json }));
  if (command === "doctor") process.exit(await runDoctor({ repo: values.repo ?? ".", port, version: packageVersion() }));
  if (command !== "serve") {
    console.error(`[gitgraph] unknown command: ${command}\n\n${HELP}`);
    process.exit(2);
  }
  await main();
}

run().catch((error) => {
  console.error(`[gitgraph] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
