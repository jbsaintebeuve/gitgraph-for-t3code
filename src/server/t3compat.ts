/**
 * Compatibility probe against the installed T3 Code build.
 *
 * gitgraph relies on two `t3.json` script fields: `previewUrl` (where the Preview panel points)
 * and `autoOpenPreview` (open it when the script starts). T3 Code ships nightly and nothing
 * guarantees these fields survive, so we check two sources:
 *   - the installed app bundle (app.asar, read-only, no Electron needed): does its web client
 *     still reference these fields?
 *   - the public JSON schema (https://t3.codes/schema/t3.json): used by the daily CI job.
 */
import { open, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const T3_SCHEMA_URL = "https://t3.codes/schema/t3.json";
export const REQUIRED_SCRIPT_FIELDS = ["previewUrl", "autoOpenPreview"] as const;
export type ScriptField = (typeof REQUIRED_SCRIPT_FIELDS)[number];

/** Directory, inside app.asar, of the web client bundle that renders project scripts. */
const CLIENT_ASSETS_DIR = "apps/server/dist/client/assets";

/* ------------------------------------------------------------------ asar */

interface AsarEntry {
  files?: Record<string, AsarEntry>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
}

export interface AsarArchive {
  /** Every regular file stored in the archive (unpacked files excluded), "a/b/c.js" style. */
  files: string[];
  read(path: string): Promise<Buffer>;
  close(): Promise<void>;
}

/**
 * Minimal read-only asar reader. Layout: a Chromium "pickle" holding the header size, then a
 * pickle holding the JSON header (uint32 payload size, uint32 string length, string), then the
 * concatenated file contents. File offsets are relative to the end of the header pickle.
 */
export async function openAsar(path: string): Promise<AsarArchive> {
  const handle = await open(path, "r");
  try {
    const prefix = Buffer.alloc(16);
    await handle.read(prefix, 0, 16, 0);
    const headerPickleSize = prefix.readUInt32LE(4);
    const jsonLength = prefix.readUInt32LE(12);
    if (prefix.readUInt32LE(0) !== 4 || jsonLength === 0 || jsonLength > headerPickleSize) {
      throw new Error(`${path} is not an asar archive`);
    }
    const json = Buffer.alloc(jsonLength);
    await handle.read(json, 0, jsonLength, 16);
    const root = JSON.parse(json.toString("utf8")) as AsarEntry;
    const base = 8 + headerPickleSize;

    const entries = new Map<string, AsarEntry>();
    const walk = (node: AsarEntry, prefixPath: string) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const childPath = prefixPath ? `${prefixPath}/${name}` : name;
        if (child.files) walk(child, childPath);
        else if (!child.unpacked && child.offset !== undefined && child.size !== undefined) entries.set(childPath, child);
      }
    };
    walk(root, "");

    return {
      files: [...entries.keys()],
      async read(file) {
        const entry = entries.get(file);
        if (!entry) throw new Error(`${file} not found in ${path}`);
        const buffer = Buffer.alloc(entry.size ?? 0);
        await handle.read(buffer, 0, buffer.length, base + Number(entry.offset));
        return buffer;
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/* --------------------------------------------------------------- bundles */

/** Pulls the app.asar path out of the `~/.t3/bin/t3` launcher T3 Code writes on first start. */
export function asarPathFromLauncher(script: string): string | undefined {
  const match = /'([^']*app\.asar)\//.exec(script) ?? /"([^"]*app\.asar)\//.exec(script);
  return match?.[1];
}

async function globApps(dir: string, suffix: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => /^T3 Code/i.test(name)).map((name) => join(dir, name, suffix));
  } catch {
    return [];
  }
}

/**
 * Candidate app.asar paths, most reliable first. `GITGRAPH_T3_ASAR` overrides everything.
 * On Linux the AppImage is only mounted while T3 Code runs, so the launcher path may be stale:
 * that is why missing bundles are reported as "not found", never as incompatible.
 */
export async function findT3Bundles(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if (env.GITGRAPH_T3_ASAR) return [env.GITGRAPH_T3_ASAR];
  const candidates: string[] = [];
  const t3Home = env.T3CODE_HOME ?? join(homedir(), ".t3");
  try {
    const fromLauncher = asarPathFromLauncher(await readFile(join(t3Home, "bin", "t3"), "utf8"));
    if (fromLauncher) candidates.push(fromLauncher);
  } catch {
    // launcher absent: T3 Code never started on this machine, or another layout
  }
  if (process.platform === "darwin") {
    const suffix = "Contents/Resources/app.asar";
    candidates.push(...(await globApps("/Applications", suffix)), ...(await globApps(join(homedir(), "Applications"), suffix)));
  } else if (process.platform === "linux") {
    candidates.push(...(await globApps("/opt", "resources/app.asar")));
  }
  const existing: string[] = [];
  for (const candidate of new Set(candidates)) {
    try {
      await (await open(candidate, "r")).close();
      existing.push(candidate);
    } catch {
      // not there
    }
  }
  return existing;
}

/* ---------------------------------------------------------------- checks */

export interface BundleReport {
  asar: string;
  version?: string;
  commit?: string;
  /** Fields referenced by the web client; a missing one means T3 likely dropped it. */
  fields: Record<ScriptField, boolean>;
}

export async function checkBundle(asarPath: string): Promise<BundleReport> {
  const archive = await openAsar(asarPath);
  try {
    let version: string | undefined;
    let commit: string | undefined;
    try {
      const pkg = JSON.parse((await archive.read("package.json")).toString("utf8")) as { version?: string; t3codeCommitHash?: string };
      version = pkg.version;
      commit = pkg.t3codeCommitHash;
    } catch {
      // metadata is informative only
    }
    const fields = Object.fromEntries(REQUIRED_SCRIPT_FIELDS.map((f) => [f, false])) as Record<ScriptField, boolean>;
    for (const file of archive.files) {
      if (!file.startsWith(`${CLIENT_ASSETS_DIR}/`) || !file.endsWith(".js")) continue;
      const text = (await archive.read(file)).toString("utf8");
      for (const field of REQUIRED_SCRIPT_FIELDS) if (!fields[field] && text.includes(field)) fields[field] = true;
      if (REQUIRED_SCRIPT_FIELDS.every((f) => fields[f])) break;
    }
    return { asar: asarPath, version, commit, fields };
  } finally {
    await archive.close();
  }
}

/** Which required fields the public t3.json schema still declares for script entries. */
export function checkSchema(schema: unknown): Record<ScriptField, boolean> {
  const props = (schema as { properties?: { scripts?: { items?: { properties?: Record<string, unknown> } } } })?.properties?.scripts?.items
    ?.properties;
  return Object.fromEntries(REQUIRED_SCRIPT_FIELDS.map((f) => [f, Boolean(props && f in props)])) as Record<ScriptField, boolean>;
}

export async function fetchSchema(url = T3_SCHEMA_URL): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

export function missingFields(fields: Record<ScriptField, boolean>): ScriptField[] {
  return REQUIRED_SCRIPT_FIELDS.filter((f) => !fields[f]);
}

/** One-shot check of the first installed bundle. Undefined when no bundle can be found or read. */
export async function checkInstalledT3(): Promise<BundleReport | undefined> {
  for (const asar of await findT3Bundles()) {
    try {
      return await checkBundle(asar);
    } catch {
      // unreadable or not an asar: try the next candidate
    }
  }
  return undefined;
}
