import { describe, expect, it } from "vitest";
import { computeLayout } from "../shared/layout.js";
import type { GitRef, GraphCommit, GraphPage } from "../shared/types.js";
import { renderGraph } from "./mcp.js";

/** Fake commit: 8-char hash derived from the name so that snapshots are readable. */
const hashOf = (name: string) => name.padEnd(8, "0");
const commit = (name: string, parents: string[] = []): GraphCommit => ({
  hash: hashOf(name),
  parents: parents.map(hashOf),
  author: "Ada",
  authorEmail: "ada@example.com",
  authorDate: 0,
  committer: "Ada",
  committerDate: 0,
  subject: `commit ${name}`,
});
const pageOf = (commits: GraphCommit[], refs: GitRef[] = []): GraphPage => ({
  repo: "/r",
  head: { detached: false, branch: "main", hash: commits[0]?.hash },
  commits,
  refs,
  stashes: [],
  workingTree: null,
  operation: null,
  hasMore: false,
});
/** The graph part of each line (everything before the short hash column). */
const graphOf = (lines: string[]) => lines.map((l) => l.replace(/ [0-9a-z]{8} .*$/, "").trimEnd()).join("\n");

describe("renderGraph (ASCII)", () => {
  it("draws a feature branch merged back, a second branch and an octopus merge", () => {
    const commits = [
      commit("octo", ["merge", "g1", "h1"]),
      commit("h1", ["base"]),
      commit("g1", ["base"]),
      commit("merge", ["main1", "f2"]),
      commit("f2", ["f1"]),
      commit("f1", ["base"]),
      commit("main1", ["base"]),
      commit("base"),
    ];
    const { lines } = renderGraph(pageOf(commits), 0);
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "●─┬─╮   octo0000 commit octo [merge g1000000,h1000000] — Ada, now
      │ │ ●   h1000000 commit h1 — Ada, now
      │ ● │   g1000000 commit g1 — Ada, now
      ●─┼─┼─╮ merge000 commit merge [merge f2000000] — Ada, now
      │ │ │ ● f2000000 commit f2 — Ada, now
      │ │ │ ● f1000000 commit f1 — Ada, now
      ● │ │ │ main1000 commit main1 — Ada, now
      ●─┴─┴─╯ base0000 commit base — Ada, now"
    `);
  });

  it("draws a simple merge and a converging branch", () => {
    const commits = [commit("m", ["a", "b"]), commit("a", ["c"]), commit("b", ["c"]), commit("c")];
    expect(graphOf(renderGraph(pageOf(commits), 0).lines)).toMatchInlineSnapshot(`
      "●─╮
      ● │
      │ ●
      ●─╯"
    `);
  });

  it("joins a merge edge onto a lane that already exists (junctions, no hidden lines)", () => {
    // x and y both descend from p; m merges p as its second parent while lane 1 still waits for p.
    const commits = [commit("x", ["p"]), commit("y", ["p"]), commit("m", ["q", "p"]), commit("q", ["p"]), commit("p")];
    const text = graphOf(renderGraph(pageOf(commits), 0).lines);
    expect(text).toMatchInlineSnapshot(`
      "●
      │ ●
      ├─┼─●
      │ │ ●
      ●─┴─╯"
    `);
  });

  it("agrees with computeLayout: one vertical per through-lane, dot at the layout lane", () => {
    // pseudo-random but deterministic DAG
    let seed = 7;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const names: string[] = [];
    const commits: GraphCommit[] = [];
    for (let i = 0; i < 120; i++) {
      const name = `c${String(i).padStart(3, "0")}`;
      const parents: string[] = [];
      if (i > 0) {
        parents.push(names[Math.max(0, i - 1 - Math.floor(rnd() * 4))]!);
        if (rnd() < 0.25) parents.push(names[Math.floor(rnd() * i)]!);
      }
      names.push(name);
      commits.push(commit(name, [...new Set(parents)]));
    }
    commits.reverse();
    const layout = computeLayout(commits.map((c) => ({ hash: c.hash, parents: c.parents })));
    const lines = renderGraph(pageOf(commits), 0).lines;
    lines.forEach((line, r) => {
      const cells = [...line];
      expect(cells[layout.rows[r]!.lane * 2], `row ${r}`).toBe("●");
      for (const e of layout.edges) {
        for (let k = 1; k < e.points.length - 1; k++) {
          const p = e.points[k]!;
          if (p.row === r) expect("│┤├┼", `row ${r} lane ${p.lane}`).toContain(cells[p.lane * 2]!);
        }
      }
    });
  });

  it("shows the lines coming from rows above when a later page is rendered (firstRow)", () => {
    const commits = [commit("m", ["a", "b"]), commit("a", ["c"]), commit("b", ["c"]), commit("c")];
    const { lines, commits: shown } = renderGraph(pageOf(commits), 0, 2);
    expect(shown.map((c) => c.hash)).toEqual([hashOf("b"), hashOf("c")]);
    expect(graphOf(lines)).toMatchInlineSnapshot(`
      "│ ●
      ●─╯"
    `);
  });

  it("decorates refs and detached HEAD", () => {
    const commits = [commit("tip", ["base"]), commit("base")];
    const refs: GitRef[] = [
      { name: "main", fullName: "refs/heads/main", kind: "branch", target: hashOf("tip"), isHead: true },
      { name: "v1", fullName: "refs/tags/v1", kind: "tag", target: hashOf("base") },
    ];
    expect(renderGraph(pageOf(commits, refs), 0).lines.join("\n")).toMatchInlineSnapshot(`
      "● tip00000 (HEAD -> main) commit tip — Ada, now
      ● base0000 (tag: v1) commit base — Ada, now"
    `);
    const detached = { ...pageOf(commits), head: { detached: true, hash: hashOf("tip") } };
    expect(renderGraph(detached, 0).lines[0]).toContain("(HEAD)");
  });
});
