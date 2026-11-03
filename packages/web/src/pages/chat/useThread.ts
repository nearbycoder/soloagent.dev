import { useCallback, useEffect, useRef, useState } from "react";
import { applyThreadEvent, emptyLive, type Message, type ThreadState } from "@soloagent/client";
import { client, SoloApiError } from "../../api/client.ts";
import { useStream } from "../../api/store.ts";
import { toast } from "../../lib/toast.ts";

const blank = (): ThreadState => ({ messages: [], hasMore: false, live: emptyLive() });

export type ThreadView = ThreadState & {
  loaded: boolean;
  notFound: boolean;
  loadingEarlier: boolean;
  loadEarlier: () => Promise<number>;
  /** Measured thinking durations (ms) for messages that streamed while we watched. */
  thinkingMs: Map<string, number>;
  /** How long the in-progress turn thought, once it has moved on to answering. */
  liveThinkingMs: number | null;
};

/**
 * Subscribe to one thread over the WebSocket and fold events with the shared reducer.
 * Also fetches a REST snapshot so the first paint does not wait for the socket.
 */
export function useThread(threadId: string): ThreadView {
  const stream = useStream();
  const [state, setState] = useState<ThreadState>(blank);
  const [loaded, setLoaded] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [thinkingMs, setThinkingMs] = useState(() => new Map<string, number>());
  const stateRef = useRef(state);
  stateRef.current = state;
  const timing = useRef<{ start: number | null; ms: number | null }>({ start: null, ms: null });

  useEffect(() => {
    setState(blank());
    setLoaded(false);
    setNotFound(false);
    timing.current = { start: null, ms: null };
    let disposed = false;

    client
      .thread(threadId)
      .then((snapshot) => {
        if (disposed) return;
        setState((s) => (s.thread ? s : { thread: snapshot.thread, messages: snapshot.messages, hasMore: snapshot.hasMore, live: snapshot.live }));
        setLoaded(true);
      })
      .catch((error) => {
        if (disposed) return;
        if (error instanceof SoloApiError && error.status === 404) setNotFound(true);
        else toast.error(error, "Could not load thread");
        setLoaded(true);
      });

    if (!stream) return () => void (disposed = true);
    const off = stream.on((event) => {
      if (event.type === "thread.snapshot" && event.snapshot.thread.id === threadId) setLoaded(true);
      if (event.type === "thread.deleted" && event.threadId === threadId) setNotFound(true);
      if (event.type === "thread.live" && event.threadId === threadId) {
        const partial = event.live.partial;
        const t = timing.current;
        if (partial?.thinking && !partial.text && t.start === null) t.start = Date.now();
        if (t.start !== null && t.ms === null && (partial?.text || partial?.toolCalls.length)) t.ms = Date.now() - t.start;
      }
      if (event.type === "thread.messages" && event.threadId === threadId) {
        const t = timing.current;
        const withThinking = event.messages.find((m): m is Extract<Message, { kind: "assistant" }> => m.kind === "assistant" && !!m.thinking);
        if (withThinking && t.start !== null) {
          const ms = t.ms ?? Date.now() - t.start;
          setThinkingMs((map) => new Map(map).set(withThinking.id, ms));
        }
        if (withThinking || event.messages.some((m) => m.kind === "assistant")) timing.current = { start: null, ms: null };
      }
      setState((s) => applyThreadEvent(s, threadId, event));
    });
    const unsubscribe = stream.subscribe(threadId);
    return () => {
      disposed = true;
      off();
      unsubscribe();
    };
  }, [threadId, stream]);

  const loadEarlier = useCallback(async () => {
    const current = stateRef.current;
    const first = current.messages[0];
    if (!current.hasMore || !first || loadingEarlier) return 0;
    setLoadingEarlier(true);
    try {
      const page = await client.messages(threadId, first.id);
      // Count from the ref: a setState updater runs later, during render, so it can't report back here.
      const known = new Set(stateRef.current.messages.map((m) => m.id));
      const added = page.messages.filter((m) => !known.has(m.id)).length;
      setState((s) => {
        const current = new Set(s.messages.map((m) => m.id));
        const older = page.messages.filter((m) => !current.has(m.id));
        return { ...s, messages: [...older, ...s.messages], hasMore: page.hasMore };
      });
      return added;
    } catch (error) {
      toast.error(error, "Could not load earlier messages");
      return 0;
    } finally {
      setLoadingEarlier(false);
    }
  }, [threadId, loadingEarlier]);

  return { ...state, loaded, notFound, loadingEarlier, loadEarlier, thinkingMs, liveThinkingMs: timing.current.ms };
}
