// Injected by the server into index.html; in Vite dev the proxy adds the header instead.
const token = document.querySelector<HTMLMetaElement>('meta[name="gitgraph-token"]')?.content ?? "";
const hasToken = token !== "" && token !== "__GITGRAPH_TOKEN__";

/**
 * The token embedded in the page belongs to one server process. After a restart or a takeover
 * by another `gitgraph` process every call answers 401: remember it so the UI can ask for a reload.
 */
let sessionStale = false;
const staleListeners = new Set<() => void>();
export const isSessionStale = (): boolean => sessionStale;
export function subscribeSessionStale(listener: () => void): () => void {
  staleListeners.add(listener);
  return () => staleListeners.delete(listener);
}
function markSessionStale(): void {
  if (sessionStale) return;
  sessionStale = true;
  for (const listener of [...staleListeners]) listener();
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(hasToken ? { "x-gitgraph-token": token } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (response.status === 401) {
    markSessionStale();
    throw new Error("Server restarted: reload the page");
  }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

export function eventsUrl(): string {
  return hasToken ? `/api/events?token=${encodeURIComponent(token)}` : "/api/events";
}

export interface RepoEntry {
  path: string;
  name: string;
  activatedAt: number;
}

/** Builds "/api/x?a=1&b=2", skipping undefined values. */
export function apiUrl(path: string, params: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    query.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
  return `${path}?${query}`;
}
