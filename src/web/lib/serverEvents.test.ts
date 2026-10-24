import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectServerEvents, type EventSourceLike, type ServerEventHandlers } from "./serverEvents.js";

class FakeSource implements EventSourceLike {
  static all: FakeSource[] = [];
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, listener: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data: unknown) {
    for (const l of this.listeners.get(type) ?? []) l({ data: JSON.stringify(data) });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  /** Network error; the browser keeps retrying (CONNECTING) unless `fatal`. */
  error(fatal = false) {
    this.readyState = fatal ? 2 : 0;
    this.onerror?.({});
  }
}

describe("connectServerEvents", () => {
  let handlers: ServerEventHandlers;
  let stale = false;
  let probe: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
  const start = () =>
    connectServerEvents({
      url: () => "/api/events?token=t",
      createSource: (url) => new FakeSource(url),
      probe: () => probe(),
      isStale: () => stale,
      handlers: () => handlers,
      retryMs: 1000,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSource.all = [];
    stale = false;
    probe = vi.fn<() => Promise<unknown>>().mockResolvedValue([]);
    handlers = { onRepos: vi.fn(), onRepoChanged: vi.fn(), onReconnect: vi.fn() };
  });
  afterEach(() => vi.useRealTimers());

  it("dispatches events and does not report the first connection as a reconnect", () => {
    const stop = start();
    const source = FakeSource.all[0]!;
    source.open();
    source.emit("repo-changed", { repo: "/r" });
    source.emit("repos", [{ path: "/r", name: "r", activatedAt: 1 }]);
    expect(handlers.onRepoChanged).toHaveBeenCalledWith("/r");
    expect(handlers.onRepos).toHaveBeenCalledTimes(1);
    expect(handlers.onReconnect).not.toHaveBeenCalled();
    stop();
    expect(source.closed).toBe(true);
  });

  it("signals a reconnect after the browser's automatic retry succeeds", () => {
    start();
    const source = FakeSource.all[0]!;
    source.open();
    source.error(); // server restarted, browser retries by itself
    source.open();
    expect(handlers.onReconnect).toHaveBeenCalledTimes(1);
    source.open();
    expect(handlers.onReconnect).toHaveBeenCalledTimes(1);
  });

  it("re-creates the stream when the browser gave up, once the API answers again", async () => {
    start();
    FakeSource.all[0]!.open();
    FakeSource.all[0]!.error(true);
    expect(FakeSource.all[0]!.closed).toBe(true);
    probe.mockRejectedValueOnce(new Error("down")); // still restarting
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSource.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSource.all).toHaveLength(2);
    FakeSource.all[1]!.open();
    expect(handlers.onReconnect).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once the session is stale (401 after a takeover)", async () => {
    start();
    FakeSource.all[0]!.error(true);
    stale = true; // the probe's 401 flagged the session
    await vi.advanceTimersByTimeAsync(10_000);
    expect(probe).not.toHaveBeenCalled();
    expect(FakeSource.all).toHaveLength(1);
  });

  it("does not leak timers or sources after dispose", async () => {
    const stop = start();
    FakeSource.all[0]!.error(true);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(probe).not.toHaveBeenCalled();
    expect(FakeSource.all).toHaveLength(1);
  });
});
