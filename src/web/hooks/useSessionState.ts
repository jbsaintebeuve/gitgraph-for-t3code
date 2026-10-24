import { useCallback, useState } from "react";

/** useState persisted in sessionStorage (per page / webview session). */
export function useSessionState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(`gitgraph:${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        sessionStorage.setItem(`gitgraph:${key}`, JSON.stringify(next));
      } catch {
        /* storage unavailable: keep in memory only */
      }
    },
    [key],
  );
  return [value, set];
}
