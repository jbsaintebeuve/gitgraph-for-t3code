import type { CSSProperties, MouseEvent } from "react";
import { laneColor } from "../lib/colors";
import { formatAheadBehind } from "../lib/format";
import type { RefBadgeInfo } from "../lib/refs";
import type { ContextTarget } from "./ContextMenu";

export interface RefBadgeProps {
  badge: RefBadgeInfo;
  /** Lane colour index of the commit the badge sits on. */
  color: number;
  hash: string;
  /** Phase 4 hook: right-click on a badge. */
  onContextMenu?: (target: ContextTarget, event: MouseEvent) => void;
}

const TagIcon = () => (
  <svg className="badge-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
    <path d="M1.5 2.5v5.2l6.8 6.8 5.2-5.2-6.8-6.8z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    <circle cx="5" cy="5.5" r="1.1" fill="currentColor" />
  </svg>
);

const StashIcon = () => (
  <svg className="badge-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
    <path d="M2 9l2-5h8l2 5v4H2zM2 9h4l1 1.5h2L10 9h4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
);

export function RefBadge({ badge, color, hash, onContextMenu }: RefBadgeProps) {
  const ab = badge.kind === "branch" ? formatAheadBehind(badge) : null;
  const title = [
    badge.kind === "branch" ? `Branch ${badge.name}${badge.isHead ? " (checked out)" : ""}` : `${badge.kind} ${badge.name}`,
    ...badge.remotes.map((r) => `also at ${r}`),
    ab?.title,
  ]
    .filter(Boolean)
    .join("\n");
  const remoteLabel = badge.remotes.map((r) => r.slice(0, r.indexOf("/"))).join(", ");
  return (
    <span
      className={`badge badge-${badge.kind}${badge.isHead ? " badge-head" : ""}`}
      style={{ "--badge-color": laneColor(color) } as CSSProperties}
      title={title}
      onContextMenu={
        onContextMenu
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              onContextMenu({ kind: "ref", hash, badge }, event);
            }
          : undefined
      }
    >
      {badge.kind === "tag" && <TagIcon />}
      {badge.kind === "stash" && <StashIcon />}
      {badge.isHead && <span className="badge-head-dot" aria-label="HEAD" />}
      <span className="badge-name">{badge.name}</span>
      {remoteLabel && <span className="badge-remote">{remoteLabel}</span>}
      {ab && <span className={`badge-ab${badge.upstreamGone ? " badge-gone" : ""}`}>{ab.text}</span>}
    </span>
  );
}
