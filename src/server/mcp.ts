import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { computeLayout } from "../shared/layout.js";
import { UNCOMMITTED_HASH, type FileChange, type GraphCommit, type GraphPage } from "../shared/types.js";
import { parseAction, runAction } from "./actions.js";
import {
  compareCommits,
  loadCommitDetails,
  loadFileDiff,
  loadGraphPage,
  loadUncommittedChanges,
  loadUncommittedFileDiff,
  searchCommits,
} from "./graph.js";
import { resolveRepoRoot, runGit } from "./git.js";
import { readInstance } from "./instance.js";

const DEFAULT_PORT = 4777;
const MAX_GRAPH_COMMITS = 500;
/** Same cap as the HTTP API page size. */
const MAX_LAYOUT_COMMITS = 5000;
const MAX_PATCH_CHARS = 40 * 1024;
const MAX_SEARCH_LINES = 50;

export interface McpOptions {
  /** Repository used when a tool call omits `repo`. Defaults to process.cwd(). */
  defaultRepo?: string;
}

/* --------------------------------------------------------------- helpers */

const text = (t: string, structured?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: t }],
  ...(structured ? { structuredContent: structured } : {}),
});

const errorResult = (e: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
});

/** Wraps a handler so that any failure becomes an `isError` result instead of a protocol error. */
function safe<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return errorResult(e);
    }
  };
}

function relativeDate(unixSeconds: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor(now / 1000 - unixSeconds));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 60) return `${Math.floor(s / (86400 * 7))}w ago`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30.44))}mo ago`;
  return `${Math.floor(s / (86400 * 365.25))}y ago`;
}

/** Accepts a hash or a ref name (branch, tag, HEAD~1...) and returns the full commit hash. */
async function toHash(root: string, rev: string): Promise<string> {
  if (rev.startsWith("-") || /[\0-\x1f]/.test(rev)) throw new Error(`invalid revision: ${rev}`);
  try {
    return (await runGit(root, ["rev-parse", "--verify", "-q", `${rev}^{commit}`])).trim();
  } catch {
    throw new Error(`unknown revision: ${rev}`);
  }
}

const short = (h: string) => h.slice(0, 8);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function formatFiles(files: FileChange[]): string {
  if (files.length === 0) return "(no changed files)";
  return files
    .map((f) => {
      const stat = f.binary ? "binary" : `+${f.additions} -${f.deletions}`;
      const path = f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path;
      return `${f.status} ${path} (${stat})`;
    })
    .join("\n");
}

/* ----------------------------------------------------------- ASCII graph */

// Direction bits of a text cell; the box-drawing glyph is derived from the set of bits.
const UP = 1;
const DOWN = 2;
const LEFT = 4;
const RIGHT = 8;
const GLYPH: Record<number, string> = {
  [UP]: "│",
  [DOWN]: "│",
  [UP | DOWN]: "│",
  [LEFT]: "─",
  [RIGHT]: "─",
  [LEFT | RIGHT]: "─",
  [DOWN | RIGHT]: "╭",
  [DOWN | LEFT]: "╮",
  [UP | RIGHT]: "╰",
  [UP | LEFT]: "╯",
  [UP | DOWN | RIGHT]: "├",
  [UP | DOWN | LEFT]: "┤",
  [LEFT | RIGHT | DOWN]: "┬",
  [LEFT | RIGHT | UP]: "┴",
  [UP | DOWN | LEFT | RIGHT]: "┼",
};

/**
 * Renders commits as lines "<graph> <hash> (<refs>) <subject> — <author>, <date>", with the
 * graph taken faithfully from computeLayout. A lane is 2 characters wide ("●" / "│" in the even
 * column, connector runs use the odd one):
 *  - "●"  the commit; "│" a line passing through the row (one per active edge lane);
 *  - a merge edge that leaves its commit sideways is drawn on the commit's row:  "●─╮" / "╭─●";
 *  - an edge converging into its parent from another lane is drawn on the parent's row: "●─╯" / "╰─●";
 *  - crossings and junctions use ┼ ┬ ┴ ├ ┤ so that no line is hidden.
 * `firstRow` skips the first rows from the output (they still take part in the layout, so that
 * a later page shows the lines coming from the commits above it).
 */
export function renderGraph(
  page: GraphPage,
  now = Date.now(),
  firstRow = 0,
): { lines: string[]; commits: GraphCommit[] } {
  const all = page.commits;
  const layout = computeLayout(all.map((c) => ({ hash: c.hash, parents: c.parents })));
  const width = Math.max(1, layout.laneCount);
  const cols = width * 2 - 1;

  const refsByTarget = new Map<string, string[]>();
  for (const ref of page.refs) {
    if (ref.kind === "stash") continue;
    const label = ref.isHead ? `HEAD -> ${ref.name}` : ref.kind === "tag" ? `tag: ${ref.name}` : ref.name;
    const list = refsByTarget.get(ref.target) ?? [];
    list.push(label);
    refsByTarget.set(ref.target, list);
  }
  if (page.head.detached && page.head.hash) {
    const list = refsByTarget.get(page.head.hash) ?? [];
    list.unshift("HEAD");
    refsByTarget.set(page.head.hash, list);
  }

  const bits: Uint8Array[] = all.map(() => new Uint8Array(cols));
  /** Horizontal run between two lanes on `row`, with the corner bits at both ends. */
  const connect = (row: number, a: number, b: number, bitsA: number, bitsB: number) => {
    const cells = bits[row]!;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (let x = lo * 2 + 1; x < hi * 2; x++) cells[x]! |= LEFT | RIGHT;
    cells[a * 2]! |= bitsA;
    cells[b * 2]! |= bitsB;
  };

  for (const e of layout.edges) {
    const pts = e.points;
    for (let k = 1; k < pts.length - 1; k++) {
      const p = pts[k]!;
      if (p.row < all.length) bits[p.row]![p.lane * 2]! |= UP | DOWN; // line passing through the row
    }
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k]!;
      const b = pts[k + 1]!;
      if (a.lane === b.lane) continue;
      const toRight = b.lane > a.lane;
      // A merge edge leaves its commit sideways on the commit's own row; every other lane
      // change is the edge joining its parent, drawn on the row where it arrives.
      const leavesCommit = k === 0 && (e.merge || pts.length > 2);
      if (leavesCommit) {
        connect(a.row, a.lane, b.lane, toRight ? RIGHT : LEFT, DOWN | (toRight ? LEFT : RIGHT));
      } else if (b.row < all.length) {
        connect(b.row, a.lane, b.lane, UP | (toRight ? RIGHT : LEFT), toRight ? LEFT : RIGHT);
      }
    }
  }

  const lines: string[] = [];
  for (let i = firstRow; i < all.length; i++) {
    const c = all[i]!;
    const cells = bits[i]!;
    let graph = "";
    for (let x = 0; x < cols; x++) graph += x === layout.rows[i]!.lane * 2 ? "●" : cells[x] ? (GLYPH[cells[x]!] ?? "┼") : " ";
    graph = graph.trimEnd().padEnd(cols);
    const refs = refsByTarget.get(c.hash);
    const merge = c.parents.length > 1 ? ` [merge ${c.parents.slice(1).map(short).join(",")}]` : "";
    lines.push(
      `${graph} ${short(c.hash)}${refs ? ` (${refs.join(", ")})` : ""} ${clip(c.subject, 80)}${merge} — ${clip(c.author, 24)}, ${relativeDate(c.authorDate, now)}`,
    );
  }
  return { lines, commits: all.slice(firstRow) };
}

/* ---------------------------------------------------------------- server */

const repoParam = z
  .string()
  .optional()
  .describe("Path to a git repository (or any directory inside it). Defaults to the server's repository.");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function createMcpServer(options: McpOptions = {}): McpServer {
  const defaultRepo = resolve(options.defaultRepo ?? process.cwd());
  const repoOf = (repo?: string) => resolveRepoRoot(repo ? resolve(defaultRepo, repo) : defaultRepo);

  const server = new McpServer({ name: "gitgraph", version: "0.1.0" });

  server.registerTool(
    "git_graph",
    {
      title: "Git commit graph",
      description:
        "Shows the commit graph of a repository as compact ASCII (newest first, all branches/remotes/tags by default) with short hashes, ref decorations, subjects, authors and dates. The header gives HEAD, any merge/rebase in progress and working-tree counts. Use `skip` to page further back.",
      inputSchema: {
        repo: repoParam,
        limit: z.number().int().min(1).max(MAX_GRAPH_COMMITS).default(50).describe("Commits to show (default 50, max 500)."),
        skip: z.number().int().min(0).optional().describe("Commits to skip, for pagination."),
        branches: z.array(z.string()).optional().describe("Only show these branches (short names, e.g. 'main', 'origin/dev')."),
        firstParent: z.boolean().optional().describe("Follow only first parents (hides merged side branches)."),
      },
      annotations: { ...READ_ONLY, title: "Git commit graph" },
    },
    safe(async ({ repo, limit, skip, branches, firstParent }) => {
      const root = await repoOf(repo);
      const start = skip ?? 0;
      // Lay out from the top so that a later page shows the lines coming from the commits above it.
      const fromTop = start > 0 && start + limit <= MAX_LAYOUT_COMMITS;
      const page = await loadGraphPage({
        repo: root,
        limit: fromTop ? start + limit : limit,
        skip: fromTop ? 0 : start,
        branches,
        firstParent,
        includeStashes: false,
      });
      const { lines, commits } = renderGraph(page, Date.now(), fromTop ? start : 0);
      page.commits = commits;
      const wt = page.workingTree;
      const dirty = wt
        ? `staged ${wt.staged}, unstaged ${wt.unstaged}, untracked ${wt.untracked}${wt.conflicted ? `, CONFLICTED ${wt.conflicted}` : ""}`
        : "clean";
      const head = page.head.detached ? `detached at ${short(page.head.hash ?? "")}` : (page.head.branch ?? "(no commits yet)");
      const header = [
        `repo: ${root}`,
        `HEAD: ${head}${page.head.hash ? ` ${short(page.head.hash)}` : ""}`,
        `operation in progress: ${page.operation ?? "none"}`,
        `working tree: ${dirty}`,
      ].join("\n");
      const footer = page.hasMore ? `\n… more commits: call again with skip=${start + page.commits.length}` : "";
      const refsOf = new Map<string, typeof page.refs>();
      for (const r of page.refs) {
        if (r.kind === "stash") continue;
        const list = refsOf.get(r.target);
        if (list) list.push(r);
        else refsOf.set(r.target, [r]);
      }
      const structured = {
        repo: root,
        head: page.head,
        operation: page.operation,
        workingTree: page.workingTree,
        hasMore: page.hasMore,
        commits: page.commits.map((c) => ({
          hash: c.hash,
          parents: c.parents,
          subject: c.subject,
          author: c.author,
          authorDate: c.authorDate,
          refs: (refsOf.get(c.hash) ?? []).map((r) => r.name),
        })),
      };
      return text(`${header}\n\n${lines.join("\n")}${footer}`, structured);
    }),
  );

  server.registerTool(
    "git_commit_details",
    {
      title: "Commit details",
      description: "Full message, author, parents and changed files (with +/- line counts) of one commit.",
      inputSchema: { repo: repoParam, hash: z.string().min(1).describe("Commit hash, abbreviated hash or ref name.") },
      annotations: { ...READ_ONLY, title: "Commit details" },
    },
    safe(async ({ repo, hash }) => {
      const root0 = await repoOf(repo);
      const d = await loadCommitDetails(root0, await toHash(root0, hash));
      const msg = d.body ? `${d.subject}\n\n${d.body}` : d.subject;
      return text(
        [
          `commit ${d.hash}`,
          `parents: ${d.parents.map(short).join(" ") || "(root)"}`,
          `author: ${d.author} <${d.authorEmail}>, ${new Date(d.authorDate * 1000).toISOString()}`,
          "",
          msg,
          "",
          `files (${d.files.length}):`,
          formatFiles(d.files),
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "git_diff",
    {
      title: "File diff",
      description:
        "Unified diff of one file in a commit (against its first parent), or between `compareTo` and `hash`. Use hash \"uncommitted\" for working tree changes versus HEAD. Output is truncated at ~40 KB.",
      inputSchema: {
        repo: repoParam,
        hash: z.string().min(1).describe('Commit hash/ref, or "uncommitted".'),
        path: z.string().min(1).describe("Repository-relative file path."),
        compareTo: z.string().optional().describe("Optional base commit: diff compareTo..hash."),
      },
      annotations: { ...READ_ONLY, title: "File diff" },
    },
    safe(async ({ repo, hash, path, compareTo }) => {
      const root = await repoOf(repo);
      const diff =
        hash === "uncommitted" || hash === UNCOMMITTED_HASH
          ? await loadUncommittedFileDiff(root, path)
          : await loadFileDiff(root, await toHash(root, hash), path, { compareTo: compareTo ? await toHash(root, compareTo) : undefined });
      if (diff.patch === "") return text("(empty diff: no changes for this path)");
      const cut = diff.patch.length > MAX_PATCH_CHARS || diff.truncated;
      const body = diff.patch.length > MAX_PATCH_CHARS ? diff.patch.slice(0, MAX_PATCH_CHARS) : diff.patch;
      return text(cut ? `${body}\n… [diff truncated]` : body);
    }),
  );

  server.registerTool(
    "git_compare",
    {
      title: "Compare two commits",
      description: "Lists files changed between two commits/refs (`from` -> `to`) with status and +/- counts. Use git_diff with compareTo for a patch.",
      inputSchema: { repo: repoParam, from: z.string().min(1), to: z.string().min(1) },
      annotations: { ...READ_ONLY, title: "Compare two commits" },
    },
    safe(async ({ repo, from, to }) => {
      const root = await repoOf(repo);
      return text(formatFiles(await compareCommits(root, await toHash(root, from), await toHash(root, to))));
    }),
  );

  server.registerTool(
    "git_search",
    {
      title: "Search commits",
      description: "Finds commits by message text, author, or hash prefix (case-insensitive, literal). Returns up to 50 matches.",
      inputSchema: { repo: repoParam, query: z.string().min(1).max(200) },
      annotations: { ...READ_ONLY, title: "Search commits" },
    },
    safe(async ({ repo, query }) => {
      const root = await repoOf(repo);
      const hashes = await searchCommits(root, query);
      if (hashes.length === 0) return text("no matching commits");
      const shown = hashes.slice(0, MAX_SEARCH_LINES);
      const details = await Promise.all(shown.map((h) => loadCommitDetails(root, h).catch(() => undefined)));
      const lines = shown.map((h, i) => {
        const d = details[i];
        return d ? `${short(h)} ${clip(d.subject, 80)} — ${clip(d.author, 24)}, ${relativeDate(d.authorDate)}` : short(h);
      });
      const more = hashes.length > shown.length ? `\n… ${hashes.length - shown.length} more` : "";
      return text(lines.join("\n") + more);
    }),
  );

  server.registerTool(
    "git_refs",
    {
      title: "Branches, tags and stashes",
      description: "Lists local branches (upstream, ahead/behind), remote branches, tags and stashes.",
      inputSchema: { repo: repoParam },
      annotations: { ...READ_ONLY, title: "Branches, tags and stashes" },
    },
    safe(async ({ repo }) => {
      const root = await repoOf(repo);
      const page = await loadGraphPage({ repo: root, limit: 1 });
      const by = (k: string) => page.refs.filter((r) => r.kind === k);
      const branches = by("branch").map((r) => {
        let s = `${r.isHead ? "* " : "  "}${r.name} ${short(r.target)}`;
        if (r.upstream) {
          s += ` -> ${r.upstream}`;
          if (r.upstreamGone) s += " [gone]";
          else if (r.ahead || r.behind) s += ` [ahead ${r.ahead ?? 0}, behind ${r.behind ?? 0}]`;
        }
        return s;
      });
      const section = (title: string, items: string[]) => `${title} (${items.length}):\n${items.length ? items.join("\n") : "  (none)"}`;
      return text(
        [
          section("branches", branches),
          section("remotes", by("remote").map((r) => `  ${r.name} ${short(r.target)}`)),
          section("tags", by("tag").map((r) => `  ${r.name} ${short(r.target)}`)),
          section("stashes", page.stashes.map((s) => `  ${s.name} ${short(s.base)} ${clip(s.message, 80)}`)),
        ].join("\n\n"),
      );
    }),
  );

  server.registerTool(
    "git_action",
    {
      title: "Run a git action",
      description:
        'Runs one validated git action: {"type": ...}. Types: checkout{ref}, checkoutCommit{hash}, createBranch{name,startPoint,checkout}, deleteBranch{name,force}, deleteRemoteBranch{remote,name}, renameBranch{oldName,newName}, merge{ref,noFastForward,squash}, rebase{onto}, cherryPick{hash,noCommit}, revert{hash}, reset{hash,mode:soft|mixed|hard}, createTag{name,hash,message?}, deleteTag{name}, pushTag{remote,name}, stashPush{message?,includeUntracked}, stashApply|stashPop|stashDrop{name}, stashBranch{name,branch}, fetch{remote?,prune}, pull{rebase}, push{branch,remote,setUpstream,force:none|with-lease}, abortOperation, continueOperation. Returns ok, git output and conflicting files if any. IMPORTANT: ask the user for confirmation BEFORE history-rewriting or data-losing actions (reset hard, force push, deleting a branch/tag/stash, stashDrop, rebase, deleteRemoteBranch).',
      inputSchema: {
        repo: repoParam,
        action: z
          .object({ type: z.string().describe("Action type, see tool description.") })
          .passthrough()
          .describe("Action object with its type-specific fields."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, title: "Run a git action" },
    },
    safe(async ({ repo, action }) => {
      const root = await repoOf(repo);
      const result = await runAction(root, parseAction(action));
      const parts = [result.ok ? "ok" : "FAILED"];
      if (result.output) parts.push(result.output);
      if (result.conflicts?.length) parts.push(`conflicts:\n${result.conflicts.join("\n")}`);
      return { ...text(parts.join("\n"), { ...result }), ...(result.ok ? {} : { isError: true }) };
    }),
  );

  server.registerTool(
    "git_graph_open_url",
    {
      title: "Git Graph UI URL",
      description:
        "Returns the URL of the interactive Git Graph web UI (local server).",
      inputSchema: {},
      annotations: { ...READ_ONLY, title: "Git Graph UI URL" },
    },
    safe(async () => {
      const instance = await readInstance();
      const port = instance?.port ?? Number(process.env.GITGRAPH_PORT ?? DEFAULT_PORT);
      const url = `http://127.0.0.1:${port}`;
      const note = instance
        ? "A Git Graph server appears to be running."
        : "No running Git Graph server was detected: the user can start it with the \"Git Graph\" project script in T3 Code (or `gitgraph --repo .`).";
      return text(`${url}\n${note}\nOpen it in T3 Code's preview with the preview_open tool, or ask the user to run the "Git Graph" project script.`, { url, running: Boolean(instance) });
    }),
  );

  return server;
}

/** Starts the MCP server on stdio (or on `transport`, for tests). Never writes to stdout itself. */
export async function startMcpServer(options: McpOptions = {}, transport: Transport = new StdioServerTransport()): Promise<McpServer> {
  const server = createMcpServer(options);
  await server.connect(transport);
  return server;
}
