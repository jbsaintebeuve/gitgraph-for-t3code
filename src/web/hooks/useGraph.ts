import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  UNCOMMITTED_HASH,
  type GraphCommit,
  type GraphLayout,
  type GraphOrder,
  type GraphPage,
} from "../../shared/types.js";
import { computeLayout } from "../../shared/layout.js";
import { api, apiUrl } from "../api";
import { refsByCommit } from "../lib/refs";

export const PAGE_SIZE = 500;
const MAX_LIMIT = 5000;

export interface GraphOptions {
  repo: string | undefined;
  order: GraphOrder;
  branches: string[];
  remotes: boolean;
  stashes: boolean;
  firstParent: boolean;
}

/** A row of the table: a real commit or the "uncommitted changes" pseudo-commit. */
export interface GraphRow {
  hash: string;
  parents: string[];
  commit?: GraphCommit;
  uncommitted?: boolean;
}

export interface GraphState {
  page: GraphPage | undefined;
  rows: GraphRow[];
  layout: GraphLayout;
  indexByHash: Map<string, number>;
  refsByHash: ReturnType<typeof refsByCommit>;
  loading: boolean;
  loadingMore: boolean;
  error: string | undefined;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
}

const EMPTY_LAYOUT: GraphLayout = { rows: [], edges: [], laneCount: 0 };

export function useGraph(options: GraphOptions): GraphState {
  const { repo, order, branches, remotes, stashes, firstParent } = options;
  const [page, setPage] = useState<GraphPage>();
  const [commits, setCommits] = useState<GraphCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [hasMore, setHasMore] = useState(false);
  const generation = useRef(0);
  const loaded = useRef(0);
  const busy = useRef(false);
  const branchKey = branches.join(",");

  const url = useCallback(
    (skip: number, limit: number) =>
      apiUrl("/api/graph", {
        repo,
        skip,
        limit,
        order,
        branches: branchKey || undefined,
        remotes,
        stashes,
        firstParent,
      }),
    [repo, order, branchKey, remotes, stashes, firstParent],
  );

  /** (Re)loads from the top. `keep` = number of commits to refetch so the scroll depth survives a refresh. */
  const load = useCallback(
    async (keep: number, silent: boolean) => {
      if (!repo) return;
      const id = ++generation.current;
      busy.current = true;
      // A page request still in flight belongs to the previous generation: its completion handler
      // will ignore itself, so it cannot clear the "loading more" state any more.
      setLoadingMore(false);
      if (!silent) {
        setLoading(true);
        setCommits([]);
        setPage(undefined);
      }
      try {
        const result = await api<GraphPage>(url(0, Math.min(MAX_LIMIT, Math.max(PAGE_SIZE, keep))));
        if (id !== generation.current) return;
        loaded.current = result.commits.length;
        setPage(result);
        setCommits(result.commits);
        setHasMore(result.hasMore);
        setError(undefined);
      } catch (e) {
        if (id !== generation.current) return;
        setError(e instanceof Error ? e.message : String(e));
        if (!silent) setHasMore(false);
      } finally {
        if (id === generation.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [repo, url],
  );

  // Reload from scratch whenever the query changes.
  useEffect(() => {
    void load(PAGE_SIZE, false);
    return () => {
      generation.current++;
      busy.current = false;
    };
  }, [load]);

  const refresh = useCallback(() => void load(Math.max(PAGE_SIZE, loaded.current), true), [load]);

  const loadMore = useCallback(() => {
    if (busy.current || !hasMore || !repo) return;
    const id = generation.current;
    busy.current = true;
    setLoadingMore(true);
    api<GraphPage>(url(loaded.current, PAGE_SIZE))
      .then((result) => {
        if (id !== generation.current) return;
        setCommits((previous) => {
          const seen = new Set(previous.map((c) => c.hash));
          const merged = previous.concat(result.commits.filter((c) => !seen.has(c.hash)));
          loaded.current = merged.length;
          return merged;
        });
        setHasMore(result.hasMore);
      })
      .catch((e: unknown) => {
        if (id === generation.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (id === generation.current) {
          busy.current = false;
          setLoadingMore(false);
        }
      });
  }, [hasMore, repo, url]);

  const rows = useMemo<GraphRow[]>(() => {
    const list: GraphRow[] = commits.map((commit) => ({ hash: commit.hash, parents: commit.parents, commit }));
    if (page?.workingTree) {
      list.unshift({
        hash: UNCOMMITTED_HASH,
        parents: page.head.hash ? [page.head.hash] : [],
        uncommitted: true,
      });
    }
    return list;
  }, [commits, page?.workingTree, page?.head.hash]);

  const layout = useMemo(
    () =>
      rows.length
        ? computeLayout(rows.map((r) => ({ hash: r.hash, parents: r.parents, pseudo: r.uncommitted })))
        : EMPTY_LAYOUT,
    [rows],
  );
  const indexByHash = useMemo(() => new Map(rows.map((r, i) => [r.hash, i])), [rows]);
  const refsByHash = useMemo(() => refsByCommit(page?.refs ?? []), [page?.refs]);

  return { page, rows, layout, indexByHash, refsByHash, loading, loadingMore, error, hasMore, loadMore, refresh };
}
