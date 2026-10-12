import { useEffect, useRef } from "react";
import { api, eventsUrl, isSessionStale } from "../api";
import { connectServerEvents, type ServerEventHandlers } from "../lib/serverEvents";

export type { ServerEventHandlers };

/** One EventSource for the whole app; handlers are read through a ref so they can change freely. */
export function useServerEvents(handlers: ServerEventHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(
    () =>
      connectServerEvents({
        url: eventsUrl,
        createSource: (url) => new EventSource(url),
        probe: () => api("/api/repos"),
        isStale: isSessionStale,
        handlers: () => ref.current,
      }),
    [],
  );
}
