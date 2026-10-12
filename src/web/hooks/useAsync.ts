import { useEffect, useState } from "react";
import { api } from "../api";

export interface AsyncState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
}

interface Internal<T> extends AsyncState<T> {
  url: string | null;
}

/**
 * GET `url` (skipped when null), ignoring stale responses. `reloadKey` forces a silent refetch.
 * Data from a previous url is never returned.
 */
export function useApi<T>(url: string | null, reloadKey?: unknown): AsyncState<T> {
  const [state, setState] = useState<Internal<T>>({ url, data: undefined, error: undefined, loading: url !== null });
  useEffect(() => {
    if (url === null) return;
    let cancelled = false;
    setState((s) => (s.url === url ? { ...s, error: undefined, loading: true } : { url, data: undefined, error: undefined, loading: true }));
    api<T>(url).then(
      (data) => !cancelled && setState({ url, data, error: undefined, loading: false }),
      (e: unknown) =>
        !cancelled && setState({ url, data: undefined, error: e instanceof Error ? e.message : String(e), loading: false }),
    );
    return () => {
      cancelled = true;
    };
  }, [url, reloadKey]);
  if (url === null) return { data: undefined, error: undefined, loading: false };
  if (state.url !== url) return { data: undefined, error: undefined, loading: true };
  return state;
}
