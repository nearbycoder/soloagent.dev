import type { Context } from "@earendil-works/chord";
import {
  configure,
  defineExtension,
  defineTask,
  defineTool,
  type Extension,
  GenerationTask,
  hook,
  section,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { int, num, obj, opt, str } from "@earendil-works/pi-schema";
import type { Agent, AgentSkill } from "@soloagent/client";
import { EVENT_ENTRY, MESSAGE_ENTRY, textOf, type EventEntryData, type MessageEntryData } from "./transcript.ts";

/** What the skills need from the soloagent runtime. Kept narrow so skills stay testable. */
export interface SkillHost {
  agentForConversation(conversationId: number): Agent | undefined;
  threadContext(conversationId: number): { source: string; location: string | null; title: string } | undefined;
  agents(): Agent[];
  agentByHandle(handle: string): Agent | undefined;
  /** The Pi agent change an agent's conversations run with. */
  agentChange(agent: Agent, options?: { nested?: boolean }): import("@earendil-works/pi-durable").AgentChange;
  memories(agentId: string, limit: number): { id: number; text: string; createdAt: number }[];
  searchMemories(agentId: string, query: string, limit: number): { id: number; text: string; createdAt: number }[];
  remember(agentId: string, text: string): number;
  forget(agentId: string, id: number): boolean;
  /** Text of an entry in any conversation, for reading a delegate's answer. */
  answerText(conversationId: number, entryId: number, context: Context): Promise<string>;
  scheduleCreated(info: { taskId: string; conversationId: number; text: string; at: number }): void;
  scheduleFired(taskId: string): void;
  /** Called after every answered run; delivers replies to Slack, Discord, and friends. */
  runAnswered(conversationId: number, answerEntryId: number, context: Context): void;
  /** Swap stored-image markers back to image blocks before each model request (Files & images). */
  expandFiles?(messages: readonly import("@earendil-works/pi-ai").Message[]): Promise<readonly import("@earendil-works/pi-ai").Message[]>;
}

const MAX_FETCH_CHARS = 24_000;

export function createSkills(host: SkillHost) {
  /** Always selected: identity, date, roster, and the outbound delivery hook. */
  const Base = defineExtension({
    name: "solo.base",
    sections: [
      section(
        "identity",
        (input) => {
          const agent = host.agentForConversation(Number(input.conversationId));
          if (!agent) return undefined;
          const thread = host.threadContext(Number(input.conversationId));
          const lines = [
            `You are ${agent.name} (@${agent.handle}), an AI agent running on soloagent.`,
            agent.description ? `Your role: ${agent.description}` : undefined,
            thread ? `This conversation happens over ${thread.source}${thread.location ? ` in ${thread.location}` : ""}.` : undefined,
            `Today is ${new Date().toISOString().slice(0, 10)} (UTC).`,
            "Messages from people are prefixed with their name in brackets, e.g. [ann]: when it helps to know who is talking.",
            thread && ["slack", "discord", "telegram"].includes(thread.source)
              ? "You are in a chat app: keep replies compact, skip preamble, and prefer short lists over long prose."
              : undefined,
          ];
          return lines.filter(Boolean).join("\n");
        },
        { tag: false },
      ),
    ],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (request) => (host.expandFiles ? { messages: await host.expandFiles(request.messages) } : undefined),
        afterRun: async (run, api, context) => {
          host.runAnswered(Number(api.conversationId), Number(run.answer), context);
          return undefined;
        },
      }),
    ],
  });

  const Memory = defineExtension({
    name: "solo.memory",
    sections: [
      section("memory", (input) => {
        const agent = host.agentForConversation(Number(input.conversationId));
        if (!agent) return undefined;
        const notes = host.memories(agent.id, 40);
        const header =
          "Long-term memory. Use `remember` for durable facts about people, preferences, and decisions worth keeping across conversations. Use `recall` to search it.";
        if (notes.length === 0) return `${header}\n(no memories yet)`;
        return `${header}\n${notes.map((n) => `- #${n.id}: ${n.text}`).join("\n")}`;
      }),
    ],
    tools: [
      defineTool({
        name: "remember",
        description: "Save a durable note to long-term memory. Keep it short and self-contained.",
        parameters: obj({ note: str({ description: "The fact to remember, phrased so it makes sense out of context." }) }),
        execute: async (args, api) => {
          const agent = host.agentForConversation(Number(api.conversationId));
          if (!agent) throw new Error("No agent for this conversation");
          const id = host.remember(agent.id, args.note.trim());
          return { output: [{ type: "text", text: `Saved as memory #${id}.` }] };
        },
      }),
      defineTool({
        name: "recall",
        description: "Search long-term memory by keywords.",
        parameters: obj({ query: str() }),
        replay: "safe",
        execute: async (args, api) => {
          const agent = host.agentForConversation(Number(api.conversationId));
          if (!agent) throw new Error("No agent for this conversation");
          const hits = host.searchMemories(agent.id, args.query, 20);
          const text = hits.length ? hits.map((h) => `#${h.id} (${new Date(h.createdAt).toISOString().slice(0, 10)}): ${h.text}`).join("\n") : "No matching memories.";
          return { output: [{ type: "text", text }] };
        },
      }),
      defineTool({
        name: "forget",
        description: "Delete a memory by its number.",
        parameters: obj({ id: int() }),
        execute: async (args, api) => {
          const agent = host.agentForConversation(Number(api.conversationId));
          if (!agent) throw new Error("No agent for this conversation");
          const ok = host.forget(agent.id, args.id);
          return { output: [{ type: "text", text: ok ? `Forgot #${args.id}.` : `No memory #${args.id}.` }], isError: !ok };
        },
      }),
    ],
  });

  const Web = defineExtension({
    name: "solo.web",
    tools: [
      defineTool({
        name: "web_fetch",
        description: "Fetch a URL and return its readable text (HTML is converted to text). Use for docs, articles, and JSON APIs.",
        parameters: obj({ url: str(), max_chars: opt(int({ description: `Default ${MAX_FETCH_CHARS}` })) }),
        replay: "safe",
        execute: async (args) => {
          const response = await fetch(args.url, {
            headers: { "user-agent": "soloagent/0.1 (+https://soloagent.dev)", accept: "text/html,application/json,text/plain,*/*" },
            signal: AbortSignal.timeout(20_000),
            redirect: "follow",
          });
          const type = response.headers.get("content-type") ?? "";
          const raw = await response.text();
          const text = type.includes("html") ? htmlToText(raw) : raw;
          const limit = args.max_chars ?? MAX_FETCH_CHARS;
          const body = text.length > limit ? `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]` : text;
          return {
            output: [{ type: "text", text: `HTTP ${response.status} ${type}\n\n${body}` }],
            isError: !response.ok,
          };
        },
      }),
      defineTool({
        name: "web_search",
        description: "Search the web and return the top results (title, url, snippet).",
        parameters: obj({ query: str() }),
        replay: "safe",
        execute: async (args) => {
          const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`, {
            headers: { "user-agent": "Mozilla/5.0 (compatible; soloagent/0.1; +https://soloagent.dev)" },
            signal: AbortSignal.timeout(15_000),
          });
          const html = await response.text();
          const results: string[] = [];
          const pattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
          for (const match of html.matchAll(pattern)) {
            let url = decodeEntities(match[1]!);
            const uddg = /[?&]uddg=([^&]+)/.exec(url);
            if (uddg) url = decodeURIComponent(uddg[1]!);
            results.push(`${results.length + 1}. ${stripTags(match[2]!)}\n   ${url}\n   ${stripTags(match[3]!)}`);
            if (results.length >= 8) break;
          }
          return { output: [{ type: "text", text: results.length ? results.join("\n") : "No results." }] };
        },
      }),
    ],
  });

  const Delegate: Extension = defineExtension({
    name: "solo.delegate",
    sections: [
      section("team", (input) => {
        const self = host.agentForConversation(Number(input.conversationId));
        const others = host.agents().filter((a) => a.id !== self?.id && a.model);
        if (others.length === 0) return undefined;
        return `Other agents you can hand work to with \`ask_agent\`:\n${others
          .map((a) => `- @${a.handle} — ${a.name}${a.description ? `: ${a.description}` : ""} (${a.model?.provider}/${a.model?.modelId})`)
          .join("\n")}`;
      }),
    ],
    tools: [
      defineTool({
        name: "ask_agent",
        description:
          "Delegate a self-contained task to another agent (by handle) and wait for its answer. The other agent does not see this conversation, so include all context it needs.",
        parameters: obj({ agent: str({ description: "Handle of the agent, without @" }), task: str() }),
        replay: "safe",
        execute: async (args, api, context) => {
          const target = host.agentByHandle(args.agent.replace(/^@/, ""));
          if (!target) throw new Error(`No agent @${args.agent}. Available: ${host.agents().map((a) => `@${a.handle}`).join(", ")}`);
          if (!target.model) throw new Error(`@${target.handle} has no model configured yet.`);
          const child = await api.commit(async (tx) => {
            const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
            if (existing !== undefined) return existing.id;
            const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
            await configure(tx, created.id, host.agentChange(target, { nested: true }));
            return created.id;
          }, context);
          await api.details({ conversationId: Number(child), agent: target.handle }, context);
          const handle = await api.conversation(child, context);
          if (!handle) throw new Error("Delegate conversation vanished");
          const from = host.agentForConversation(Number(api.conversationId));
          const submission = await handle.submit(
            {
              type: "input",
              content: args.task,
              requestId: `delegate:${api.taskId}`,
              entry: {
                kind: MESSAGE_ENTRY,
                data: { author: { name: from ? `@${from.handle}` : "agent", source: "agent" }, text: args.task, at: api.now() } satisfies MessageEntryData,
              },
            },
            context,
          );
          const settled = await submission.wait(context);
          if (settled.status !== "done") {
            return { output: [{ type: "text", text: `@${target.handle} could not answer (${settled.reason ?? "unanswered"}).` }], isError: true };
          }
          const answer = await host.answerText(Number(child), Number(settled.answer), context);
          return { output: [{ type: "text", text: `@${target.handle} answered:\n\n${answer}` }] };
        },
      }),
    ],
  });

  const Reminder = defineTask<
    { conversationId: number; text: string; at: number },
    { phase: "wait" } | { phase: "deliver" },
    null
  >({
    name: "solo.reminder",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: (task, runtime, context) => runtime.sleepUntil(task.input.at, { phase: "deliver" }, context),
      deliver: async (task, runtime, context) => {
        const handle = await runtime.conversation(runtime.conversationId, context);
        await runtime.commit(async (tx) => {
          if (handle) {
            const text = `⏰ Scheduled reminder: ${task.input.text}`;
            await handle.submit(tx, {
              type: "input",
              content: `[scheduled reminder you set earlier] ${task.input.text}\nDeliver it now, addressed to whoever asked for it.`,
              requestId: `reminder:${task.id}`,
              entry: { kind: MESSAGE_ENTRY, data: { author: { name: "Reminder", source: "schedule" }, text, at: runtime.now() } satisfies MessageEntryData },
            });
          }
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
        host.scheduleFired(String(task.id));
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });

  const Schedule = defineExtension({
    name: "solo.schedule",
    tasks: [Reminder],
    tools: [
      defineTool({
        name: "schedule_reminder",
        description:
          "Schedule a durable reminder or follow-up in this conversation. When it fires you will be prompted to deliver it. Survives restarts and deploys.",
        parameters: obj({
          message: str({ description: "What to remind about or follow up on" }),
          in_minutes: opt(num({ description: "Minutes from now" })),
          at: opt(str({ description: "ISO 8601 time, e.g. 2026-11-03T09:00:00Z. Use instead of in_minutes." })),
        }),
        execute: async (args, api, context) => {
          const at = args.at ? Date.parse(args.at) : api.now() + (args.in_minutes ?? 0) * 60_000;
          if (!Number.isFinite(at)) throw new Error("Could not parse the time; use ISO 8601 or in_minutes.");
          if (at <= api.now() + 5_000) throw new Error("The reminder time must be in the future.");
          const taskId = await api.createTask(
            Reminder,
            { conversationId: Number(api.conversationId), text: args.message, at },
            { ownership: { kind: "conversation" }, background: true },
            context,
          );
          host.scheduleCreated({ taskId: String(taskId), conversationId: Number(api.conversationId), text: args.message, at });
          await api.commit(async (tx) => {
            await tx.appendEntry(api.conversationId, {
              kind: EVENT_ENTRY,
              data: { text: `Reminder set for ${new Date(at).toUTCString()}: ${args.message}`, tone: "info", at: api.now() } satisfies EventEntryData,
            });
          }, context);
          return { output: [{ type: "text", text: `Scheduled for ${new Date(at).toISOString()} (task ${taskId}).` }] };
        },
      }),
    ],
  });

  const extensions: Record<AgentSkill, Extension> = {
    memory: Memory,
    web: Web,
    delegate: Delegate,
    schedule: Schedule,
    workspace: CodingTools as unknown as Extension,
  };

  return { Base, extensions, all: [Base, Memory, Web, Delegate, Schedule, CodingTools as unknown as Extension] };
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

export { textOf };
