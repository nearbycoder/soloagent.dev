import type { Agent, Message, ProviderInfo, Thread, ThreadState } from "@soloagent/client";
import type { TUI } from "@earendil-works/pi-tui";

export type Tone = "info" | "success" | "warn" | "error";

/** A local, unsaved line in the transcript: command results and errors. */
export type Notice = { id: number; afterId: string | null; text: string; tone: Tone };

/** A message the user sent that the server has not echoed back yet. */
export type Pending = {
  id: number;
  text: string;
  at: number;
  failed?: boolean;
  /** Newest message id when this was sent; only later messages can echo it. */
  baseline: string | null;
};

export type ToolMessage = Extract<Message, { kind: "tool" }>;
export type AssistantMessage = Extract<Message, { kind: "assistant" }>;
export type UserMessage = Extract<Message, { kind: "user" }>;
export type EventMessage = Extract<Message, { kind: "event" }>;

/** What the view components read from the app. The App class implements it. */
export interface ViewModel {
  readonly tui: TUI;
  readonly version: string;
  readonly conn: { label: string; mode: "local" | "remote"; embedded: boolean; url: string };
  agents: Agent[];
  threads: Thread[];
  providers: ProviderInfo[] | null;
  state: ThreadState;
  current: { threadId: string | null; agentId: string | null };
  connected: boolean;
  everConnected: boolean;
  showThinking: boolean;
  expandTools: boolean;
  expandedCalls: Set<string>;
  sidebarOpen: boolean;
  unread: Set<string>;
  busySince: number | undefined;
  loadingEarlier: boolean;
  notices: Notice[];
  pending: Pending[];
  clearedAfter: string | null;
  /** A newer soloagent release, shown on the welcome screen. */
  update?: { latest: string; url: string };
  agentById(id: string | null | undefined): Agent | undefined;
  currentAgent(): Agent | undefined;
  currentThread(): Thread | undefined;
  hasRealProvider(): boolean;
  isBusy(): boolean;
  footerMessage(): { text: string; tone: Tone } | undefined;
  toggleThinking(): void;
  toggleCall(callId: string): void;
  openThread(threadId: string): void;
  requestRender(): void;
}
