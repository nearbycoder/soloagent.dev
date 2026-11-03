// Connector integration tests: each chat driver runs for real against a fake platform on loopback (Telegram's
// Bot API, Slack's Web API and Socket Mode) or, for Discord, a stub discord.js client. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ConnectorInput } from "@soloagent/client";
import { Events } from "discord.js";
import { SoloAgent } from "../src/index.ts";
import { DRIVERS } from "../src/connectors/kinds.ts";
import { createDiscordDriver, discordInbound, discordReply } from "../src/connectors/discord.ts";
import { createApp } from "../../server/src/app.ts";
import { listen, readBody, until } from "./fakes/http.ts";
import { FakeTelegram, type TgChat, type TgUser } from "./fakes/telegram.ts";
import { FakeSlack } from "./fakes/slack.ts";
import { StubDiscordClient, stubMessage } from "./fakes/discord.ts";

// Loopback only, whatever the environment says about proxies.
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

async function open() {
  const dir = mkdtempSync(join(tmpdir(), "solo-connectors-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: false }] });
  const solo = await SoloAgent.open({ dataDir: dir, secret: "test", adminToken: "t", connectors: false, demo: false, providers: [faux.provider], log: () => {} });
  const agent = solo.agents.update(solo.agents.list()[0]!.id, { model: { provider: "faux", modelId: "faux-1" } });
  return {
    solo,
    faux,
    agent,
    answer: (text: string) => faux.appendResponses([fauxAssistantMessage([fauxText(text)])]),
    cleanup: async () => {
      await solo.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function connect(solo: SoloAgent, input: ConnectorInput) {
  const created = solo.connectors.create(input);
  await until(() => solo.connectors.get(created.id)?.status !== "starting" && solo.connectors.get(created.id)?.status !== "stopped" && solo.connectors.get(created.id), "connector status");
  return solo.connectors.get(created.id)!;
}

// ───────────────────────────── Telegram ─────────────────────────────

const TG_TOKEN = "123456:test-token";
const ANN: TgUser = { id: 111, first_name: "Ann" };
const BOB: TgUser = { id: 222, first_name: "Bob" };
const annDm: TgChat = { id: 111, type: "private", first_name: "Ann" };
const bobDm: TgChat = { id: 222, type: "private", first_name: "Bob" };
const group: TgChat = { id: -100, type: "group", title: "Eng" };

async function telegram(input: Omit<ConnectorInput, "kind" | "config"> = {}) {
  const tg = await FakeTelegram.start(TG_TOKEN);
  process.env.SOLOAGENT_TELEGRAM_API_ROOT = tg.apiRoot;
  const env = await open();
  const connector = await connect(env.solo, { kind: "telegram", config: { botToken: TG_TOKEN }, ...input });
  return {
    ...env,
    tg,
    connector,
    cleanup: async () => {
      await env.cleanup();
      await tg.close();
      delete process.env.SOLOAGENT_TELEGRAM_API_ROOT;
    },
  };
}

test("telegram: a DM reaches the agent and the answer is streamed back into the placeholder", async () => {
  const { solo, tg, connector, answer, cleanup } = await telegram();
  try {
    assert.equal(connector.status, "connected");
    assert.equal(connector.identity, "@solo_bot");
    answer("Hello **Ann**!");
    tg.message(ANN, annDm, "hi bot");
    await until(() => tg.textsIn(annDm.id).includes("Hello <b>Ann</b>!"), "the answer");

    const [placeholder] = tg.callsTo("sendMessage");
    assert.match(String(placeholder!.text), /thinking/);
    const final = tg.callsTo("editMessageText").at(-1)!;
    assert.equal(final.parse_mode, "HTML");
    assert.equal(tg.callsTo("sendMessage").length, 1, "the answer edits the placeholder instead of posting again");
    assert.ok(tg.callsTo("sendChatAction").some((a) => a.action === "typing" && Number(a.chat_id) === annDm.id));

    const [thread] = solo.listThreads({ source: "telegram" });
    assert.equal(thread?.location, "DM with Ann");
    const { messages } = await solo.messages(thread!.id);
    const user = messages.find((m) => m.kind === "user");
    assert.equal(user?.kind === "user" && user.author.name, "Ann");
  } finally {
    await cleanup();
  }
});

test("telegram: in groups only mentions get an answer, as a reply to the message", async () => {
  const { solo, tg, answer, cleanup } = await telegram();
  try {
    tg.message(ANN, group, "just chatting");
    answer("pong");
    const asked = tg.message(ANN, group, "@solo_bot ping");
    await until(() => tg.textsIn(group.id).includes("pong"), "the answer");
    const [placeholder] = tg.callsTo("sendMessage");
    assert.deepEqual(placeholder!.reply_parameters, { message_id: asked, allow_sending_without_reply: true });
    const threads = solo.listThreads({ source: "telegram" });
    assert.equal(threads.length, 1);
    const { messages } = await solo.messages(threads[0]!.id);
    assert.deepEqual(
      messages.filter((m) => m.kind === "user").map((m) => m.kind === "user" && m.text),
      ["ping"],
      "the unmentioned message never reached the agent, and the mention is stripped",
    );
  } finally {
    await cleanup();
  }
});

test("telegram: access lists deny a user with one short reply", async () => {
  const { solo, tg, answer, cleanup } = await telegram({ access: { users: ["Ann"] } });
  try {
    tg.message(BOB, bobDm, "let me in");
    tg.message(BOB, bobDm, "please?");
    answer("hi ann");
    tg.message(ANN, annDm, "hello");
    // Updates are handled in order, so once Ann has her answer both of Bob's messages were seen.
    await until(() => tg.textsIn(annDm.id).includes("hi ann"), "Ann's answer");
    assert.deepEqual(tg.textsIn(bobDm.id), ["You don't have access to @solo here. Ask an admin."]);
    assert.equal(solo.listThreads({ source: "telegram" }).length, 1);
    assert.equal(solo.recentActivity().filter((a) => a.type === "access").length, 1);
  } finally {
    await cleanup();
  }
});

test("telegram: the per-user hourly limit replies instead of running", async () => {
  const { solo, tg, answer, cleanup } = await telegram({ limits: { perUserPerHour: 1 } });
  try {
    answer("one");
    tg.message(ANN, annDm, "first");
    await until(() => tg.textsIn(annDm.id).includes("one"), "the first answer");
    tg.message(ANN, annDm, "second");
    await until(() => tg.textsIn(annDm.id).some((t) => /1 message in the last hour/.test(t)), "the limit notice");
    const [thread] = solo.listThreads({ source: "telegram" });
    const { messages } = await solo.messages(thread!.id);
    assert.deepEqual(messages.map((m) => m.kind), ["user", "assistant"], "the second message never ran");
  } finally {
    await cleanup();
  }
});

test("telegram: approval buttons decide a tool call through callback queries", async () => {
  const { solo, tg, faux, agent, cleanup } = await telegram({ approvers: [String(ANN.id)] });
  try {
    solo.agents.update(agent.id, { approvals: "all" });
    faux.appendResponses([
      fauxAssistantMessage([fauxToolCall("remember", { note: "ann likes tea" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Saved.")]),
    ]);
    tg.message(ANN, annDm, "remember that I like tea");
    const request = await until(() => tg.calls.find((c) => c.method === "sendMessage" && c.params.reply_markup && c.result), "the approval message");
    const keyboard = (request.params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0]!;
    assert.deepEqual(keyboard.map((b) => b.text), ["✅ Approve", "🚫 Deny"]);
    const approvalMessageId = FakeTelegram.messageId(request);

    // Bob is not an approver: he gets an alert only he sees, and nothing changes.
    tg.callback(BOB, annDm, keyboard[0]!.callback_data, approvalMessageId);
    const alert = await until(() => tg.callsTo("answerCallbackQuery")[0], "Bob's answer");
    assert.equal(alert.show_alert, true);
    assert.match(String(alert.text), /not an approver/);
    assert.equal(solo.listApprovals({ status: "pending" }).length, 1);

    tg.callback(ANN, annDm, keyboard[0]!.callback_data, approvalMessageId);
    await until(() => tg.textsIn(annDm.id).includes("Saved."), "the final answer");
    const answers = tg.callsTo("answerCallbackQuery");
    assert.equal(answers.length, 2);
    assert.notEqual(answers[1]!.show_alert, true);
    assert.equal(solo.listApprovals({ status: "approved" }).length, 1);
    // The approval message was edited to its outcome, and the edit carries no keyboard.
    const outcome = tg.callsTo("editMessageText").find((e) => Number(e.message_id) === approvalMessageId);
    assert.ok(outcome, "approval outcome edit");
    assert.equal(outcome.reply_markup, undefined);
    const memories = solo.db.all<{ text: string }>("SELECT text FROM memories WHERE agent_id = ?", agent.id);
    assert.deepEqual(memories.map((m) => m.text), ["ann likes tea"]);
  } finally {
    await cleanup();
  }
});

// ───────────────────────────── Slack ─────────────────────────────

async function slack(botToken = "xoxb-good") {
  const fake = await FakeSlack.start();
  fake.validBotTokens.add("xoxb-good");
  fake.users = { U1: "ann" };
  fake.channels = { C1: "eng" };
  process.env.SOLOAGENT_SLACK_API_URL = fake.apiUrl;
  const env = await open();
  const connector = await connect(env.solo, { kind: "slack", config: { botToken, appToken: "xapp-1-test" } });
  return {
    ...env,
    fake,
    connector,
    cleanup: async () => {
      await env.cleanup();
      await fake.close();
      delete process.env.SOLOAGENT_SLACK_API_URL;
    },
  };
}

/** Texts the bot posted or updated into a channel (and thread), in order. */
function slackTexts(fake: FakeSlack, channel: string, threadTs?: string): string[] {
  const posted = new Map<string, string>();
  for (const call of fake.calls) {
    if (call.method === "chat.postMessage" && call.params.channel === channel && call.params.thread_ts === threadTs) posted.set(`post${posted.size}`, String(call.params.text));
    if (call.method === "chat.update" && call.params.channel === channel) posted.set(`update${posted.size}`, String(call.params.text));
  }
  return [...posted.values()];
}

test("slack: an app_mention over Socket Mode is answered in its thread, and the envelope is acked", async () => {
  const { solo, fake, connector, answer, cleanup } = await slack();
  try {
    assert.equal(connector.status, "connected");
    assert.equal(connector.identity, "@solo in Acme");
    assert.ok(fake.connected);
    answer("Build is **green**");
    const ts = fake.ts();
    const envelope = await fake.event({ type: "app_mention", user: "U1", text: "<@UBOT> how is the build?", ts, channel: "C1" });
    assert.ok(fake.acks.includes(envelope));
    await until(() => slackTexts(fake, "C1", ts).includes("Build is *green*"), "the answer");
    const [placeholder] = fake.callsTo("chat.postMessage");
    assert.equal(placeholder!.thread_ts, ts);
    assert.match(String(placeholder!.text), /thinking/);
    assert.ok(fake.callsTo("chat.update").some((u) => u.text === "Build is *green*" && u.ts !== undefined));

    const [thread] = solo.listThreads({ source: "slack" });
    assert.equal(thread?.location, "#eng");
    const { messages } = await solo.messages(thread!.id);
    const user = messages.find((m) => m.kind === "user");
    assert.equal(user?.kind === "user" && user.text, "how is the build?");
    assert.equal(user?.kind === "user" && user.author.name, "ann");
  } finally {
    await cleanup();
  }
});

test("slack: a direct message is answered in the DM; other channel messages are ignored", async () => {
  const { solo, fake, answer, cleanup } = await slack();
  try {
    await fake.event({ type: "message", channel_type: "channel", user: "U1", text: "chatter", ts: fake.ts(), channel: "C1" });
    answer("hi from the DM");
    await fake.event({ type: "message", channel_type: "im", user: "U1", text: "hello", ts: fake.ts(), channel: "D1" });
    await until(() => slackTexts(fake, "D1").includes("hi from the DM"), "the DM answer");
    const threads = solo.listThreads({ source: "slack" });
    assert.equal(threads.length, 1);
    assert.equal(threads[0]!.location, "DM with ann");
  } finally {
    await cleanup();
  }
});

test("slack: a bad bot token puts the connector in error without crashing", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  const { solo, fake, connector, cleanup } = await slack("xoxb-revoked");
  try {
    assert.equal(connector.status, "error");
    assert.match(connector.statusDetail ?? "", /invalid_auth/);
    assert.equal(fake.connected, false, "no socket was opened");
    assert.ok(solo.recentActivity().some((a) => a.type === "error" && /invalid_auth/.test(a.text)));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
    await cleanup();
  }
});

// ───────────────────────────── Discord ─────────────────────────────

test("discord: messages map to InboundMessage only for DMs, mentions, and replies to the bot", () => {
  const bot = "BOT1";
  const ann = { id: "U1", username: "ann", globalName: "Ann" };

  const dm = discordInbound(stubMessage({ dm: true, author: ann, content: "hello", id: "M9" }), bot, false)!;
  assert.deepEqual(
    { externalKey: dm.externalKey, location: dm.location, title: dm.title, text: dm.text, target: dm.target, isDirect: dm.isDirect, channel: dm.channel },
    { externalKey: "DM1", location: "DM with Ann", title: "DM with Ann", text: "hello", target: { channelId: "DM1", replyTo: "M9" }, isDirect: true, channel: undefined },
  );
  assert.deepEqual(dm.author, { name: "Ann", id: "U1", source: "discord", avatarUrl: "https://cdn.example/U1.png" });

  const mention = discordInbound(stubMessage({ author: ann, memberName: "Ann (eng)", content: "<@BOT1> deploy <@!BOT1> now", mentions: [bot] }), bot, false)!;
  assert.equal(mention.text, "deploy  now");
  assert.equal(mention.location, "Acme #eng");
  assert.equal(mention.title, "#eng · deploy  now");
  assert.equal(mention.author.name, "Ann (eng)");
  assert.deepEqual(mention.channel, { id: "C1", name: "#eng", parent: undefined });

  const inThread = discordInbound(
    stubMessage({ author: ann, content: "<@BOT1> hi", mentions: [bot], channelId: "T7", channelName: "release", parent: { id: "C1", name: "eng" } }),
    bot,
    false,
  )!;
  assert.deepEqual(inThread.channel, { id: "T7", name: "#release", parent: { id: "C1", name: "#eng" } });

  assert.equal(discordInbound(stubMessage({ author: ann, content: "just chatting" }), bot, false), undefined);
  assert.equal(discordInbound(stubMessage({ author: ann, content: "replying", reference: "M1" }), bot, true)?.text, "replying");
  assert.equal(discordInbound(stubMessage({ dm: true, author: { ...ann, bot: true }, content: "beep" }), bot, false), undefined);

  const withFile = discordInbound(
    stubMessage({ dm: true, author: ann, content: "see file", attachments: [{ name: "log.txt", contentType: null, size: 12, url: "https://cdn.example/log.txt" }] }),
    bot,
    false,
  )!;
  assert.deepEqual(withFile.attachments, [{ name: "log.txt", mimeType: "", size: 12, url: "https://cdn.example/log.txt" }]);
});

test("discord: replies thread under the message and never ping", () => {
  assert.deepEqual(discordReply({ channelId: "C1", replyTo: "M1" }, "hi"), {
    content: "hi",
    reply: { messageReference: "M1", failIfNotExists: false },
    allowedMentions: { repliedUser: false, parse: [] },
  });
  assert.equal(discordReply({ channelId: "C1" }, "hi").reply, undefined);
});

test("discord: a long answer is split into messages under Discord's 2000 character limit", async () => {
  const stub = new StubDiscordClient();
  const original = DRIVERS.discord;
  DRIVERS.discord = (config, host) => createDiscordDriver(config, host, () => stub.asClient());
  const { solo, answer, cleanup } = await open();
  try {
    const connector = await connect(solo, { kind: "discord", config: { botToken: "discord-token" } });
    assert.equal(connector.status, "connected");
    assert.equal(connector.identity, "Solo#0001");
    const paragraphs = Array.from({ length: 9 }, (_, i) => `Paragraph ${i + 1}. ${"lorem ipsum ".repeat(40).trim()}`);
    const long = paragraphs.join("\n\n");
    assert.ok(long.length > 4_000);
    answer(long);

    // Unaddressed server chatter is ignored; the mention is answered.
    stub.emit(Events.MessageCreate, stubMessage({ content: "nobody asked", id: "M0" }));
    stub.emit(Events.MessageCreate, stubMessage({ content: "<@BOT1> write a lot", mentions: ["BOT1"], id: "M1" }));
    await until(() => stub.contents("C1").join("\n\n").includes("Paragraph 9."), "the whole answer", 8_000);

    const sent = stub.contents("C1");
    assert.ok(sent.length >= 3, `split into ${sent.length} messages`);
    for (const content of sent) assert.ok(content.length <= 2_000, `message of ${content.length} chars`);
    assert.equal(sent.join("\n\n").replace(/\s+/g, " "), long.replace(/\s+/g, " "), "nothing lost or duplicated");
    assert.equal(stub.sent[0]!.reply?.messageReference, "M1", "the first part replies to the question");
    assert.ok(stub.edits.length >= 1, "the placeholder was edited into the first part");
    assert.ok(stub.typing >= 1);
    assert.equal(solo.listThreads({ source: "discord" }).length, 1);
  } finally {
    await cleanup();
    DRIVERS.discord = original;
  }
  assert.ok(stub.destroyed, "closing soloagent destroys the client");
});

// ───────────────────────────── Webhook ─────────────────────────────

test("webhook over HTTP: secret checks, a synchronous answer, and a callback_url delivery", async () => {
  const { solo, answer, cleanup } = await open();
  const received: { secret?: string; body: Record<string, unknown> }[] = [];
  const callback = await listen(async (req, res) => {
    received.push({ secret: String(req.headers["x-solo-secret"]), body: await readBody(req) });
    res.end("ok");
  });
  try {
    const app = createApp({ solo });
    const hook = await connect(solo, { kind: "webhook", config: { secret: "s3cret" } });
    assert.equal(hook.status, "connected");
    const post = (id: string, secret: string, body: unknown) =>
      app.request(`/api/hooks/${id}`, { method: "POST", headers: { "content-type": "application/json", "x-solo-secret": secret }, body: JSON.stringify(body) });

    assert.equal((await post("web_nope", "s3cret", { text: "hi" })).status, 404);
    assert.equal((await post(hook.id, "wrong", { text: "hi" })).status, 401);
    assert.equal((await post(hook.id, "s3cret", {})).status, 400);

    answer("all green");
    const sync = await post(hook.id, "s3cret", { text: "status?", thread: "ci", user: "ci-bot" });
    assert.equal(sync.status, 200);
    assert.deepEqual(await sync.json(), { thread: "ci", status: "done", answer: "all green" });

    answer("will call you back");
    const async = await post(hook.id, "s3cret", { text: "deploy?", thread: "cd", callback_url: `http://127.0.0.1:${callback.port}/done` });
    assert.equal(async.status, 202);
    assert.deepEqual(await async.json(), { accepted: true, thread: "cd" });
    await until(() => received[0], "the callback");
    assert.deepEqual(received, [{ secret: "s3cret", body: { thread: "cd", text: "will call you back" } }]);
    assert.equal(solo.listThreads({ source: "webhook" }).length, 2);
  } finally {
    await cleanup();
    await callback.close();
  }
});
