/**
 * Commit graph layout ("straight branches" style).
 *
 * Original implementation, inspired by the publicly described approaches in
 * Pierre Vigier, "Commit graph drawing algorithms"
 * (https://pvigier.github.io/2019/05/06/commit-graph-drawing-algorithms.html)
 * and DoltHub's commit-graph write-up. No code from other Git graph tools was used.
 *
 * Algorithm: a single top-to-bottom sweep over the rows keeping a list of active lanes.
 * Each active lane "waits" for one parent hash and carries the edges heading to it.
 *  - A commit takes the lowest lane waiting for it (branch continues straight); if none
 *    waits, it opens the lowest free lane (new branch tip, new colour).
 *  - Other lanes waiting for the same commit converge into the commit's lane and are freed.
 *  - The first parent continues in the commit's lane (same colour); each merge parent joins
 *    the lane already waiting for it, or opens the lowest free lane (new colour).
 *  - Lanes still active after the last row stand for parents outside the loaded window:
 *    their edges end at row === rows.length.
 *  - A `pseudo` node (uncommitted changes) never advances the colour counter: its lane is
 *    uncoloured until its parent is reached, and the parent picks the colour it would have
 *    had without the pseudo row. The pseudo row and its edge then take the parent's colour.
 *    Colours of all real rows are therefore independent of the pseudo row's presence.
 * Cost: O(rows x activeLanes). Pure TS, no dependencies.
 */
import type { GraphLayout, LayoutEdge, LayoutNode, LayoutRow } from "./types.js";

/** Colour of a pseudo row's lane until its parent is placed (resolved after the sweep). */
const UNSET = -1;

export function computeLayout(nodes: LayoutNode[]): GraphLayout {
  const rows: LayoutRow[] = new Array(nodes.length);
  const edges: LayoutEdge[] = [];
  const pseudoEdges: LayoutEdge[] = [];
  const rowOf = new Map<string, number>();
  nodes.forEach((node, r) => rowOf.set(node.hash, r));

  // Per-lane state: hash awaited (null = free), colour, and edges currently running in it.
  const target: (string | null)[] = [];
  const laneColor: number[] = [];
  // Age rank of each lane's line (creation order, inherited when a line continues). Colours are
  // picked by rank, never by lane index, so they do not depend on where lanes happen to sit.
  const laneRank: number[] = [];
  const laneEdges: LayoutEdge[][] = [];
  let nextColor = 0;
  let nextRank = 0;
  let laneCount = 0;

  const freeLane = (): number => {
    for (let i = 0; i < target.length; i++) if (target[i] === null) return i;
    target.push(null);
    laneColor.push(0);
    laneRank.push(UNSET);
    laneEdges.push([]);
    return target.length - 1;
  };

  for (let r = 0; r < nodes.length; r++) {
    const { hash, parents, pseudo } = nodes[r]!;

    // 1. Lane of the dot: lowest lane waiting for this commit, else a fresh lane.
    let lane = -1;
    let color = UNSET;
    let rank = UNSET;
    for (let l = 0; l < target.length; l++) {
      if (target[l] !== hash) continue;
      if (lane < 0) lane = l;
      // Colour of the oldest waiting line that has one (a pseudo row's lane has none yet).
      if (laneColor[l] !== UNSET && (rank === UNSET || laneRank[l]! < rank)) {
        color = laneColor[l]!;
        rank = laneRank[l]!;
      }
    }
    if (lane < 0) lane = freeLane();
    if (color === UNSET && !pseudo) {
      color = nextColor++;
      rank = nextRank++;
    }

    // 2. Advance every running edge by one row; converging edges end on the dot.
    for (let l = 0; l < target.length; l++) {
      const t = target[l];
      if (t === null) continue;
      const list = laneEdges[l]!;
      if (t === hash) {
        for (const e of list) e.points.push({ row: r, lane });
        list.length = 0;
        target[l] = null;
      } else {
        for (const e of list) e.points.push({ row: r, lane: l });
      }
    }

    rows[r] = { hash, lane, color };
    if (lane + 1 > laneCount) laneCount = lane + 1;

    // 3. Start the edges towards the parents.
    let placedFirst = false;
    for (let i = 0; i < parents.length; i++) {
      const p = parents[i]!;
      if (p === hash || parents.indexOf(p) < i) continue; // self / duplicate (malformed input)
      let l: number;
      let edgeColor: number;
      if (!placedFirst) {
        l = lane;
        target[l] = p;
        laneColor[l] = color;
        laneRank[l] = rank;
        edgeColor = color;
        placedFirst = true;
      } else {
        l = -1;
        for (let k = 0; k < target.length; k++) {
          if (target[k] === p && laneColor[k] !== UNSET && (l < 0 || laneRank[k]! < laneRank[l]!)) l = k;
        }
        if (l < 0) {
          l = freeLane();
          target[l] = p;
          laneColor[l] = pseudo ? UNSET : nextColor++;
          laneRank[l] = pseudo ? UNSET : nextRank++;
        }
        edgeColor = laneColor[l]!;
      }
      const edge: LayoutEdge = {
        from: hash,
        to: p,
        color: edgeColor,
        points: [{ row: r, lane }],
        merge: i > 0,
      };
      edges.push(edge);
      if (pseudo) pseudoEdges.push(edge);
      laneEdges[l]!.push(edge);
      if (l + 1 > laneCount) laneCount = l + 1;
    }
  }

  // Pseudo rows take the colour of their first parent (colour 0 when it is not loaded).
  nodes.forEach((node, r) => {
    if (!node.pseudo) return;
    const parentRow = node.parents[0] === undefined ? undefined : rowOf.get(node.parents[0]);
    const color = parentRow === undefined ? 0 : rows[parentRow]!.color;
    rows[r]!.color = color;
  });
  for (const e of pseudoEdges) e.color = rows[rowOf.get(e.from)!]!.color;

  // 4. Edges whose parent was not loaded run off the bottom of the window.
  for (let l = 0; l < target.length; l++) {
    if (target[l] === null) continue;
    for (const e of laneEdges[l]!) e.points.push({ row: nodes.length, lane: l });
  }

  return { rows, edges, laneCount };
}
