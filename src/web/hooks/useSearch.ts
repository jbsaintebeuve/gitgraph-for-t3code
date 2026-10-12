import { useEffect, useState } from "react";
import { api, apiUrl } from "../api";

/** Debounced /api/search; returns the set of matching hashes. */
export function useSearch(repo: string | undefined, query: string, refreshKey: unknown) {
  const [hashes, setHashes] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const q = query.trim();
    if (!repo || !q) {
      setHashes([]);
      setError(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api<string[]>(apiUrl("/api/search", { repo, q }))
        .then((list) => {
          if (cancelled) return;
          setHashes(list);
          setError(undefined);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setHashes([]);
          setError(e instanceof Error ? e.message : String(e));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [repo, query, refreshKey]);
  return { hashes, error };
}
