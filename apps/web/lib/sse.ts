"use client";
import { useEffect, useRef } from "react";
import { GATEWAY } from "./wagmi";

export type ArenaEvent = { type: string; [k: string]: unknown };

/** Subscribes to a gateway SSE channel; reconnects automatically (EventSource built-in). */
export function useEventStream(path: string | null, onEvent: (e: ArenaEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    if (!path) return;
    const es = new EventSource(`${GATEWAY}${path}`);
    es.onmessage = (m) => {
      try {
        handler.current(JSON.parse(m.data) as ArenaEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => es.close();
  }, [path]);
}
