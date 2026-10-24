import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Shared state between `gitgraph` processes: who serves, on which port, with which token. */
export interface InstanceInfo {
  port: number;
  token: string;
  pid: number;
}

// XDG on Linux, ~/.config on macOS too: one predictable place on both platforms.
export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "gitgraph-t3");
}

const instancePath = () => join(configDir(), "instance.json");

export async function readInstance(): Promise<InstanceInfo | undefined> {
  try {
    const raw = JSON.parse(await readFile(instancePath(), "utf8")) as Partial<InstanceInfo>;
    if (typeof raw.port === "number" && typeof raw.token === "string" && typeof raw.pid === "number") {
      return { port: raw.port, token: raw.token, pid: raw.pid };
    }
  } catch {
    // Missing or corrupt file: treat as "no instance".
  }
  return undefined;
}

export async function writeInstance(info: InstanceInfo): Promise<void> {
  const dir = configDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // `mode` only applies to what we create: tighten a pre-existing directory too (best effort).
  await chmod(dir, 0o700).catch(() => undefined);
  // The token grants write access to local repos: keep it readable by the owner only. Written to a
  // private temp file and renamed so that other processes never read a half-written file.
  const temp = `${instancePath()}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(info), { mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, instancePath());
}

export async function removeInstanceIfOwned(pid: number): Promise<void> {
  const current = await readInstance();
  if (current?.pid === pid) await rm(instancePath(), { force: true });
}
