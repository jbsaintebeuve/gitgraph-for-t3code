import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { UNCOMMITTED_HASH, type GraphOrder } from "../shared/types.js";
import { api, isSessionStale, subscribeSessionStale, type RepoEntry } from "./api";
import { ActionToast } from "./components/ActionToast";
import { ContextMenu, type ContextMenuState, type ContextTarget } from "./components/ContextMenu";
import { FormDialog } from "./components/Dialog";
import { OperationBanner } from "./components/OperationBanner";
import { DetailsPanel } from "./components/DetailsPanel";
import { GraphView, type ScrollRequest } from "./components/GraphView";
import { Toolbar } from "./components/Toolbar";
import { useGitActions } from "./hooks/useGitActions";
import { useGraph } from "./hooks/useGraph";
import { useSearch } from "./hooks/useSearch";
import { useServerEvents } from "./hooks/useServerEvents";
import { useSessionState } from "./hooks/useSessionState";
import { buildMenuItems, pullDialog, pushDialog, remoteNames } from "./lib/menuItems";

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export function App() {
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [reposLoaded, setReposLoaded] = useState(false);
  const [reposError, setReposError] = useState<string>();
  const [storedRepo, setStoredRepo] = useSessionState<string | null>("repo", null);
  const [order, setOrder] = useSessionState<GraphOrder>("order", "topo");
  const [branches, setBranches] = useSessionState<string[]>("branches", []);
  const [remotes, setRemotes] = useSessionState("remotes", true);
  const [stashes, setStashes] = useSessionState("stashes", true);
  const [firstParent, setFirstParent] = useSessionState("firstParent", false);
  const [detailsHeight, setDetailsHeight] = useSessionState("detailsHeight", 340);

  const [cursor, setCursor] = useState<string>();
  const [compare, setCompare] = useState<string>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest>();
  const [menu, setMenu] = useState<ContextMenuState>();
  const [query, setQuery] = useState("");
  const [currentMatch, setCurrentMatch] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const sessionStale = useSyncExternalStore(subscribeSessionStale, isSessionStale);
  const searchInput = useRef<HTMLInputElement>(null);
  const nonce = useRef(0);

  // Repository list (+ live updates).
  useEffect(() => {
    api<RepoEntry[]>("/api/repos").then(
      (list) => {
        setRepos(list);
        setReposLoaded(true);
      },
      (e: unknown) => {
        setReposError(e instanceof Error ? e.message : String(e));
        setReposLoaded(true);
      },
    );
  }, []);

  const repo = useMemo(() => {
    if (storedRepo && repos.some((r) => r.path === storedRepo)) return storedRepo;
    return [...repos].sort((a, b) => b.activatedAt - a.activatedAt)[0]?.path;
  }, [repos, storedRepo]);

  const graph = useGraph({ repo, order, branches, remotes, stashes, firstParent });
  const { rows, indexByHash, page } = graph;

  useServerEvents({
    onRepos: setRepos,
    // The event stream was interrupted (server restarted, laptop slept...): refetch what we may have missed.
    onReconnect: () => {
      api<RepoEntry[]>("/api/repos").then(setRepos, () => undefined);
      graph.refresh();
      setReloadKey((k) => k + 1);
    },
    onRepoChanged: (changed) => {
      if (changed === repo) {
        graph.refresh();
        setReloadKey((k) => k + 1);
      }
    },
  });

  // The branch filter is per repository: a name from another repository would make the graph fail.
  const previousRepo = useRef(repo);
  useEffect(() => {
    if (previousRepo.current !== undefined && repo !== undefined && previousRepo.current !== repo) setBranches([]);
    previousRepo.current = repo;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setBranches is stable; react to repo only
  }, [repo]);

  // A selected branch that no longer exists (deleted, renamed) would make every load fail: drop the filter.
  useEffect(() => {
    if (branches.length > 0 && graph.error?.startsWith("unknown branch")) setBranches([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to the error only
  }, [graph.error]);

  // Reset the selection when the repository or query changes.
  useEffect(() => {
    setCursor(undefined);
    setCompare(undefined);
    setDetailsOpen(false);
    setCurrentMatch(undefined);
  }, [repo]);

  const reveal = useCallback((hash: string, center = false) => setScrollRequest({ hash, nonce: ++nonce.current, center }), []);

  /* --------------------------------------------------------------- actions */

  const refreshAll = useCallback(() => {
    graph.refresh();
    setReloadKey((k) => k + 1);
  }, [graph]);
  const rowsRef = useRef({ rows, indexByHash });
  rowsRef.current = { rows, indexByHash };
  const commitOf = useCallback((hash: string) => {
    const index = rowsRef.current.indexByHash.get(hash);
    return index === undefined ? undefined : rowsRef.current.rows[index]?.commit;
  }, []);
  const parentCount = useCallback((hash: string) => commitOf(hash)?.parents.length ?? 0, [commitOf]);
  const subjectOf = useCallback((hash: string) => commitOf(hash)?.subject, [commitOf]);
  const actions = useGitActions({ repo, page, refresh: refreshAll, parentCount, subjectOf });
  const dialogOpen = actions.dialog !== undefined;

  const headBranch = page?.head.branch;
  const headRef = page?.refs.find((r) => r.kind === "branch" && r.isHead);
  const hasRemotes = remoteNames(page?.refs ?? []).length > 0;
  const operationActive = !!page?.operation;
  const pullDisabled = !page ? "Not loaded" : operationActive ? "Finish or abort the current operation first" : !headBranch ? "HEAD is detached" : !headRef?.upstream ? "The current branch has no upstream" : undefined;
  const pushDisabled = !page ? "Not loaded" : operationActive ? "Finish or abort the current operation first" : !headBranch ? "HEAD is detached" : !hasRemotes ? "No remote configured" : undefined;

  /* ------------------------------------------------------------- selection */

  const select = useCallback(
    (hash: string, { compare: wantCompare }: { compare: boolean }) => {
      if (wantCompare && cursor && cursor !== hash && cursor !== UNCOMMITTED_HASH && hash !== UNCOMMITTED_HASH) {
        setCompare(hash);
      } else {
        setCursor(hash);
        setCompare(undefined);
      }
      setDetailsOpen(true);
    },
    [cursor],
  );

  /** Select a commit by hash, loading further pages until it shows up (parent links, search hits). */
  const pendingReveal = useRef<string | undefined>(undefined);
  const jumpTo = useCallback(
    (hash: string) => {
      if (indexByHash.has(hash)) {
        pendingReveal.current = undefined;
        setCursor(hash);
        setCompare(undefined);
        reveal(hash, true);
      } else {
        pendingReveal.current = hash;
        graph.loadMore();
      }
    },
    [indexByHash, graph, reveal],
  );
  useEffect(() => {
    const target = pendingReveal.current;
    if (!target) return;
    if (indexByHash.has(target)) jumpTo(target);
    else if (graph.hasMore) graph.loadMore();
    else pendingReveal.current = undefined;
  }, [rows, indexByHash, graph, jumpTo]);

  /* ---------------------------------------------------------------- search */

  const search = useSearch(repo, query, reloadKey);
  const matchSet = useMemo(() => new Set(search.hashes), [search.hashes]);
  const matchRows = useMemo(
    () => search.hashes.flatMap((h) => indexByHash.get(h) ?? []).sort((a, b) => a - b),
    [search.hashes, indexByHash],
  );
  const pendingMatch = useRef<1 | -1 | undefined>(undefined);

  const goToMatch = useCallback(
    (dir: 1 | -1) => {
      if (search.hashes.length === 0) return;
      const from = currentMatch !== undefined ? (indexByHash.get(currentMatch) ?? -1) : cursor ? (indexByHash.get(cursor) ?? -1) : -1;
      const base = from < 0 ? (dir > 0 ? -1 : rows.length) : from;
      let next = dir > 0 ? matchRows.find((i) => i > base) : [...matchRows].reverse().find((i) => i < base);
      if (next === undefined && dir > 0 && graph.hasMore && matchRows.length < search.hashes.length) {
        pendingMatch.current = dir;
        graph.loadMore();
        return;
      }
      next ??= dir > 0 ? matchRows[0] : matchRows[matchRows.length - 1];
      const row = next === undefined ? undefined : rows[next];
      if (!row) return;
      setCurrentMatch(row.hash);
      setCursor(row.hash);
      setCompare(undefined);
      reveal(row.hash, true);
    },
    [search.hashes, currentMatch, cursor, indexByHash, matchRows, rows, graph, reveal],
  );
  useEffect(() => {
    const dir = pendingMatch.current;
    if (!dir) return;
    pendingMatch.current = undefined;
    goToMatch(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when new rows arrive
  }, [rows]);
  useEffect(() => setCurrentMatch(undefined), [query]);

  const matchLabel = query.trim()
    ? search.error
      ? "error"
      : search.hashes.length === 0
        ? "0 results"
        : `${currentMatch && indexByHash.has(currentMatch) ? `${matchRows.indexOf(indexByHash.get(currentMatch)!) + 1}/` : ""}${search.hashes.length >= 500 ? "500+" : search.hashes.length}`
    : "";

  /* -------------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
        return;
      }
      // Not while a menu or dialog is open (arrow keys would move the selection behind it).
      if (menu || dialogOpen || isEditable(event.target)) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (rows.length === 0) return;
        event.preventDefault();
        const current = cursor !== undefined ? (indexByHash.get(cursor) ?? -1) : -1;
        const next = Math.max(0, Math.min(rows.length - 1, current < 0 ? 0 : current + (event.key === "ArrowDown" ? 1 : -1)));
        const hash = rows[next]!.hash;
        setCursor(hash);
        setCompare(undefined);
        reveal(hash);
      } else if (event.key === "Enter" && cursor) {
        // Enter on a focused button/link activates it; it must not also open the details.
        if (event.target instanceof HTMLElement && /^(BUTTON|A|SUMMARY)$/.test(event.target.tagName)) return;
        setDetailsOpen(true);
      } else if (event.key === "Escape") {
        if (compare) setCompare(undefined);
        else setDetailsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, dialogOpen, rows, cursor, compare, indexByHash, reveal]);

  /* ------------------------------------------------------------ context menu */

  const openMenu = useCallback((target: ContextTarget, event: MouseEvent) => setMenu({ x: event.clientX, y: event.clientY, target }), []);
  const closeMenu = useCallback(() => setMenu(undefined), []);

  /* ---------------------------------------------------------------- layout */

  const startSplit = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const el = event.currentTarget;
    el.setPointerCapture(event.pointerId);
    const originY = event.clientY;
    const originH = detailsHeight;
    let latest = originH;
    const clamp = (h: number) => Math.max(120, Math.min(window.innerHeight - 180, h));
    const move = (e: globalThis.PointerEvent) => {
      latest = clamp(originH + originY - e.clientY);
      el.parentElement?.style.setProperty("--details-h", `${latest}px`);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDetailsHeight(latest);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // In compare mode the diff goes from the older commit (lower in the list) to the newer one.
  const detailsTarget = useMemo(() => {
    if (!cursor) return undefined;
    if (compare) {
      const a = indexByHash.get(cursor) ?? 0;
      const b = indexByHash.get(compare) ?? 0;
      return a <= b ? { hash: cursor, compareTo: compare } : { hash: compare, compareTo: cursor };
    }
    return { hash: cursor, compareTo: undefined };
  }, [cursor, compare, indexByHash]);

  const showDetails = detailsOpen && detailsTarget && repo;

  let body;
  if (reposError) body = <div className="state error">Could not load repositories: {reposError}</div>;
  else if (!reposLoaded) body = <div className="state muted">Loading…</div>;
  else if (!repo) body = <div className="state muted">No repository registered. Run <code>gitgraph --repo &lt;path&gt;</code>.</div>;
  else if (graph.loading && !page) body = <div className="state muted">Loading commits…</div>;
  else if (graph.error && !page) body = <div className="state error">{graph.error}</div>;
  else if (page && rows.length === 0) body = <div className="state muted">No commits yet in this repository.</div>;
  else {
    body = (
      <GraphView
        rows={rows}
        layout={graph.layout}
        indexByHash={indexByHash}
        refsByHash={graph.refsByHash}
        headHash={page?.head.hash}
        workingTree={page?.workingTree ?? null}
        selected={cursor}
        compare={compare}
        matches={matchSet}
        currentMatch={currentMatch}
        hasMore={graph.hasMore}
        loadingMore={graph.loadingMore}
        scrollRequest={scrollRequest}
        onSelect={select}
        onLoadMore={graph.loadMore}
        onContextMenu={openMenu}
      />
    );
  }

  return (
    <div className="app" style={{ "--details-h": `${detailsHeight}px` } as CSSProperties}>
      {sessionStale && (
        <div className="banner banner-error banner-row" role="alert">
          <span>Server restarted: this page&apos;s session is no longer valid.</span>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
      <Toolbar
        repos={repos}
        repo={repo}
        onRepo={setStoredRepo}
        refs={page?.refs ?? []}
        branches={branches}
        onBranches={setBranches}
        remotes={remotes}
        onRemotes={setRemotes}
        stashes={stashes}
        onStashes={setStashes}
        firstParent={firstParent}
        onFirstParent={setFirstParent}
        order={order}
        onOrder={setOrder}
        query={query}
        onQuery={setQuery}
        searchInput={searchInput}
        matchLabel={matchLabel}
        onNextMatch={() => goToMatch(1)}
        onPrevMatch={() => goToMatch(-1)}
        onRefresh={refreshAll}
        refreshing={graph.loading}
        actionsBusy={actions.running !== undefined}
        onFetch={() => void actions.perform({ type: "fetch", prune: true }, "Fetch (prune)")}
        onPull={() => headBranch && actions.menuContext.openForm(pullDialog(actions.menuContext, headBranch))}
        onPush={() => {
          const spec = headBranch && pushDialog(actions.menuContext, headBranch, headRef?.upstream);
          if (spec) actions.menuContext.openForm(spec);
        }}
        pullDisabled={pullDisabled}
        pushDisabled={pushDisabled}
      />
      {page && repo && (
        <OperationBanner
          repo={repo}
          page={page}
          conflicts={actions.conflicts}
          reloadKey={reloadKey}
          running={actions.running !== undefined}
          onContinue={() => void actions.perform({ type: "continueOperation" }, "Continue")}
          onAbort={() =>
            actions.menuContext.openForm({
              title: `Abort ${page.operation}`,
              danger: true,
              confirmLabel: `Abort ${page.operation}`,
              description: (
                <>
                  Run <code>git {page.operation} --abort</code>: the {page.operation} stops and the repository returns to its state before it started.{" "}
                  <strong>Any conflict resolution you did so far is discarded.</strong>
                </>
              ),
              onConfirm: () => void actions.perform({ type: "abortOperation" }, `Abort ${page.operation}`),
            })
          }
        />
      )}
      {graph.error && page && (
        <div className="banner banner-error" role="alert">
          {graph.error}
        </div>
      )}
      <div className="main">{body}</div>
      {showDetails && (
        <>
          <div className="splitter" onPointerDown={startSplit} role="separator" aria-orientation="horizontal" title="Drag to resize" />
          <div className="details-wrap">
            <DetailsPanel
              repo={repo}
              hash={detailsTarget.hash}
              compareTo={detailsTarget.compareTo}
              reloadKey={reloadKey}
              onClose={() => {
                setDetailsOpen(false);
                setCompare(undefined);
              }}
              onJump={jumpTo}
            />
          </div>
        </>
      )}
      {menu && <ContextMenu state={menu} onClose={closeMenu} getItems={(target) => buildMenuItems(target, actions.menuContext)} />}
      {actions.dialog && <FormDialog spec={actions.dialog} onClose={actions.closeDialog} />}
      <ActionToast running={actions.running} toast={actions.toast} onDismiss={actions.dismissToast} />
    </div>
  );
}
