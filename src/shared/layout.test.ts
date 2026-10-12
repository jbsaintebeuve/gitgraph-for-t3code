import { describe, expect, it } from "vitest";
import { computeLayout } from "./layout.js";
import type { GraphLayout, LayoutNode } from "./types.js";

/** "M: B F2" -> { hash: "M", parents: ["B", "F2"] } */
function parse(lines: string[]): LayoutNode[] {
  return lines.map((line) => {
    const [h, rest = ""] = line.split(":");
    return { hash: h!.trim(), parents: rest.split(/\s+/).filter(Boolean) };
  });
}

/** Debug renderer: one line per row, one cell per lane ("●" dot, "│" line passing), then the hash. */
function ascii(nodes: LayoutNode[], layout: GraphLayout): string {
  const lines = layout.rows.map((row, r) => {
    const cells: string[] = new Array(layout.laneCount).fill(" ");
    for (const e of layout.edges) {
      for (const p of e.points) if (p.row === r) cells[p.lane] = "│";
    }
    cells[row.lane] = "●";
    return `${cells.join(" ")}  ${row.hash}`;
  });
  return "\n" + lines.join("\n") + "\n";
}

function check(nodes: LayoutNode[], layout: GraphLayout): void {
  const n = nodes.length;
  const { rows, edges, laneCount } = layout;
  expect(rows.length).toBe(n);
  const rowOf = new Map<string, number>();
  rows.forEach((r, i) => {
    expect(r.hash).toBe(nodes[i]!.hash);
    expect(r.lane).toBeGreaterThanOrEqual(0);
    expect(r.lane).toBeLessThan(laneCount);
    expect(Number.isInteger(r.color) && r.color >= 0).toBe(true);
    rowOf.set(r.hash, i);
  });

  // One edge per (commit, distinct parent).
  let expected = 0;
  nodes.forEach((nd) => (expected += new Set(nd.parents).size));
  expect(edges.length).toBe(expected);

  // interior[row] : lane -> destination hash
  const interior = new Map<number, Map<number, string>>();
  for (const e of edges) {
    const from = rowOf.get(e.from)!;
    const to = rowOf.get(e.to);
    const end = to ?? n;
    expect(end).toBeGreaterThan(from);
    expect(e.points.length).toBe(end - from + 1);
    e.points.forEach((p, k) => {
      expect(p.row).toBe(from + k);
      expect(p.lane).toBeGreaterThanOrEqual(0);
      expect(p.lane).toBeLessThan(laneCount);
    });
    expect(e.points[0]!.lane).toBe(rows[from]!.lane);
    if (to !== undefined) expect(e.points[e.points.length - 1]!.lane).toBe(rows[to]!.lane);
    for (let k = 1; k < e.points.length - 1; k++) {
      const p = e.points[k]!;
      // never through another commit's dot
      expect(rows[p.row]!.lane === p.lane).toBe(false);
      let m = interior.get(p.row);
      if (!m) interior.set(p.row, (m = new Map()));
      const prev = m.get(p.lane);
      if (prev !== undefined) expect(prev).toBe(e.to);
      m.set(p.lane, e.to);
    }
  }
}

describe("computeLayout", () => {
  it("handles empty input", () => {
    expect(computeLayout([])).toEqual({ rows: [], edges: [], laneCount: 0 });
  });

  it("linear history stays in lane 0 with one colour", () => {
    const nodes = parse(["c4: c3", "c3: c2", "c2: c1", "c1: c0", "c0:"]);
    const l = computeLayout(nodes);
    check(nodes, l);
    expect(l.laneCount).toBe(1);
    expect(new Set(l.rows.map((r) => r.lane))).toEqual(new Set([0]));
    expect(new Set(l.rows.map((r) => r.color)).size).toBe(1);
    expect(ascii(nodes, l)).toMatchInlineSnapshot(`
      "
      ●  c4
      ●  c3
      ●  c2
      ●  c1
      ●  c0
      "
    `);
  });

  it("feature branch merged back", () => {
    const nodes = parse(["M: B F2", "F2: F1", "F1: A", "B: A", "A: R", "R:"]);
    const l = computeLayout(nodes);
    check(nodes, l);
    const lane = (h: string) => l.rows.find((r) => r.hash === h)!.lane;
    expect(lane("M")).toBe(0);
    expect(lane("F1")).toBe(1);
    expect(lane("F2")).toBe(1);
    expect(lane("A")).toBe(0);
    expect(l.edges.find((e) => e.to === "F2")!.merge).toBe(true);
    expect(ascii(nodes, l)).toMatchInlineSnapshot(`
      "
      ●    M
      │ ●  F2
      │ ●  F1
      ● │  B
      ●    A
      ●    R
      "
    `);
  });

  it("criss-cross merges", () => {
    const nodes = parse(["A2: A1 B1", "B2: B1 A1", "A1: R", "B1: R", "R:"]);
    const l = computeLayout(nodes);
    check(nodes, l);
    expect(ascii(nodes, l)).toMatchInlineSnapshot(`
      "
      ●      A2
      │ │ ●  B2
      ● │ │  A1
      │ ●    B1
      ●      R
      "
    `);
  });

  it("octopus merge", () => {
    const nodes = parse(["O: P1 P2 P3 P4", "P1: R", "P2: R", "P3: R", "P4: R", "R:"]);
    const l = computeLayout(nodes);
    check(nodes, l);
    expect(new Set(["P1", "P2", "P3", "P4"].map((h) => l.rows.find((r) => r.hash === h)!.lane)).size).toBe(4);
    expect(ascii(nodes, l)).toMatchInlineSnapshot(`
      "
      ●        O
      ● │ │ │  P1
      │ ● │ │  P2
      │ │ ● │  P3
      │ │ │ ●  P4
      ●        R
      "
    `);
  });

  it("multiple roots", () => {
    const nodes = parse(["a2: a1", "b2: b1", "a1: a0", "b1: b0", "a0:", "b0:", "z:"]);
    const l = computeLayout(nodes);
    check(nodes, l);
    expect(l.laneCount).toBe(2);
  });

  it("missing parents run to rows.length", () => {
    const nodes = parse(["m: x y", "c: x", "d: gone"]);
    const l = computeLayout(nodes);
    check(nodes, l);
    const open = l.edges.filter((e) => e.points[e.points.length - 1]!.row === nodes.length);
    expect(open.length).toBe(4);
  });

  it("branch tip appearing later (no child above)", () => {
    const nodes = parse(["m3: m2", "m2: m1", "tip: m1", "m1: m0", "m0:"]);
    const l = computeLayout(nodes);
    check(nodes, l);
    expect(l.rows[2]!.lane).toBe(1);
    expect(l.rows[3]!.lane).toBe(0);
  });

  it("ignores duplicate parents, self-parents and does not loop on cycles", () => {
    const nodes = parse(["a: b b", "b: a c", "c: c"]);
    const l = computeLayout(nodes);
    expect(l.edges.filter((e) => e.from === "a").length).toBe(1);
    expect(l.rows.length).toBe(3);
  });

  it("keeps a long-lived branch in a constant lane", () => {
    const nodes: LayoutNode[] = [{ hash: "merge", parents: ["m0", "f0"] }];
    const N = 100;
    for (let i = 0; i < N; i++) {
      nodes.push({ hash: `f${i}`, parents: [i === N - 1 ? "base" : `f${i + 1}`] });
      nodes.push({ hash: `m${i}`, parents: [i === N - 1 ? "base" : `m${i + 1}`] });
    }
    nodes.push({ hash: "base", parents: [] });
    const l = computeLayout(nodes);
    check(nodes, l);
    const lanes = new Set(l.rows.filter((r) => r.hash.startsWith("f")).map((r) => r.lane));
    expect(lanes.size).toBe(1);
    expect(new Set(l.rows.filter((r) => r.hash.startsWith("m")).map((r) => r.lane))).toEqual(new Set([0]));
    expect(l.laneCount).toBe(2);
  });

  it("reuses lanes after a branch ends (20 sequential feature branches)", () => {
    const nodes: LayoutNode[] = [];
    const K = 20;
    for (let k = K; k >= 1; k--) {
      nodes.push({ hash: `M${k}`, parents: [`B${k}`, `F${k}`] });
      nodes.push({ hash: `F${k}`, parents: [`B${k}`] });
      nodes.push({ hash: `B${k}`, parents: [k === 1 ? "root" : `M${k - 1}`] });
    }
    nodes.push({ hash: "root", parents: [] });
    const l = computeLayout(nodes);
    check(nodes, l);
    expect(l.laneCount).toBeLessThanOrEqual(3);
    expect(ascii(nodes.slice(0, 9), computeLayout(nodes.slice(0, 9)))).toMatchInlineSnapshot(`
      "
      ●    M20
      │ ●  F20
      ●    B20
      ●    M19
      │ ●  F19
      ●    B19
      ●    M18
      │ ●  F18
      ●    B18
      "
    `);
  });

  it("random histories satisfy the invariants", () => {
    const nodes = synthetic(3000, 7);
    check(nodes, computeLayout(nodes));
    // pagination window: drop the tail so many parents are missing
    const cut = nodes.slice(0, 1500);
    check(cut, computeLayout(cut));
  });

  describe("pseudo row (uncommitted changes)", () => {
    const colorsOf = (layout: GraphLayout) => ({
      rows: layout.rows.map((r) => r.color),
      edges: layout.edges.map((e) => `${e.from}>${e.to}:${e.color}`),
    });

    it("does not consume a palette colour: real rows keep their colours", () => {
      const nodes = parse(["T: A", "H: A", "A:"]);
      const without = computeLayout(nodes);
      const withPseudo = computeLayout([{ hash: "__wt__", parents: ["H"], pseudo: true }, ...nodes]);
      expect(withPseudo.rows.slice(1).map((r) => r.color)).toEqual(without.rows.map((r) => r.color));
      // the pseudo row and its edge reuse HEAD's colour
      const head = withPseudo.rows.find((r) => r.hash === "H")!;
      expect(withPseudo.rows[0]!.color).toBe(head.color);
      expect(withPseudo.edges.find((e) => e.from === "__wt__")!.color).toBe(head.color);
    });

    it("keeps colours of every real row and edge stable on random histories", () => {
      for (let seed = 1; seed <= 25; seed++) {
        const nodes = synthetic(150, seed);
        const headIndex = seed % 7; // HEAD is not always the first row
        const head = nodes[headIndex]!.hash;
        const without = computeLayout(nodes);
        const withPseudo = computeLayout([{ hash: "__wt__", parents: [head], pseudo: true }, ...nodes]);
        expect(withPseudo.rows.slice(1).map((r) => r.color), `seed ${seed}`).toEqual(without.rows.map((r) => r.color));
        expect(colorsOf(withPseudo).edges.filter((e) => !e.startsWith("__wt__")), `seed ${seed}`).toEqual(colorsOf(without).edges);
        expect(withPseudo.rows[0]!.color).toBe(withPseudo.rows[headIndex + 1]!.color);
        check([{ hash: "__wt__", parents: [head] }, ...nodes], withPseudo);
      }
    });

    it("an unloaded HEAD gives the pseudo row colour 0 and consumes nothing", () => {
      const nodes = parse(["B: A", "A:"]);
      const withPseudo = computeLayout([{ hash: "__wt__", parents: ["Z"], pseudo: true }, ...nodes]);
      expect(withPseudo.rows[0]!.color).toBe(0);
      expect(withPseudo.rows.slice(1).map((r) => r.color)).toEqual(computeLayout(nodes).rows.map((r) => r.color));
    });

    it("works alone (empty repository with changes)", () => {
      const layout = computeLayout([{ hash: "__wt__", parents: [], pseudo: true }]);
      expect(layout.rows[0]).toEqual({ hash: "__wt__", lane: 0, color: 0 });
    });
  });

  it("lays out 50k commits quickly", () => {
    const nodes = synthetic(50_000, 42);
    const t0 = performance.now();
    const l = computeLayout(nodes);
    const ms = performance.now() - t0;
    console.log(`computeLayout 50k commits: ${ms.toFixed(0)} ms, laneCount=${l.laneCount}, edges=${l.edges.length}`);
    expect(l.rows.length).toBe(50_000);
    expect(ms).toBeLessThan(1500);
  });
});

/** Deterministic synthetic history (many branches and merges), returned newest first. */
function synthetic(count: number, seed: number): LayoutNode[] {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const out: LayoutNode[] = [{ hash: "c0", parents: [] }];
  const heads: string[] = ["c0"];
  for (let i = 1; i < count; i++) {
    const hash = `c${i}`;
    const x = rnd();
    const h = Math.floor(rnd() * heads.length);
    if (x < 0.15 && heads.length < 30) {
      out.push({ hash, parents: [heads[h]!] });
      heads.push(hash); // fork: new branch from an existing tip
    } else if (x < 0.3 && heads.length > 1) {
      let o = Math.floor(rnd() * heads.length);
      if (o === h) o = (o + 1) % heads.length;
      const parents = [heads[h]!, heads[o]!];
      if (rnd() < 0.1 && heads.length > 2) {
        const third = heads.find((_, k) => k !== h && k !== o)!;
        parents.push(third);
      }
      out.push({ hash, parents });
      heads[h] = hash;
      heads.splice(heads.indexOf(heads[o]!), heads[o] === hash ? 0 : 1);
    } else {
      out.push({ hash, parents: [heads[h]!] });
      heads[h] = hash;
    }
  }
  return out.reverse();
}
