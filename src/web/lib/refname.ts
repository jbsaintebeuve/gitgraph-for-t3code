/**
 * Client-side mirror of the basic `git check-ref-format` rules, for instant feedback in dialogs.
 * The server always re-validates with git itself, so this only needs to catch the common mistakes.
 * Returns a human-readable problem, or undefined when the name looks valid.
 */
export function validateRefName(name: string, kind: "branch" | "tag" = "branch"): string | undefined {
  const label = kind === "tag" ? "Tag name" : "Branch name";
  if (name === "") return `${label} is required.`;
  if (name === "@") return `${label} cannot be "@".`;
  if (kind === "branch" && name === "HEAD") return `${label} cannot be "HEAD".`;
  if (name.startsWith("-")) return `${label} cannot start with "-".`;
  if (/\s/.test(name)) return `${label} cannot contain spaces.`;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return `${label} cannot contain control characters.`;
  const forbidden = name.match(/[~^:?*[\\]/);
  if (forbidden) return `${label} cannot contain "${forbidden[0]}".`;
  if (name.includes("..")) return `${label} cannot contain "..".`;
  if (name.includes("@{")) return `${label} cannot contain "@{".`;
  if (name.startsWith("/") || name.endsWith("/")) return `${label} cannot start or end with "/".`;
  if (name.includes("//")) return `${label} cannot contain "//".`;
  if (name.endsWith(".")) return `${label} cannot end with ".".`;
  for (const part of name.split("/")) {
    if (part.startsWith(".")) return `Path components cannot start with ".".`;
    if (part.endsWith(".lock")) return `Path components cannot end with ".lock".`;
  }
  return undefined;
}
