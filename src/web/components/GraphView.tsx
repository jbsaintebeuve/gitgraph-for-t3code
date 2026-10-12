import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { type GitRef, type GraphLayout, type WorkingTreeStatus } from "../../shared/types.js";
import { absoluteTime, relativeTime, shortHash, workingTreeLabel } from "../lib/format";
import { groupRefs } from "../lib/refs";
import type { GraphRow } from "../hooks/useGraph";
import { useSessionState } from "../hooks/useSessionState";
import type { ContextTarget } from "./ContextMenu";
import { GraphSvg, LANE_WIDTH, ROW_HEIGHT } from "./GraphSvg";
import { RefBadge } from "./RefBadge";

const HEADER_HEIGHT = 26;
const OVERSCAN = 24;
/** Window start is aligned to this so the SVG is not rebuilt on every scrolled row. */
const CHUNK = 16;
const COMPACT_BELOW = 700;
const MIN_GRAPH = 40;
const LOAD_MORE_DISTANCE = 800;

export interface ScrollRequest {
  hash: string;
  nonce: number;
  /** Centre the row even when already visible. */
  center?: boolean;
}

export interface GraphViewProps {
  rows: GraphRow[];
  layout: GraphLayout;
  indexByHash: Map<string, number>;
  refsByHash: Map<string, GitRef[]>;
  headHash: string | undefined;
  workingTree: WorkingTreeStatus | null;
  selected: string | undefined;
  compare: string | undefined;
  matches: ReadonlySet<string>;
  currentMatch: string | undefined;
  hasMore: boolean;
  loadingMore: boolean;
  scrollRequest: ScrollRequest | undefined;
  onSelect: (hash: string, modifiers: { compare: boolean }) => void;
  onLoadMore: () => void;
  /** Phase 4 hook: right-click on a row (badges call it with kind "ref"). */
  onContextMenu: (target: ContextTarget, event: MouseEvent) => void;
}

export function GraphView(props: GraphViewProps) {
  const {
    rows, layout, indexByHash, refsByHash, headHash, workingTree, selected, compare, matches, currentMatch,
    hasMore, loadingMore, scrollRequest, onSelect, onLoadMore, onContextMenu,
  } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [scrollTop, setScrollTop] = useState(0);
  const [userGraphWidth, setUserGraphWidth] = useSessionState<number | null>("graphWidth", null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const compact = size.width < COMPACT_BELOW;
  const autoGraph = layout.laneCount * LANE_WIDTH + 20;
  const maxGraph = Math.max(MIN_GRAPH, Math.floor(size.width * 0.5));
  const graphWidth = Math.round(
    Math.min(maxGraph, Math.max(MIN_GRAPH, dragWidth ?? userGraphWidth ?? Math.min(autoGraph, 320))),
  );

  // Virtual window.
  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible = Math.ceil((scrollTop + size.height) / ROW_HEIGHT);
  const start = Math.max(0, Math.floor((firstVisible - OVERSCAN) / CHUNK) * CHUNK);
  const end = Math.min(rows.length, Math.ceil((lastVisible + OVERSCAN) / CHUNK) * CHUNK);

  const stashHashes = useMemo(() => {
    const set = new Set<string>();
    for (const [hash, refs] of refsByHash) if (refs.some((r) => r.kind === "stash")) set.add(hash);
    return set;
  }, [refsByHash]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (el.scrollTop + el.clientHeight > el.scrollHeight - LOAD_MORE_DISTANCE) onLoadMore();
  }, [onLoadMore]);

  // Content shorter than the viewport (or still near the bottom after a page arrived): keep loading.
  useEffect(() => {
    const el = scroller.current;
    if (el && hasMore && el.scrollTop + el.clientHeight > el.scrollHeight - LOAD_MORE_DISTANCE) onLoadMore();
  }, [rows.length, hasMore, size.height, onLoadMore]);

  // Programmatic scrolling (keyboard, search, parent links).
  const reveal = useCallback(
    (hash: string, center?: boolean) => {
      const el = scroller.current;
      const index = indexByHash.get(hash);
      if (!el || index === undefined) return;
      const rowTop = index * ROW_HEIGHT; // body coordinates; the sticky header is outside them
      const viewport = el.clientHeight - HEADER_HEIGHT;
      let next = el.scrollTop;
      if (center) next = rowTop - (viewport - ROW_HEIGHT) / 2;
      else if (rowTop < el.scrollTop) next = rowTop;
      else if (rowTop + ROW_HEIGHT > el.scrollTop + viewport) next = rowTop + ROW_HEIGHT - viewport;
      if (next !== el.scrollTop) el.scrollTop = Math.max(0, next);
    },
    [indexByHash],
  );
  useEffect(() => {
    if (scrollRequest) reveal(scrollRequest.hash, scrollRequest.center);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to new requests
  }, [scrollRequest]);
  // The viewport shrank (details panel opened / resized): keep the selected row visible.
  useEffect(() => {
    if (selected) reveal(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the viewport height changes
  }, [size.height]);

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const originX = event.clientX;
    const originWidth = graphWidth;
    const move = (e: globalThis.PointerEvent) => setDragWidth(Math.max(MIN_GRAPH, originWidth + e.clientX - originX));
    const up = (e: globalThis.PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      const finalWidth = Math.min(maxGraph, Math.max(MIN_GRAPH, originWidth + e.clientX - originX));
      setDragWidth(null);
      setUserGraphWidth(finalWidth);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const gridStyle = {
    "--graph-w": `${graphWidth}px`,
    "--row-h": `${ROW_HEIGHT}px`,
  } as CSSProperties;

  const rendered = [];
  for (let i = start; i < end; i++) {
    const row = rows[i]!;
    const layoutRow = layout.rows[i]!;
    const color = layoutRow.color;
    const isSelected = row.hash === selected;
    const classes = ["row"];
    if (isSelected) classes.push("selected");
    if (row.hash === compare) classes.push("compare");
    if (matches.has(row.hash)) classes.push("match");
    if (row.hash === currentMatch) classes.push("match-current");
    if (row.uncommitted) classes.push("uncommitted");

    if (row.uncommitted && workingTree) {
      rendered.push(
        <div
          key={row.hash}
          className={classes.join(" ")}
          style={{ top: i * ROW_HEIGHT }}
          onClick={(e) => onSelect(row.hash, { compare: e.metaKey || e.ctrlKey })}
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu({ kind: "uncommitted" }, e);
          }}
        >
          <div className="cell-graph" />
          <div className="cell-desc">
            <span className="subject uncommitted-label">{workingTreeLabel(workingTree)}</span>
            <span className="wt-counts">
              {[
                workingTree.staged && `${workingTree.staged} staged`,
                workingTree.unstaged && `${workingTree.unstaged} modified`,
                workingTree.untracked && `${workingTree.untracked} untracked`,
                workingTree.conflicted && `${workingTree.conflicted} conflicted`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          {!compact && <div className="cell-date" />}
          {!compact && <div className="cell-author" />}
          <div className="cell-hash mono">*</div>
        </div>,
      );
      continue;
    }

    const commit = row.commit;
    if (!commit) continue;
    const badges = groupRefs(refsByHash.get(row.hash) ?? []);
    rendered.push(
      <div
        key={row.hash}
        className={classes.join(" ")}
        style={{ top: i * ROW_HEIGHT }}
        onClick={(e) => onSelect(row.hash, { compare: e.metaKey || e.ctrlKey })}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu({ kind: "commit", hash: row.hash }, e);
        }}
      >
        <div className="cell-graph" />
        <div className="cell-desc">
          {badges.length > 0 && (
            <span className="badges">
              {badges.map((badge) => (
                <RefBadge key={`${badge.kind}:${badge.name}`} badge={badge} color={color} hash={row.hash} onContextMenu={onContextMenu} />
              ))}
            </span>
          )}
          <span className="subject" title={commit.subject}>
            {commit.subject}
          </span>
        </div>
        {!compact && (
          <div className="cell-date" title={absoluteTime(commit.authorDate)}>
            {relativeTime(commit.authorDate, now)}
          </div>
        )}
        {!compact && (
          <div className="cell-author" title={`${commit.author} <${commit.authorEmail}>`}>
            {commit.author}
          </div>
        )}
        <div className="cell-hash mono" title={commit.hash}>
          {shortHash(commit.hash)}
        </div>
      </div>,
    );
  }

  return (
    <div className={`graph-view${compact ? " compact" : ""}`} style={gridStyle}>
      <div ref={scroller} className="graph-scroll" onScroll={onScroll} role="grid" aria-rowcount={rows.length}>
        <div className="row header" style={{ height: HEADER_HEIGHT }}>
          <div className="cell-graph">
            Graph
            <div className="col-resizer" onPointerDown={startResize} onDoubleClick={() => setUserGraphWidth(null)} title="Drag to resize, double-click to reset" />
          </div>
          <div className="cell-desc">Description</div>
          {!compact && <div className="cell-date">Date</div>}
          {!compact && <div className="cell-author">Author</div>}
          <div className="cell-hash">Commit</div>
        </div>
        <div className="graph-body" style={{ height: rows.length * ROW_HEIGHT }}>
          <GraphSvg
            layout={layout}
            rows={rows}
            start={start}
            end={end}
            width={graphWidth}
            headHash={headHash}
            stashHashes={stashHashes}
          />
          {rendered}
        </div>
      </div>
      {(loadingMore || (hasMore && rows.length > 0)) && (
        <div className="status-pill" role="status">
          {loadingMore ? "Loading more commits…" : "Scroll for more"}
        </div>
      )}
    </div>
  );
}
