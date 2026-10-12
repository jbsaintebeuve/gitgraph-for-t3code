import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionResult, GitAction, GraphPage } from "../../shared/types.js";
import { api, apiUrl } from "../api";
import type { FormDialogSpec } from "../components/Dialog";
import { copyText } from "../lib/clipboard";
import type { MenuContext } from "../lib/menuItems";

export interface ActionToast {
  id: number;
  label: string;
  ok: boolean;
  output: string;
  conflicts?: string[];
  /** Short info toast (e.g. "Copied hash"): no output block. */
  info?: boolean;
}

export interface GitActionsOptions {
  repo: string | undefined;
  page: GraphPage | undefined;
  /** Refetch the graph (and anything derived from it) right now. */
  refresh: () => void;
  parentCount: (hash: string) => number;
  subjectOf: (hash: string) => string | undefined;
}

export function useGitActions({ repo, page, refresh, parentCount, subjectOf }: GitActionsOptions) {
  const [running, setRunning] = useState<string>();
  const [toast, setToast] = useState<ActionToast>();
  const [dialog, setDialog] = useState<FormDialogSpec>();
  const [conflicts, setConflicts] = useState<string[]>([]);
  const busy = useRef(false);
  const counter = useRef(0);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // A repository switch invalidates everything tied to the previous one.
  useEffect(() => {
    setDialog(undefined);
    setToast(undefined);
    setConflicts([]);
  }, [repo]);

  const perform = useCallback(
    async (action: GitAction, label: string) => {
      if (!repo || busy.current) return;
      busy.current = true;
      setRunning(label);
      setToast(undefined);
      const id = ++counter.current;
      try {
        const result = await api<ActionResult>(apiUrl("/api/action", { repo }), { method: "POST", body: JSON.stringify(action) });
        setConflicts(result.conflicts ?? []);
        setToast({ id, label, ok: result.ok, output: result.output || (result.ok ? "Done." : "Failed without output."), conflicts: result.conflicts });
      } catch (e) {
        setToast({ id, label, ok: false, output: e instanceof Error ? e.message : String(e) });
      } finally {
        busy.current = false;
        setRunning(undefined);
        refreshRef.current(); // don't wait for the file watcher
      }
    },
    [repo],
  );

  const copy = useCallback((text: string, what: string) => {
    void copyText(text).then((ok) =>
      setToast({ id: ++counter.current, label: ok ? `Copied ${what}` : `Could not copy ${what}`, ok, output: "", info: true }),
    );
  }, []);

  const menuContext = useMemo<MenuContext>(
    () => ({ page, busy: running !== undefined, parentCount, subjectOf, perform: (a, l) => void perform(a, l), openForm: setDialog, copy }),
    [page, running, parentCount, subjectOf, perform, copy],
  );

  return {
    running,
    toast,
    dismissToast: useCallback(() => setToast(undefined), []),
    dialog,
    closeDialog: useCallback(() => setDialog(undefined), []),
    conflicts,
    perform,
    menuContext,
  };
}
