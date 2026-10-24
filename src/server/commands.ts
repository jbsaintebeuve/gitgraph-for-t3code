import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { configDir } from "./instance.js";
import { T3_SCHEMA_URL, checkBundle, checkInstalledT3, checkSchema, fetchSchema, findT3Bundles, missingFields, type BundleReport, type ScriptField } from "./t3compat.js";

const execFileAsync = promisify(execFile);

export const SCRIPT_NAME = "Git Graph";

export interface T3Script {
  name: string;
  command: string;
  icon: string;
  previewUrl: string;
  autoOpenPreview: boolean;
}

export function gitGraphScript(port: number, defaultPort: number): T3Script {
  return {
    name: SCRIPT_NAME,
    command: port === defaultPort ? "gitgraph --repo ." : `gitgraph --repo . --port ${port}`,
    icon: "debug",
    previewUrl: `http://127.0.0.1:${port}`,
    autoOpenPreview: true,
  };
}

/** Pure merge of the Git Graph script into the text of a t3.json (undefined = new file). */
export function mergeT3Json(existing: string | undefined, script: T3Script): { text: string; changed: boolean; created: boolean } {
  let doc: Record<string, unknown>;
  if (existing === undefined) {
    doc = { $schema: T3_SCHEMA_URL };
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (error) {
      throw new Error(`t3.json is not valid JSON, refusing to modify it (${(error as Error).message})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("t3.json must contain a JSON object at the top level");
    }
    doc = parsed as Record<string, unknown>;
  }
  if (doc.scripts !== undefined && !Array.isArray(doc.scripts)) throw new Error('"scripts" in t3.json must be an array');
  const scripts: unknown[] = Array.isArray(doc.scripts) ? [...doc.scripts] : [];
  const index = scripts.findIndex((s) => typeof s === "object" && s !== null && (s as { name?: unknown }).name === SCRIPT_NAME);
  if (index >= 0) scripts[index] = { ...(scripts[index] as object), ...script };
  else scripts.push(script);
  doc.scripts = scripts;
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  return { text, changed: text !== existing, created: existing === undefined };
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 10_000 });
  return stdout.trim();
}

export async function runInit(opts: { repo: string; port: number; defaultPort: number; globalSnippet: boolean }): Promise<number> {
  const script = gitGraphScript(opts.port, opts.defaultPort);
  if (opts.globalSnippet) {
    // T3 settings require an `id` and `runOnWorktreeCreate` on defaultProjectScripts entries.
    const snippet = {
      defaultProjectScripts: [{ id: "git-graph", ...script, runOnWorktreeCreate: false }],
    };
    console.log(JSON.stringify(snippet, null, 2));
    console.error("\nPaste the `defaultProjectScripts` entry into T3 Code's settings.json (see README, \"Configuration globale\").");
    return 0;
  }
  let root: string;
  try {
    root = await git(["rev-parse", "--show-toplevel"], resolve(opts.repo));
  } catch {
    console.error(`✘ ${resolve(opts.repo)} is not inside a git repository.`);
    return 1;
  }
  const file = join(root, "t3.json");
  let existing: string | undefined;
  try {
    existing = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const result = mergeT3Json(existing, script);
    if (result.changed) await writeFile(file, result.text);
    console.log(
      result.created ? `✔ created ${file}` : result.changed ? `✔ updated ${file}` : `✔ ${file} already up to date`,
    );
    console.log(`  In T3 Code (once per project): Settings → Projects → this project → "Import scripts" → "${SCRIPT_NAME}",`);
    console.log(`  or the "+" (Add action) menu at the top of a thread → "From t3.json" → "${SCRIPT_NAME}". Then run it.`);
    return 0;
  } catch (error) {
    console.error(`✘ ${(error as Error).message}`);
    return 1;
  }
}

// ---------------------------------------------------------------- doctor

type Level = "ok" | "warn" | "fail" | "info";
const ICON: Record<Level, string> = { ok: "✔", warn: "!", fail: "✘", info: "·" };
let failures = 0;

function report(level: Level, message: string): void {
  if (level === "fail") failures += 1;
  console.log(`${ICON[level]} ${message}`);
}

export function parseGitVersion(output: string): [number, number, number] | undefined {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
}

async function findOnPath(name: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export async function runDoctor(opts: { repo: string; port: number; version: string }): Promise<number> {
  failures = 0;
  console.log(`gitgraph ${opts.version} doctor (${process.platform} ${process.arch})\n`);

  // Node
  const major = Number(process.versions.node.split(".")[0]);
  report(major >= 20 ? "ok" : "fail", `Node ${process.versions.node}${major >= 20 ? "" : " (>= 20 required)"}`);

  // git
  try {
    const out = await git(["--version"], process.cwd());
    const v = parseGitVersion(out);
    if (!v) report("warn", `git: unrecognised version string "${out}"`);
    else if (v[0] < 2 || (v[0] === 2 && v[1] < 34)) report("warn", `${out} (< 2.34: some features may degrade, upgrade recommended)`);
    else report("ok", out);
  } catch {
    report("fail", "git not found on PATH");
  }

  // Port / running instance
  try {
    const res = await fetch(`http://127.0.0.1:${opts.port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json().catch(() => ({}))) as { app?: string; pid?: number };
    if (body.app === "gitgraph-t3") report("ok", `gitgraph instance running on port ${opts.port} (pid ${body.pid})`);
    else report("fail", `port ${opts.port} is used by another service (use --port or GITGRAPH_PORT)`);
  } catch {
    if (await portIsFree(opts.port)) report("ok", `port ${opts.port} is free`);
    else report("fail", `port ${opts.port} is busy but does not answer as gitgraph (use --port or GITGRAPH_PORT)`);
  }

  // Config dir permissions (POSIX only)
  const dir = configDir();
  if (process.platform === "win32") {
    report("info", `config dir ${dir} (permission check skipped on Windows)`);
  } else {
    try {
      const mode = (await stat(dir)).mode & 0o777;
      report(mode === 0o700 ? "ok" : "fail", `config dir ${dir} mode ${mode.toString(8)}${mode === 0o700 ? "" : " (expected 700: chmod 700)"}`);
    } catch {
      report("info", `config dir ${dir} does not exist yet (created on first start)`);
    }
    const file = join(dir, "instance.json");
    try {
      const mode = (await stat(file)).mode & 0o777;
      report(mode === 0o600 ? "ok" : "fail", `instance.json mode ${mode.toString(8)}${mode === 0o600 ? "" : " (expected 600: chmod 600)"}`);
    } catch {
      report("info", "instance.json absent (no server has run yet)");
    }
  }

  // Watcher strategy
  if (process.platform === "linux") {
    let limit = "unknown";
    try {
      limit = (await readFile("/proc/sys/fs/inotify/max_user_watches", "utf8")).trim();
    } catch {
      // not readable (container, restricted proc)
    }
    const n = Number(limit);
    report(
      Number.isFinite(n) && n < 65536 ? "warn" : "info",
      `watcher: working tree is polled every 2 s on Linux; git dir uses inotify (fs.inotify.max_user_watches=${limit}${
        Number.isFinite(n) && n < 65536 ? ", low: raise it with sysctl if refs stop refreshing" : ""
      })`,
    );
  } else {
    report("info", `watcher: native recursive fs.watch on ${process.platform}`);
  }

  // PATH
  const onPath = await findOnPath(process.platform === "win32" ? "gitgraph.cmd" : "gitgraph");
  if (onPath) report("ok", `gitgraph found on PATH: ${onPath}`);
  else report("warn", "gitgraph not on PATH (run `npm link` from the repo; T3 scripts using `gitgraph --repo .` will fail)");

  // t3.json
  const t3 = join(resolve(opts.repo), "t3.json");
  try {
    const doc = JSON.parse(await readFile(t3, "utf8")) as { scripts?: Array<{ name?: string }> };
    if (doc.scripts?.some((s) => s?.name === SCRIPT_NAME)) report("ok", `${t3} declares the "${SCRIPT_NAME}" script`);
    else report("warn", `${t3} has no "${SCRIPT_NAME}" script (run \`gitgraph init\`)`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") report("info", `no t3.json in ${resolve(opts.repo)} (run \`gitgraph init\` to add one)`);
    else report("fail", `${t3} is not valid JSON`);
  }

  // Installed T3 Code still supports the script fields we rely on
  reportBundle(await checkInstalledT3().catch(() => undefined));

  console.log(failures > 0 ? `\n${failures} problem(s) found.` : "\nAll good.");
  return failures > 0 ? 1 : 0;
}

function describeBundle(bundle: BundleReport): string {
  const build = [bundle.version, bundle.commit && `commit ${bundle.commit}`].filter(Boolean).join(", ");
  return `T3 Code ${build || "(unknown version)"} at ${bundle.asar}`;
}

function reportBundle(bundle: BundleReport | undefined): void {
  if (!bundle) {
    report("info", "T3 Code bundle not found (set GITGRAPH_T3_ASAR to its app.asar to check compatibility)");
    return;
  }
  const missing = missingFields(bundle.fields);
  if (missing.length === 0) report("ok", `${describeBundle(bundle)} supports previewUrl/autoOpenPreview`);
  else report("fail", `${describeBundle(bundle)} no longer references ${missing.join(", ")}: open the URL by hand and see AGENTS.md`);
}

// ---------------------------------------------------------------- compat

/**
 * `gitgraph compat`: checks the installed T3 Code bundle and, with --online, the public
 * t3.json schema. Exit 1 on any incompatibility (the daily CI job relies on it).
 */
export async function runCompat(opts: { online: boolean; json: boolean }): Promise<number> {
  failures = 0;
  const result: { bundles: BundleReport[]; schema?: { url: string; fields?: Record<ScriptField, boolean>; error?: string } } = { bundles: [] };
  for (const asar of await findT3Bundles()) {
    try {
      result.bundles.push(await checkBundle(asar));
    } catch (error) {
      if (!opts.json) report("warn", `${asar}: ${(error as Error).message}`);
    }
  }
  if (opts.online) {
    try {
      result.schema = { url: T3_SCHEMA_URL, fields: checkSchema(await fetchSchema()) };
    } catch (error) {
      result.schema = { url: T3_SCHEMA_URL, error: (error as Error).message };
    }
  }

  const bundleBroken = result.bundles.some((b) => missingFields(b.fields).length > 0);
  const schemaBroken = Boolean(result.schema?.error || (result.schema?.fields && missingFields(result.schema.fields).length > 0));
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return bundleBroken || schemaBroken ? 1 : 0;
  }

  if (result.bundles.length === 0) reportBundle(undefined);
  for (const bundle of result.bundles) reportBundle(bundle);
  if (result.schema?.error) report("fail", `schema ${T3_SCHEMA_URL} unreachable: ${result.schema.error}`);
  else if (result.schema?.fields) {
    const missing = missingFields(result.schema.fields);
    if (missing.length === 0) report("ok", `schema ${T3_SCHEMA_URL} declares previewUrl/autoOpenPreview`);
    else report("fail", `schema ${T3_SCHEMA_URL} no longer declares ${missing.join(", ")}`);
  } else report("info", "public schema not checked (add --online)");

  console.log(failures > 0 ? `\n${failures} problem(s) found. See AGENTS.md ("Si T3 Code casse l'intégration").` : "\nCompatible.");
  return failures > 0 ? 1 : 0;
}
