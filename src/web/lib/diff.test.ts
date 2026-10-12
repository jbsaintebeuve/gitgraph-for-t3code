import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff.js";
import { buildFileTree } from "./tree.js";

const PATCH = [
  "diff --git a/f.txt b/f.txt",
  "index 111..222 100644",
  "--- a/f.txt",
  "+++ b/f.txt",
  "@@ -1,3 +1,3 @@ fn",
  " keep",
  "-old",
  "+new",
  " tail",
  "@@ -10 +10,2 @@",
  "--- not a header",
  "+++ also content",
  "+x",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("parseDiff", () => {
  const lines = parseDiff(PATCH);
  it("tracks line numbers", () => {
    const body = lines.filter((l) => l.kind !== "meta" && l.kind !== "hunk");
    expect(body[0]).toMatchObject({ kind: "ctx", oldNo: 1, newNo: 1 });
    expect(body[1]).toMatchObject({ kind: "del", text: "old", oldNo: 2 });
    expect(body[2]).toMatchObject({ kind: "add", text: "new", newNo: 2 });
    expect(body[3]).toMatchObject({ kind: "ctx", oldNo: 3, newNo: 3 });
  });
  it("does not treat content starting with --- / +++ as headers inside a hunk", () => {
    expect(lines.find((l) => l.text === "-- not a header")).toMatchObject({ kind: "del", oldNo: 10 });
    expect(lines.find((l) => l.text === "++ also content")).toMatchObject({ kind: "add", newNo: 10 });
  });
  it("keeps meta, hunks and notes", () => {
    expect(lines.filter((l) => l.kind === "meta")).toHaveLength(4);
    expect(lines.filter((l) => l.kind === "hunk")).toHaveLength(2);
    expect(lines.at(-1)?.kind).toBe("note");
  });
  it("handles empty patches", () => expect(parseDiff("")).toEqual([]));
});

describe("buildFileTree", () => {
  it("collapses single-child directories", () => {
    const f = (path: string) => ({ path, status: "M" as const, additions: 1, deletions: 2, binary: false });
    const tree = buildFileTree([f("src/web/a.ts"), f("src/web/b.ts"), f("README.md")]);
    expect(tree.map((n) => n.name)).toEqual(["src/web", "README.md"]);
    expect(tree[0]).toMatchObject({ type: "dir", additions: 2, deletions: 4 });
  });
});
