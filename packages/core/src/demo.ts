import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, type Provider } from "@earendil-works/pi-ai";

type AnyMessage = { role: string; content?: string | { type: string; text?: string }[] };

const lastUserText = (messages: readonly AnyMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    return (m.content ?? []).map((b) => b.text ?? "").join(" ");
  }
  return "";
};

function reply(input: string): string {
  const text = input.replace(/^\[[^\]]+\]:\s*/, "").trim();
  const lower = text.toLowerCase();
  if (/\b(hi|hello|hey|yo)\b/.test(lower)) {
    return "Hey! 👋 I'm running on the **demo model** — no account needed. Connect Claude, ChatGPT, Copilot, or any API key under **Providers** and I'll get a real brain.";
  }
  if (lower.includes("what") && lower.includes("solo")) {
    return [
      "**soloagent** is one control plane for all of your agents:",
      "",
      "- **Durable** — every turn is committed by Pi Durable before it's shown, so runs survive crashes and deploys.",
      "- **Any subscription** — sign in with Claude Pro/Max, ChatGPT, GitHub Copilot, or 30+ API providers.",
      "- **Everywhere** — the same agents answer in Slack, Discord, Telegram, webhooks, this GUI, and the TUI.",
    ].join("\n");
  }
  return [
    `You said: _“${text.slice(0, 200)}”_`,
    "",
    "This is the demo model, so I can only echo and explain. Here's what a real model could do in this thread:",
    "",
    "1. Remember facts with the **memory** skill",
    "2. Read the web with **web_fetch**",
    "3. Hand work to your other agents with **ask_agent**",
    "4. Set reminders that survive restarts with **schedule_reminder**",
  ].join("\n");
}

/** A built-in model that needs no account, so a fresh install can be tried end to end. */
export function demoProvider(): Provider {
  const faux = fauxProvider({
    provider: "demo",
    models: [{ id: "solo-demo", name: "Solo Demo (no account needed)", reasoning: true, contextWindow: 128_000, maxTokens: 4_096 }],
    tokensPerSecond: 90,
  });
  const step = (context: { messages: readonly AnyMessage[] }) => {
    faux.appendResponses([step]);
    const input = lastUserText(context.messages);
    return fauxAssistantMessage([fauxThinking(`The user wrote ${input.length} characters. Keep it friendly and point at real providers.`), fauxText(reply(input))]);
  };
  faux.setResponses([step]);
  return { ...faux.provider, name: "Demo — no account needed" };
}
