import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGit } from "./git.js";
import { startMcpServer } from "./mcp.js";

const ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.com",
};
const saved: Record<string, string | undefined> = {};
let dir = "";
let client: Client;

const git = async (...args: string[]) => (await runGit(dir, args)).trim();
const commit = async (file: string, msg: string) => {
  await writeFile(join(dir, file), msg);
  await git("add", "-A");
  await git("commit", "-q", "-m", msg);
};
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: any };
  return { ...res, text: res.content.map((c) => c.text).join("\n") };
};

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  dir = await realpath(await mkdtemp(join(tmpdir(), "gitgraph-mcp-")));
  await git("init", "-q", "-b", "main");
  await git("config", "commit.gpgsign", "false");
  await commit("a.txt", "base");
  await git("checkout", "-q", "-b", "feature");
  await commit("f.txt", "feature work");
  await git("checkout", "-q", "main");
  await commit("m.txt", "main work");
  await git("merge", "-q", "--no-ff", "-m", "merge feature", "feature");
  await git("tag", "v1");
  // A T3 Code checkpoint ref that must never be shown.
  await git("update-ref", "refs/t3/checkpoints/x", "HEAD");

  const [ct, st] = InMemoryTransport.createLinkedPair();
  await startMcpServer({ defaultRepo: dir }, st);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(ct);
});

afterAll(async () => {
  await client?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("gitgraph MCP server", () => {
  it("lists tools with correct annotations", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const readOnly = ["git_graph", "git_commit_details", "git_diff", "git_compare", "git_search", "git_refs", "git_graph_open_url"];
    for (const n of readOnly) expect(byName.get(n)?.annotations?.readOnlyHint, n).toBe(true);
    const action = byName.get("git_action");
    expect(action?.annotations?.destructiveHint).toBe(true);
    expect(action?.annotations?.readOnlyHint).toBe(false);
    expect(tools).toHaveLength(8);
  });

  it("renders the graph with merge structure and refs", async () => {
    const res = await call("git_graph", { limit: 10 });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("HEAD: main");
    expect(res.text).toContain("HEAD -> main");
    expect(res.text).toContain("tag: v1");
    expect(res.text).toContain("feature");
    expect(res.text).toMatch(/\[merge [0-9a-f]{8}\]/);
    expect(res.text).toContain("merge feature");
    expect(res.text).toContain("│");
    expect(res.text).toContain("╮");
    expect(res.structuredContent.commits).toHaveLength(4);
    expect(res.text).not.toContain("refs/t3");
  });

  it("shows commit details, search and compare", async () => {
    const hash = await git("rev-parse", "feature");
    const d = await call("git_commit_details", { hash });
    expect(d.text).toContain("feature work");
    expect(d.text).toContain("A f.txt (+1 -0)");
    expect((await call("git_search", { query: "feature work" })).text).toContain("feature work");
    expect((await call("git_compare", { from: "feature", to: "main" })).text).toContain("m.txt");
    expect((await call("git_diff", { hash, path: "f.txt" })).text).toContain("+feature work");
  });

  it("creates a branch through git_action and lists it in git_refs", async () => {
    const res = await call("git_action", { action: { type: "createBranch", name: "topic", startPoint: "main", checkout: false } });
    expect(res.isError).toBeFalsy();
    expect(res.text).toMatch(/^ok/);
    const refs = await call("git_refs");
    expect(refs.text).toContain("topic");
    expect(refs.text).toContain("* main");
    expect(refs.text).toContain("v1");
    expect(refs.text).not.toContain("t3/");
  });

  it("returns isError for invalid actions and bad repos", async () => {
    const bad = await call("git_action", { action: { type: "nope" } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("unknown action type");
    const missing = await call("git_action", { action: { type: "checkout" } });
    expect(missing.isError).toBe(true);
    const notRepo = await call("git_graph", { repo: tmpdir() });
    expect(notRepo.isError).toBe(true);
  });

  it("gives the UI url", async () => {
    const res = await call("git_graph_open_url");
    expect(res.text).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
    expect(res.text).toContain("preview_open");
  });
});
