import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { listConflicts, parseAction, runAction } from "./actions.js";
import { GitError } from "./git.js";
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
import { UNCOMMITTED_HASH, type GraphOrder } from "../shared/types.js";
import type { RepoRegistry } from "./repos.js";
import type { RepoWatcher } from "./watcher.js";

const WEB_ROOT = fileURLToPath(new URL("../../web/", import.meta.url));
const TOKEN_PLACEHOLDER = "__GITGRAPH_TOKEN__";
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export interface AppOptions {
  port: number;
  token: string;
  repos: RepoRegistry;
  /** Source of `repo-changed` SSE events; optional so tests can run without file watching. */
  watcher?: RepoWatcher;
}

/** Constant-time string comparison (the token is the only secret protecting the git actions). */
function sameSecret(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function intParam(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  // At most 9 digits: larger values are not meaningful here and would stringify as "1e+21" for git.
  if (!/^\d{1,9}$/.test(value)) throw new BadRequestError(`${name} must be a non-negative integer`);
  return Number(value);
}

function boolParam(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return value === "1" || value === "true";
}

function requiredParam(c: Context, name: string): string {
  const value = c.req.query(name);
  if (!value) throw new BadRequestError(`${name} is required`);
  return value;
}

export function createApp({ port, token, repos, watcher }: AppOptions) {
  const app = new Hono();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));

  // DNS-rebinding guard: only answer requests addressed to the loopback host.
  app.use("*", async (c, next) => {
    if (!allowedHosts.has(c.req.header("host") ?? "")) return c.text("Forbidden host", 403);
    const origin = c.req.header("origin");
    if (origin && !allowedOrigins.has(origin)) return c.text("Forbidden origin", 403);
    await next();
  });

  // The token is embedded in the served page; other sites cannot read it (same-origin
  // policy) nor send the custom header without a CORS preflight, which we never grant.
  const requireToken: MiddlewareHandler = async (c, next) => {
    const provided = c.req.header("x-gitgraph-token") ?? c.req.query("token");
    if (!sameSecret(provided, token)) return c.json({ error: "unauthorized" }, 401);
    c.header("cache-control", "no-store");
    await next();
  };

  // Unauthenticated liveness probe used by other `gitgraph` processes.
  app.get("/api/ping", (c) => c.json({ app: "gitgraph-t3", pid: process.pid }));

  app.use("/api/*", requireToken);

  app.get("/api/repos", (c) => c.json(repos.list()));

  app.post("/api/repos", async (c) => {
    const body = await c.req.json<{ path?: unknown; activate?: unknown }>().catch(() => ({}) as Record<string, unknown>);
    if (typeof body.path !== "string") return c.json({ error: "path is required" }, 400);
    try {
      return c.json(await repos.register(body.path, { activate: body.activate !== false }));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  /** Resolves the registered repo (404 otherwise) and maps failures to JSON errors. */
  const repoRoute = (handler: (repo: string, c: Context) => Promise<unknown>) => async (c: Context) => {
    const entry = repos.get(c.req.query("repo") ?? "");
    if (!entry) return c.json({ error: "unknown repository" }, 404);
    try {
      return c.json(await handler(entry.path, c) as object);
    } catch (error) {
      if (error instanceof BadRequestError) return c.json({ error: error.message }, 400);
      const message = error instanceof GitError ? error.stderr || error.message : String(error);
      return c.json({ error: message }, 500);
    }
  };

  app.get(
    "/api/graph",
    repoRoute((repo, c) => {
      const order = c.req.query("order");
      if (order && !["topo", "date", "author-date"].includes(order)) throw new BadRequestError("invalid order");
      const branches = c.req.query("branches")?.split(",").filter(Boolean);
      return loadGraphPage({
        repo,
        skip: intParam(c.req.query("skip"), "skip"),
        limit: intParam(c.req.query("limit"), "limit"),
        order: order as GraphOrder | undefined,
        branches,
        includeRemotes: boolParam(c.req.query("remotes")),
        includeStashes: boolParam(c.req.query("stashes")),
        firstParent: boolParam(c.req.query("firstParent")),
      });
    }),
  );

  app.get("/api/commit", repoRoute(async (repo, c) => loadCommitDetails(repo, requiredParam(c, "hash"))));

  app.get(
    "/api/diff",
    repoRoute(async (repo, c) => {
      const hash = requiredParam(c, "hash");
      const path = requiredParam(c, "path");
      const oldPath = c.req.query("oldPath") || undefined;
      if (hash === UNCOMMITTED_HASH) return loadUncommittedFileDiff(repo, path, { oldPath });
      return loadFileDiff(repo, hash, path, { compareTo: c.req.query("compareTo") || undefined, oldPath });
    }),
  );

  app.get(
    "/api/compare",
    repoRoute((repo, c) => compareCommits(repo, requiredParam(c, "from"), requiredParam(c, "to"))),
  );

  app.get("/api/uncommitted", repoRoute((repo) => loadUncommittedChanges(repo)));

  app.get("/api/search", repoRoute((repo, c) => searchCommits(repo, c.req.query("q") ?? "")));

  app.get("/api/conflicts", repoRoute((repo) => listConflicts(repo)));

  // Interactive git actions (token + Origin checked by the middlewares above). Serialized per repo.
  app.post(
    "/api/action",
    repoRoute(async (repo, c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      return runAction(repo, parseAction(body));
    }),
  );

  // Server-sent events: heartbeat now, repository change notifications later.
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      // A write on a connection that just closed rejects: never let that become an unhandled rejection.
      const unsubscribe = repos.onChange(() => {
        void stream.writeSSE({ event: "repos", data: JSON.stringify(repos.list()) }).catch(() => undefined);
      });
      // Each open connection ref-counts the watcher: repos are only watched while someone listens.
      const unsubscribeWatcher =
        watcher?.subscribe((repo) => {
          void stream.writeSSE({ event: "repo-changed", data: JSON.stringify({ repo }) }).catch(() => undefined);
        }) ?? (() => undefined);
      const cleanup = () => {
        unsubscribe();
        unsubscribeWatcher();
      };
      stream.onAbort(cleanup);
      let tick = 0;
      try {
        while (!stream.aborted) {
          await stream.writeSSE({ event: "heartbeat", data: String(tick++) });
          await stream.sleep(5000);
        }
      } finally {
        cleanup(); // also when a write failed without an abort signal: the watcher must not stay referenced
      }
    }),
  );

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  app.get("*", async (c) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(c.req.path);
    } catch {
      return c.text("Bad request", 400);
    }
    if (decoded.includes("\0")) return c.text("Bad request", 400);
    const requested = normalize(decoded).replace(/^([/\\])+/, "");
    const filePath = join(WEB_ROOT, requested);
    const isAsset = requested !== "" && filePath.startsWith(WEB_ROOT.endsWith(sep) ? WEB_ROOT : WEB_ROOT + sep);
    if (isAsset) {
      const content = await readFile(filePath).catch(() => undefined);
      if (content) {
        return c.body(content, 200, {
          "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
          // Vite fingerprints everything under /assets/; other files (icon...) may change between versions.
          "cache-control": requested.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
          "x-content-type-options": "nosniff",
        });
      }
    }
    // SPA fallback: index.html with the session token injected.
    const html = await readFile(join(WEB_ROOT, "index.html"), "utf8").catch(() => undefined);
    if (!html) return c.text("UI not built. Run `npm run build`.", 500);
    return c.html(html.replace(TOKEN_PLACEHOLDER, token), 200, {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
  });

  return app;
}
