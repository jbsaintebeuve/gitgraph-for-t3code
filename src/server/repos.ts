import { basename } from "node:path";
import { resolveRepoRoot } from "./git.js";

export interface RepoEntry {
  path: string;
  name: string;
  activatedAt: number;
}

type Listener = () => void;

/** Repositories announced by `gitgraph --repo …` invocations, most recently activated first. */
export class RepoRegistry {
  private readonly repos = new Map<string, RepoEntry>();
  private readonly listeners = new Set<Listener>();

  /**
   * Validates that `dir` is inside a git repository and registers it. With `activate`,
   * it also becomes the most recent one; without, an already-known repo is left untouched.
   */
  async register(dir: string, { activate }: { activate: boolean }): Promise<RepoEntry> {
    const path = await resolveRepoRoot(dir);
    const existing = this.repos.get(path);
    if (existing && !activate) return existing;
    const entry: RepoEntry = { path, name: basename(path), activatedAt: Date.now() };
    this.repos.set(path, entry);
    this.emit();
    return entry;
  }

  list(): RepoEntry[] {
    return [...this.repos.values()].sort((a, b) => b.activatedAt - a.activatedAt);
  }

  get(path: string): RepoEntry | undefined {
    return this.repos.get(path);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}
