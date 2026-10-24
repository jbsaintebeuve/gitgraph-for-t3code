import { describe, expect, it } from "vitest";
import type { GitRef } from "../../shared/types.js";
import { groupRefs, remoteBranchName } from "./refs.js";

const ref = (name: string, kind: GitRef["kind"], extra: Partial<GitRef> = {}): GitRef => ({
  name,
  fullName: `refs/x/${name}`,
  kind,
  target: "a".repeat(40),
  ...extra,
});

describe("groupRefs", () => {
  it("folds origin/main into the local main badge", () => {
    const badges = groupRefs([ref("origin/main", "remote"), ref("main", "branch", { isHead: true })]);
    expect(badges).toHaveLength(1);
    expect(badges[0]).toMatchObject({ kind: "branch", name: "main", remotes: ["origin/main"], isHead: true });
  });

  it("keeps unmatched remotes separate and drops <remote>/HEAD", () => {
    const badges = groupRefs([ref("origin/HEAD", "remote"), ref("origin/dev", "remote"), ref("upstream/main", "remote")]);
    expect(badges.map((b) => b.name)).toEqual(["origin/dev", "upstream/main"]);
  });

  it("folds slashed branch names", () => {
    expect(remoteBranchName("origin/feat/x")).toBe("feat/x");
    const badges = groupRefs([ref("feat/x", "branch"), ref("origin/feat/x", "remote")]);
    expect(badges).toHaveLength(1);
  });

  it("orders HEAD, branches, remotes, tags, stashes", () => {
    const badges = groupRefs([
      ref("stash@{0}", "stash"),
      ref("v1", "tag"),
      ref("origin/x", "remote"),
      ref("b", "branch"),
      ref("h", "branch", { isHead: true }),
    ]);
    expect(badges.map((b) => b.name)).toEqual(["h", "b", "origin/x", "v1", "stash@{0}"]);
  });
});
