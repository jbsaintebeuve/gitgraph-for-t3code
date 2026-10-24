import type { GitRef } from "../../shared/types.js";

export interface RefBadgeInfo {
  kind: "branch" | "remote" | "tag" | "stash";
  /** Label shown in the badge (local branch name, remote ref name, tag, stash). */
  name: string;
  /** Remote refs ("origin/main") folded into a local branch badge. */
  remotes: string[];
  isHead: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  upstreamGone?: boolean;
  /** Underlying refs, for context menus / actions. */
  refs: GitRef[];
}

/** "origin/feature/x" → "feature/x" (remote names cannot contain "/"). */
export function remoteBranchName(remoteRef: string): string {
  const i = remoteRef.indexOf("/");
  return i < 0 ? remoteRef : remoteRef.slice(i + 1);
}

const KIND_ORDER = { branch: 0, remote: 1, tag: 2, stash: 3 } as const;

/**
 * Badges for the refs pointing at one commit. A remote branch is folded into the local
 * branch of the same name (like Git Graph): "main" + "origin/main" → one badge.
 * HEAD branch first, then local branches, remotes, tags, stashes. Symbolic "<remote>/HEAD" is dropped.
 */
export function groupRefs(refs: readonly GitRef[]): RefBadgeInfo[] {
  const badges: RefBadgeInfo[] = [];
  const locals = new Map<string, RefBadgeInfo>();
  for (const ref of refs) {
    if (ref.kind !== "branch") continue;
    const badge: RefBadgeInfo = {
      kind: "branch",
      name: ref.name,
      remotes: [],
      isHead: !!ref.isHead,
      upstream: ref.upstream,
      ahead: ref.ahead,
      behind: ref.behind,
      upstreamGone: ref.upstreamGone,
      refs: [ref],
    };
    locals.set(ref.name, badge);
    badges.push(badge);
  }
  for (const ref of refs) {
    if (ref.kind === "remote") {
      if (ref.name.endsWith("/HEAD")) continue;
      const local = locals.get(remoteBranchName(ref.name));
      if (local) {
        local.remotes.push(ref.name);
        local.refs.push(ref);
      } else {
        badges.push({ kind: "remote", name: ref.name, remotes: [], isHead: false, refs: [ref] });
      }
    } else if (ref.kind === "tag" || ref.kind === "stash") {
      badges.push({ kind: ref.kind, name: ref.name, remotes: [], isHead: false, refs: [ref] });
    }
  }
  return badges
    .map((badge, index) => ({ badge, index }))
    .sort(
      (a, b) =>
        Number(b.badge.isHead) - Number(a.badge.isHead) ||
        KIND_ORDER[a.badge.kind] - KIND_ORDER[b.badge.kind] ||
        a.index - b.index,
    )
    .map((x) => x.badge);
}

/** Index refs by the commit they point to. */
export function refsByCommit(refs: readonly GitRef[]): Map<string, GitRef[]> {
  const map = new Map<string, GitRef[]>();
  for (const ref of refs) {
    const list = map.get(ref.target);
    if (list) list.push(ref);
    else map.set(ref.target, [ref]);
  }
  return map;
}
