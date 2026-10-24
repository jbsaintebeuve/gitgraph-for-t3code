import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { asarPathFromLauncher, checkBundle, checkSchema, findT3Bundles, missingFields, openAsar } from "./t3compat.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Writes an asar archive the way @electron/asar does (pickled header, then file contents). */
async function writeAsar(files: Record<string, string>, unpacked: string[] = []): Promise<string> {
  const root: { files: Record<string, unknown> } = { files: {} };
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/");
    let node = root;
    for (const dir of parts.slice(0, -1)) node = ((node.files[dir] as typeof root | undefined) ??= { files: {} }) as typeof root;
    const data = Buffer.from(content);
    if (unpacked.includes(path)) {
      node.files[parts.at(-1)!] = { size: data.length, unpacked: true };
      continue;
    }
    node.files[parts.at(-1)!] = { size: data.length, offset: String(offset) };
    chunks.push(data);
    offset += data.length;
  }
  const json = Buffer.from(JSON.stringify(root));
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(16 + padded);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + padded, 4);
  header.writeUInt32LE(4 + padded, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  const dir = await mkdtemp(join(tmpdir(), "gitgraph-asar-"));
  dirs.push(dir);
  const file = join(dir, "app.asar");
  await writeFile(file, Buffer.concat([header, ...chunks]));
  return file;
}

const PKG = JSON.stringify({ version: "0.0.46-nightly.1", t3codeCommitHash: "abc123" });

describe("openAsar", () => {
  it("lists and reads packed files, skipping unpacked ones", async () => {
    const asar = await writeAsar({ "package.json": PKG, "a/b/c.js": "hello", "native.node": "bin" }, ["native.node"]);
    const archive = await openAsar(asar);
    try {
      expect(archive.files.sort()).toEqual(["a/b/c.js", "package.json"]);
      expect((await archive.read("a/b/c.js")).toString()).toBe("hello");
      await expect(archive.read("missing.js")).rejects.toThrow(/not found/);
    } finally {
      await archive.close();
    }
  });

  it("rejects files that are not asar archives", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitgraph-asar-"));
    dirs.push(dir);
    const file = join(dir, "app.asar");
    await writeFile(file, "definitely not an archive, just text");
    await expect(openAsar(file)).rejects.toThrow(/not an asar/);
  });
});

describe("checkBundle", () => {
  it("reports version, commit and supported fields", async () => {
    const asar = await writeAsar({
      "package.json": PKG,
      "apps/server/dist/client/assets/chat.js": 'x.previewUrl; y.autoOpenPreview',
    });
    const report = await checkBundle(asar);
    expect(report).toMatchObject({ version: "0.0.46-nightly.1", commit: "abc123", fields: { previewUrl: true, autoOpenPreview: true } });
    expect(missingFields(report.fields)).toEqual([]);
  });

  it("flags fields the web client no longer references", async () => {
    const asar = await writeAsar({
      "package.json": PKG,
      "apps/server/dist/client/assets/chat.js": "x.previewUrl",
      // Mentions outside the web client do not count (e.g. a stale schema copy on the server side).
      "apps/server/dist/bin.mjs": "autoOpenPreview",
    });
    expect(missingFields((await checkBundle(asar)).fields)).toEqual(["autoOpenPreview"]);
  });
});

describe("checkSchema", () => {
  const schema = (props: Record<string, unknown>) => ({ properties: { scripts: { items: { properties: props } } } });
  it("finds the fields in script items", () => {
    expect(checkSchema(schema({ previewUrl: {}, autoOpenPreview: {} }))).toEqual({ previewUrl: true, autoOpenPreview: true });
  });
  it("tolerates removed fields and malformed schemas", () => {
    expect(checkSchema(schema({ previewUrl: {} }))).toEqual({ previewUrl: true, autoOpenPreview: false });
    expect(checkSchema(null)).toEqual({ previewUrl: false, autoOpenPreview: false });
    expect(checkSchema({ properties: {} })).toEqual({ previewUrl: false, autoOpenPreview: false });
  });
});

describe("asarPathFromLauncher", () => {
  it("extracts the bundle path from the T3 launcher script", () => {
    const mac = `exec "$app" '/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar/apps/server/dist/bin.mjs' "$@"`;
    expect(asarPathFromLauncher(mac)).toBe("/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar");
    const linux = `exec "$app" "/tmp/.mount_T3abc/resources/app.asar/apps/server/dist/bin.mjs" "$@"`;
    expect(asarPathFromLauncher(linux)).toBe("/tmp/.mount_T3abc/resources/app.asar");
    expect(asarPathFromLauncher("#!/bin/sh\necho hi")).toBeUndefined();
  });
});

describe("findT3Bundles", () => {
  it("honours GITGRAPH_T3_ASAR", async () => {
    expect(await findT3Bundles({ GITGRAPH_T3_ASAR: "/some/app.asar" })).toEqual(["/some/app.asar"]);
  });

  it("reads the launcher from T3CODE_HOME and drops paths that do not exist", async () => {
    const asar = await writeAsar({ "package.json": PKG });
    const home = await mkdtemp(join(tmpdir(), "gitgraph-t3home-"));
    dirs.push(home);
    await mkdir(join(home, "bin"));
    await writeFile(join(home, "bin", "t3"), `exec "$app" '${asar}/apps/server/dist/bin.mjs' "$@"\n`);
    expect(await findT3Bundles({ T3CODE_HOME: home })).toContain(asar);

    await writeFile(join(home, "bin", "t3"), `exec "$app" '/nope/app.asar/bin.mjs'\n`);
    expect(await findT3Bundles({ T3CODE_HOME: home })).not.toContain("/nope/app.asar");
  });
});
