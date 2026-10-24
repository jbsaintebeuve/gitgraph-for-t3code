import { describe, expect, it } from "vitest";
import { validateRefName } from "./refname.js";

describe("validateRefName", () => {
  it.each(["main", "feature/login", "release-1.2.3", "fix_bug#12", "a/b/c", "v1.0", "ünï", "a@b", "x.y"])("accepts %s", (name) => {
    expect(validateRefName(name)).toBeUndefined();
    expect(validateRefName(name, "tag")).toBeUndefined();
  });

  it.each([
    ["", /required/],
    ["-rf", /start with "-"/],
    ["--force", /start with "-"/],
    ["has space", /spaces/],
    ["tab\there", /spaces/],
    ["a..b", /"\.\."/],
    ["a~1", /"~"/],
    ["a^", /"\^"/],
    ["a:b", /":"/],
    ["a?b", /"\?"/],
    ["a*b", /"\*"/],
    ["a[b", /"\["/],
    ["a\\b", /"\\"/],
    ["a@{b", /"@\{"/],
    ["@", /"@"/],
    ["/a", /"\/"/],
    ["a/", /"\/"/],
    ["a//b", /"\/\/"/],
    ["a.", /end with "\."/],
    [".hidden", /start with "\."/],
    ["a/.b", /start with "\."/],
    ["x.lock", /\.lock/],
    ["a/x.lock/b", /\.lock/],
    ["bell\x07", /control/],
  ])("rejects %j", (name, message) => {
    expect(validateRefName(name)).toMatch(message);
  });

  it("only forbids HEAD for branches", () => {
    expect(validateRefName("HEAD")).toMatch(/HEAD/);
    expect(validateRefName("HEAD", "tag")).toBeUndefined();
  });
});
