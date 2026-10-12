import { describe, expect, it } from "vitest";
import { laneColor } from "./colors.js";
import { formatAheadBehind, relativeTime, shortHash } from "./format.js";

describe("formatAheadBehind", () => {
  it("formats ahead/behind", () => {
    expect(formatAheadBehind({ upstream: "origin/main", ahead: 2, behind: 1 })?.text).toBe("↑2 ↓1");
    expect(formatAheadBehind({ upstream: "origin/main", ahead: 0, behind: 3 })?.text).toBe("↓3");
  });
  it("returns null when in sync or without upstream", () => {
    expect(formatAheadBehind({ upstream: "origin/main", ahead: 0, behind: 0 })).toBeNull();
    expect(formatAheadBehind({})).toBeNull();
  });
  it("marks gone upstreams", () => {
    expect(formatAheadBehind({ upstream: "origin/x", upstreamGone: true })?.text).toBe("gone");
  });
});

describe("relativeTime", () => {
  const now = 1_700_000_000_000;
  const ago = (s: number) => relativeTime(now / 1000 - s, now);
  it("scales units", () => {
    expect(ago(10)).toBe("just now");
    expect(ago(300)).toBe("5 min ago");
    expect(ago(3 * 3600)).toBe("3 h ago");
    expect(ago(2 * 86400)).toBe("2 d ago");
    expect(ago(21 * 86400)).toBe("3 w ago");
    expect(ago(120 * 86400)).toBe("4 mo ago");
    expect(ago(800 * 86400)).toBe("2 y ago");
  });
  it("shortens hashes", () => expect(shortHash("0123456789")).toBe("0123456"));
});

describe("laneColor", () => {
  it("wraps around the palette", () => {
    expect(laneColor(0)).toBe("var(--lane-0)");
    expect(laneColor(13)).toBe("var(--lane-3)");
    expect(laneColor(-1)).toBe("var(--lane-9)");
  });
});
