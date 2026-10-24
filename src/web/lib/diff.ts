export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "ctx" | "note";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line text without the leading +/-/space marker (hunk/meta: full line). */
  text: string;
  oldNo?: number;
  newNo?: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses a single-file unified diff. Hunk line counts are honoured so that content lines
 * starting with "--- " / "+++ " inside a hunk are not mistaken for file headers.
 */
export function parseDiff(patch: string): DiffLine[] {
  if (patch === "") return [];
  const raw = patch.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of raw) {
    if (oldLeft > 0 || newLeft > 0) {
      const marker = line[0];
      if (marker === "\\") {
        lines.push({ kind: "note", text: line });
        continue;
      }
      if (marker === "+") {
        lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
        newLeft--;
        continue;
      }
      if (marker === "-") {
        lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
        oldLeft--;
        continue;
      }
      if (marker === " " || line === "") {
        lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      lines.push({ kind: "hunk", text: line });
    } else if (line.startsWith("\\")) {
      lines.push({ kind: "note", text: line });
    } else {
      lines.push({ kind: "meta", text: line });
    }
  }
  return lines;
}

const HIDDEN_META = /^(diff --git |index |--- |\+\+\+ )/;

/** Meta lines worth showing (rename, mode change, binary…); plumbing headers are hidden. */
export function isVisibleMeta(line: DiffLine): boolean {
  return line.kind !== "meta" || !HIDDEN_META.test(line.text);
}
