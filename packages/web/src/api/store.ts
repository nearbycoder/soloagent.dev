import { useSyncExternalStore } from "react";
import type {
  ActivityItem,
  Agent,
  Connector,
  ConnectorKindInfo,
  LoginFlowState,
  Overview,
  ProviderInfo,
  ServerEvent,
  SoloStream,
  Thread,
} from "@soloagent/client";
import { client } from "./client.ts";
import { toast } from "../lib/toast.ts";

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

export type AppState = {
  status: ConnectionStatus;
  version: string;
  agents: Agent[] | null;
  threads: Thread[] | null;
  connectors: Connector[] | null;
  kinds: ConnectorKindInfo[] | null;
  providers: ProviderInfo[] | null;
  overview: Overview | null;
  activity: ActivityItem[];
  flows: Record<string, LoginFlowState>;
};

const initial = (): AppState => ({
  status: "connecting",
  version: "",
  agents: null,
  threads: null,
  connectors: null,
  kinds: null,
  providers: null,
  overview: null,
  activity: [],
  flows: {},
});

let state: AppState = initial();
const listeners = new Set<() => void>();

function set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const listener of listeners) listener();
}

export function getState(): AppState {
  return state;
}

export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => selector(state),
  );
}

// ---------------------------------------------------------------------------
// Ordering helpers

const sortAgents = (agents: Agent[]) => [...agents].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt - b.createdAt);
const sortThreads = (threads: Thread[]) => [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
const upsert = <T extends { id: string }>(list: T[] | null, item: T): T[] | null => {
  if (!list) return list;
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const copy = [...list];
  copy[i] = item;
  return copy;
};

// ---------------------------------------------------------------------------
// Session lifecycle

let stream: SoloStream | null = null;
let offStream: (() => void)[] = [];
let overviewTimer: ReturnType<typeof setTimeout> | undefined;

export function getStream(): SoloStream {
  if (!stream) throw new Error("Not connected");
  return stream;
}

export function useStream(): SoloStream | null {
  // The stream is created once per session; re-render consumers when the session starts.
  useApp((s) => s.version);
  return stream;
}

async function safe<T>(promise: Promise<T>, fallback: T, quiet = false): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (!quiet) toast.error(error, "Could not load data");
    return fallback;
  }
}

export async function refreshAll() {
  const [agents, threads, connectors, overview] = await Promise.all([
    safe(client.agents(), state.agents ?? []),
    safe(client.threads({ limit: 300 }), state.threads ?? []),
    safe(client.connectors(), state.connectors ?? []),
    safe(client.overview(), state.overview, true),
  ]);
  set({
    agents: sortAgents(agents),
    threads: sortThreads(threads),
    connectors,
    overview,
    activity: overview ? mergeActivity(overview.activity, state.activity) : state.activity,
  });
}

function mergeActivity(fresh: ActivityItem[], current: ActivityItem[]): ActivityItem[] {
  const seen = new Set<number>();
  return [...fresh, ...current]
    .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
    .sort((a, b) => b.id - a.id)
    .slice(0, 300);
}

export function refreshOverviewSoon() {
  clearTimeout(overviewTimer);
  overviewTimer = setTimeout(async () => {
    const overview = await safe(client.overview(), state.overview, true);
    if (overview) set((s) => ({ overview, activity: mergeActivity(overview.activity, s.activity) }));
  }, 600);
}

export async function loadProviders(force = false) {
  if (state.providers && !force) return state.providers;
  const providers = await safe(client.providers(), state.providers ?? []);
  set({ providers });
  return providers;
}

export async function loadKinds() {
  if (state.kinds) return state.kinds;
  const kinds = await safe(client.connectorKinds(), []);
  set({ kinds });
  return kinds;
}

function onEvent(event: ServerEvent) {
  switch (event.type) {
    case "hello":
      set({ version: event.version });
      break;
    case "thread.updated":
      set((s) => ({ threads: s.threads ? sortThreads(upsert(s.threads, event.thread)!) : s.threads }));
      break;
    case "thread.deleted":
      set((s) => ({ threads: s.threads?.filter((t) => t.id !== event.threadId) ?? null }));
      refreshOverviewSoon();
      break;
    case "agent.updated":
      set((s) => {
        let agents = upsert(s.agents, event.agent);
        // Only one default agent: mirror the server's demotion locally until the next refresh.
        if (agents && event.agent.isDefault) agents = agents.map((a) => (a.id !== event.agent.id && a.isDefault ? { ...a, isDefault: false } : a));
        return { agents: agents && sortAgents(agents) };
      });
      refreshOverviewSoon();
      break;
    case "agent.deleted":
      set((s) => ({ agents: s.agents?.filter((a) => a.id !== event.agentId) ?? null }));
      refreshOverviewSoon();
      break;
    case "connector.updated":
      set((s) => ({ connectors: upsert(s.connectors, event.connector) }));
      refreshOverviewSoon();
      break;
    case "connector.deleted":
      set((s) => ({ connectors: s.connectors?.filter((c) => c.id !== event.connectorId) ?? null }));
      refreshOverviewSoon();
      break;
    case "providers.changed":
      if (state.providers) void loadProviders(true);
      refreshOverviewSoon();
      break;
    case "login.updated":
      set((s) => ({ flows: { ...s.flows, [event.flow.id]: event.flow } }));
      break;
    case "activity":
      set((s) => ({ activity: mergeActivity([event.item], s.activity) }));
      refreshOverviewSoon();
      break;
    default:
      break;
  }
}

export function startSession(version: string) {
  endSession();
  state = { ...initial(), version };
  stream = client.connect();
  let wasLive = false;
  offStream = [
    stream.on(onEvent),
    stream.onStatus((connected) => {
      if (connected) {
        set({ status: "live" });
        // Catch up on anything missed while disconnected.
        if (wasLive) void refreshAll();
        wasLive = true;
      } else {
        set({ status: wasLive ? "reconnecting" : "connecting" });
      }
    }),
  ];
  set({});
  void refreshAll();
}

export function endSession() {
  for (const off of offStream) off();
  offStream = [];
  stream?.close();
  stream = null;
  clearTimeout(overviewTimer);
  state = initial();
  for (const listener of listeners) listener();
}

export function setFlow(flow: LoginFlowState) {
  set((s) => ({ flows: { ...s.flows, [flow.id]: flow } }));
}

/** Optimistic local updates after a successful REST mutation (the WS event will confirm). */
export const local = {
  agent(agent: Agent) {
    onEvent({ type: "agent.updated", agent });
  },
  agentDeleted(agentId: string) {
    onEvent({ type: "agent.deleted", agentId });
  },
  connector(connector: Connector) {
    // Status is owned by the live stream: a REST response can be older than the status events that
    // followed it (an update restarts the connector in the background), so keep the streamed status.
    const known = state.connectors?.find((c) => c.id === connector.id);
    const merged = known ? { ...connector, status: known.status, statusDetail: known.statusDetail, identity: known.identity } : connector;
    onEvent({ type: "connector.updated", connector: merged });
  },
  connectorDeleted(connectorId: string) {
    onEvent({ type: "connector.deleted", connectorId });
  },
  thread(thread: Thread) {
    onEvent({ type: "thread.updated", thread });
  },
  threadDeleted(threadId: string) {
    onEvent({ type: "thread.deleted", threadId });
  },
};

export function agentById(id: string | null | undefined): Agent | undefined {
  return id ? state.agents?.find((a) => a.id === id) : undefined;
}

export function useAgentMap(): Map<string, Agent> {
  const agents = useApp((s) => s.agents);
  return agentMapCache(agents);
}

let lastAgents: Agent[] | null = null;
let lastMap = new Map<string, Agent>();
function agentMapCache(agents: Agent[] | null) {
  if (agents !== lastAgents) {
    lastAgents = agents;
    lastMap = new Map((agents ?? []).map((a) => [a.id, a]));
  }
  return lastMap;
}
