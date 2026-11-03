import type { Author, ConnectorStatus } from "@soloagent/client";

/** Where a reply goes on the platform. JSON-safe: stored on the thread so later replies (reminders) can find it. */
export type ReplyTarget = Record<string, string>;

/** A message posted by the connector that can be edited later, for streaming. */
export type PostHandle = Record<string, string>;

export type InboundMessage = {
  /** Stable key of the platform conversation, e.g. "C123:1730000000.000100" for a Slack thread. */
  externalKey: string;
  /** Human label: "#general", "DM with ann". */
  location: string;
  title: string;
  author: Author;
  /** Text with the bot mention removed. */
  text: string;
  target: ReplyTarget;
  isDirect: boolean;
  /** The platform channel (or group chat), for connector access lists. Absent for DMs and webhooks. */
  channel?: { id: string; name?: string; parent?: { id: string; name?: string } };
};

/** Approvals: someone pressed Approve or Deny on an approval message. */
export type ChatDecisionInput = { approvalId: string; approve: boolean; user: { id?: string; name: string }; reason?: string };

export interface ConnectorHost {
  receive(message: InboundMessage): void;
  /** Approvals: resolves with whether it counted, and a short message to show only that user when it did not. */
  decide(input: ChatDecisionInput): Promise<{ ok: boolean; message: string }>;
  status(status: ConnectorStatus, detail?: string, identity?: string): void;
  log(message: string): void;
}

export interface ConnectorDriver {
  /** Longest message the platform accepts; longer replies are split. */
  readonly maxLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  post(target: ReplyTarget, markdown: string): Promise<PostHandle | undefined>;
  edit?(target: ReplyTarget, handle: PostHandle, markdown: string): Promise<void>;
  typing?(target: ReplyTarget): Promise<void>;
  /** Approvals: post `markdown` with Approve and Deny buttons that carry `approvalId`. */
  requestApproval?(target: ReplyTarget, approvalId: string, markdown: string): Promise<PostHandle | undefined>;
  /** Approvals: replace an approval message with its outcome and remove the buttons. */
  resolveApproval?(target: ReplyTarget, handle: PostHandle, markdown: string): Promise<void>;
}

export type DriverFactory = (config: Record<string, string>, host: ConnectorHost) => ConnectorDriver;
