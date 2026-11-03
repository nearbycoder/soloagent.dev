import type { LiveState, Message, ServerEvent, Thread } from "./types.ts";

export type ThreadState = {
  thread?: Thread;
  messages: Message[];
  hasMore: boolean;
  live: LiveState;
};

export const emptyLive = (): LiveState => ({ busy: false, queued: 0, turns: 0, tools: [] });

/**
 * Fold one server event into a thread's client-side state. Shared by the GUI and the TUI so both
 * render the same thing. Returns the same object when the event does not concern the thread.
 */
export function applyThreadEvent(state: ThreadState, threadId: string, event: ServerEvent): ThreadState {
  switch (event.type) {
    case "thread.snapshot":
      if (event.snapshot.thread.id !== threadId) return state;
      return {
        thread: event.snapshot.thread,
        messages: event.snapshot.messages,
        hasMore: event.snapshot.hasMore,
        live: event.snapshot.live,
      };
    case "thread.messages": {
      if (event.threadId !== threadId) return state;
      const known = new Set(state.messages.map((m) => m.id));
      const fresh = event.messages.filter((m) => !known.has(m.id));
      if (fresh.length === 0) return state;
      return { ...state, messages: [...state.messages, ...fresh] };
    }
    case "thread.live":
      if (event.threadId !== threadId) return state;
      return { ...state, live: event.live };
    case "thread.updated":
      if (event.thread.id !== threadId) return state;
      return { ...state, thread: event.thread };
    default:
      return state;
  }
}
