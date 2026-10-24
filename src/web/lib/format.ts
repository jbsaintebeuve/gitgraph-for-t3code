import type { GitRef } from "../../shared/types.js";

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

/** "just now", "5 min ago", "3 h ago", "2 d ago", "3 w ago", "4 mo ago", "2 y ago". */
export function relativeTime(unixSeconds: number, nowMs: number = Date.now()): string {
  const diff = Math.floor(nowMs / 1000 - unixSeconds);
  if (diff < 45) return "just now";
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / MINUTE))} min ago`;
  if (diff < DAY) return `${Math.round(diff / HOUR)} h ago`;
  if (diff < 14 * DAY) return `${Math.round(diff / DAY)} d ago`;
  if (diff < 60 * DAY) return `${Math.round(diff / (7 * DAY))} w ago`;
  if (diff < 365 * DAY) return `${Math.round(diff / (30 * DAY))} mo ago`;
  return `${Math.round(diff / (365 * DAY))} y ago`;
}

export function absoluteTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

export interface AheadBehind {
  text: string;
  title: string;
}

/** Compact "↑2 ↓1" indicator for a local branch; null when nothing to show. */
export function formatAheadBehind(
  ref: Pick<GitRef, "upstream" | "ahead" | "behind" | "upstreamGone">,
): AheadBehind | null {
  if (ref.upstreamGone) {
    return { text: "gone", title: `Upstream ${ref.upstream ?? ""} no longer exists on the remote`.replace("  ", " ") };
  }
  if (!ref.upstream) return null;
  const ahead = ref.ahead ?? 0;
  const behind = ref.behind ?? 0;
  if (!ahead && !behind) return null;
  const parts: string[] = [];
  const words: string[] = [];
  if (ahead) {
    parts.push(`↑${ahead}`);
    words.push(`${ahead} commit${ahead > 1 ? "s" : ""} ahead`);
  }
  if (behind) {
    parts.push(`↓${behind}`);
    words.push(`${behind} commit${behind > 1 ? "s" : ""} behind`);
  }
  return { text: parts.join(" "), title: `${words.join(", ")} of ${ref.upstream}` };
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function workingTreeLabel(s: { staged: number; unstaged: number; untracked: number; conflicted: number }): string {
  const total = s.staged + s.unstaged + s.untracked + s.conflicted;
  return `Uncommitted changes (${total})`;
}
