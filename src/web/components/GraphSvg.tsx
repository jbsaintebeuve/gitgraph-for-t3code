import { memo, useMemo } from "react";
import { UNCOMMITTED_HASH, type GraphLayout, type LayoutEdge } from "../../shared/types.js";
import { laneColor } from "../lib/colors";
import type { GraphRow } from "../hooks/useGraph";

export const ROW_HEIGHT = 24;
export const LANE_WIDTH = 16;
const PAD_LEFT = 10;

const laneX = (lane: number) => PAD_LEFT + lane * LANE_WIDTH;

/**
 * SVG path of an edge restricted to rows [start, end) (plus one row of overshoot so lines
 * enter/leave the window seamlessly). Lane changes are drawn as a cubic S-curve spanning
 * the row between the two points. Returns null when the edge is outside the window.
 */
export function edgePath(edge: LayoutEdge, start: number, end: number, rowCount: number): string | null {
  const pts = edge.points;
  const first = pts[0]!.row;
  const last = pts[pts.length - 1]!.row;
  if (last < start || first >= end) return null;
  const i0 = Math.max(0, start - 1 - first);
  const i1 = Math.min(pts.length - 1, end - first);
  // The virtual point (row === rowCount) stands for "continues below": run to the bottom edge of the last row.
  const yOf = (row: number) => (row >= rowCount ? (row - start) * ROW_HEIGHT : (row - start + 0.5) * ROW_HEIGHT);
  let d = "";
  for (let i = i0; i <= i1; i++) {
    const p = pts[i]!;
    const x = laneX(p.lane);
    const y = yOf(p.row);
    if (i === i0) {
      d += `M${x} ${y}`;
      continue;
    }
    const prev = pts[i - 1]!;
    if (prev.lane === p.lane) {
      const next = pts[i + 1];
      if (i < i1 && next && next.lane === p.lane) continue; // collinear: extend the line lazily
      d += `L${x} ${y}`;
    } else {
      const x0 = laneX(prev.lane);
      const y0 = yOf(prev.row);
      const mid = (y0 + y) / 2;
      d += `C${x0} ${mid} ${x} ${mid} ${x} ${y}`;
    }
  }
  return d;
}

export interface GraphSvgProps {
  layout: GraphLayout;
  rows: GraphRow[];
  /** First rendered row (inclusive) and last (exclusive). */
  start: number;
  end: number;
  width: number;
  headHash: string | undefined;
  stashHashes: ReadonlySet<string>;
}

/** One SVG for the whole rendered window: lanes, curves and commit dots. */
export const GraphSvg = memo(function GraphSvg({ layout, rows, start, end, width, headHash, stashHashes }: GraphSvgProps) {
  const paths = useMemo(() => {
    const out: { key: string; d: string; color: number; dashed: boolean }[] = [];
    for (const edge of layout.edges) {
      const d = edgePath(edge, start, end, rows.length);
      if (d) out.push({ key: `${edge.from}>${edge.to}`, d, color: edge.color, dashed: edge.from === UNCOMMITTED_HASH });
    }
    return out;
  }, [layout, rows.length, start, end]);

  const height = (end - start) * ROW_HEIGHT;
  const dots = [];
  for (let r = start; r < end; r++) {
    const row = layout.rows[r];
    const item = rows[r];
    if (!row || !item) continue;
    const cx = laneX(row.lane);
    const cy = (r - start + 0.5) * ROW_HEIGHT;
    const color = laneColor(row.color);
    if (item.uncommitted) {
      dots.push(
        <circle key={item.hash} cx={cx} cy={cy} r={4.5} className="dot-uncommitted" />,
      );
      continue;
    }
    const isHead = item.hash === headHash;
    if (isHead) dots.push(<circle key={`${item.hash}-h`} cx={cx} cy={cy} r={7} className="dot-head-ring" />);
    if (stashHashes.has(item.hash)) {
      dots.push(
        <rect key={item.hash} x={cx - 4} y={cy - 4} width={8} height={8} rx={1.5} className="dot-stash" style={{ fill: color }} />,
      );
    } else if (item.parents.length > 1) {
      dots.push(<circle key={item.hash} cx={cx} cy={cy} r={4} className="dot-merge" style={{ stroke: color }} />);
    } else {
      dots.push(<circle key={item.hash} cx={cx} cy={cy} r={4} className="dot" style={{ fill: color }} />);
    }
  }

  return (
    <svg
      className="graph-svg"
      width={width}
      height={height}
      style={{ top: start * ROW_HEIGHT }}
      aria-hidden="true"
    >
      <g fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {paths.map((p) => (
          <path
            key={p.key}
            d={p.d}
            style={{ stroke: p.dashed ? "var(--muted)" : laneColor(p.color) }}
            strokeDasharray={p.dashed ? "3 3" : undefined}
          />
        ))}
      </g>
      {dots}
    </svg>
  );
});
