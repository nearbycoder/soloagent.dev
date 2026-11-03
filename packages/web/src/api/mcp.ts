import { useEffect, useSyncExternalStore } from "react";
import type { McpServer } from "@soloagent/client";
import { client } from "./client.ts";
import { useStream } from "./store.ts";
import { toast } from "../lib/toast.ts";

/** MCP servers, shared by the Tools page and the agent editor. Live status arrives as `mcp.*` events. */
let servers: McpServer[] | null = null;
const listeners = new Set<() => void>();
let loading: Promise<void> | undefined;

function set(next: McpServer[] | null) {
  servers = next;
  for (const listener of listeners) listener();
}

export function loadMcpServers(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = client
    .mcpServers()
    .then((list) => set(list))
    .catch((error) => {
      toast.error(error, "Could not load MCP servers");
      if (!servers) set([]);
    });
  return loading;
}

export const mcpLocal = {
  server(server: McpServer) {
    if (!servers) return;
    const i = servers.findIndex((s) => s.id === server.id);
    set(i === -1 ? [...servers, server] : servers.map((s) => (s.id === server.id ? server : s)));
  },
  deleted(id: string) {
    if (servers) set(servers.filter((s) => s.id !== id));
  },
};

export function useMcpServers(): McpServer[] | null {
  const stream = useStream();
  useEffect(() => {
    void loadMcpServers();
  }, []);
  useEffect(() => {
    if (!stream) return;
    const offEvents = stream.on((event) => {
      if (event.type === "mcp.updated") mcpLocal.server(event.server);
      if (event.type === "mcp.deleted") mcpLocal.deleted(event.serverId);
    });
    // Catch up after a reconnect.
    const offStatus = stream.onStatus((connected) => connected && void loadMcpServers(true));
    return () => {
      offEvents();
      offStatus();
    };
  }, [stream]);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => servers,
  );
}
