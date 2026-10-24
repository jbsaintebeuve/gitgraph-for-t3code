/**
 * Resilient server-sent-events client (DOM-free so it can be unit-tested in Node).
 *
 * Browsers reconnect an EventSource by themselves after a network error, but only while the
 * response is a 200: when the server restarted (or a follower process took over) the page's
 * session token is stale, the reconnect answers 401 and the EventSource is closed for good.
 * This client therefore
 *  - tells the app when the stream is back after an interruption (`onReconnect`), so it can
 *    refetch everything it may have missed;
 *  - when the browser gave up (readyState CLOSED), probes the API: a 401 is reported through
 *    `probe` (which flags the session as stale), other failures are retried every `retryMs`.
 */

export interface EventSourceLike {
  readonly readyState: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DOM Event, not available in Node typings
  onopen: ((event: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((event: any) => void) | null;
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  close(): void;
}

export interface ServerEventHandlers {
  onRepos?: (repos: { path: string; name: string; activatedAt: number }[]) => void;
  onRepoChanged?: (repo: string) => void;
  /** The stream was interrupted and is connected again: refetch anything displayed. */
  onReconnect?: () => void;
}

export interface ServerEventsDeps {
  url: () => string;
  createSource: (url: string) => EventSourceLike;
  /** Cheap authenticated request; rejects when the server is unreachable or the token is stale. */
  probe: () => Promise<unknown>;
  /** True once the session is known to be stale: no point in retrying. */
  isStale: () => boolean;
  handlers: () => ServerEventHandlers;
  retryMs?: number;
}

const CLOSED = 2;

export function connectServerEvents(deps: ServerEventsDeps): () => void {
  const retryMs = deps.retryMs ?? 2000;
  let source: EventSourceLike | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let interrupted = false;

  const parse = (event: { data?: string }): unknown => {
    try {
      return JSON.parse(event.data ?? "");
    } catch {
      return undefined;
    }
  };

  const open = () => {
    if (disposed) return;
    const current = deps.createSource(deps.url());
    source = current;
    current.addEventListener("repos", (event) => {
      const data = parse(event);
      if (Array.isArray(data)) deps.handlers().onRepos?.(data);
    });
    current.addEventListener("repo-changed", (event) => {
      const data = parse(event) as { repo?: string } | undefined;
      if (data?.repo) deps.handlers().onRepoChanged?.(data.repo);
    });
    current.onopen = () => {
      if (source !== current) return;
      if (interrupted) {
        interrupted = false;
        deps.handlers().onReconnect?.();
      }
    };
    current.onerror = () => {
      if (source !== current || disposed) return;
      interrupted = true;
      if (current.readyState === CLOSED) {
        // The browser will not retry (non-200 answer, e.g. 401): take over.
        current.close();
        source = undefined;
        scheduleRetry();
      }
    };
  };

  const scheduleRetry = () => {
    if (disposed || deps.isStale() || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || deps.isStale()) return;
      deps.probe().then(
        () => open(),
        () => scheduleRetry(),
      );
    }, retryMs);
  };

  open();
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    source?.close();
    source = undefined;
  };
}
