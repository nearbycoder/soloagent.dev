import type { LoginFlowState, ProviderInfo } from "@soloagent/client";
import type { Connection } from "../connect.ts";
import { err, out, paint } from "../style.ts";
import { ask, askSecret, choose, openBrowser } from "./prompt.ts";

export function sortProviders(list: ProviderInfo[]): ProviderInfo[] {
  const rank = (p: ProviderInfo) => (p.oauth?.subscription ? 0 : p.oauth ? 1 : 2) * 2 + (p.featured ? 0 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function findProvider(list: ProviderInfo[], ref: string): ProviderInfo | undefined {
  const needle = ref.toLowerCase();
  return list.find((p) => p.id === needle) ?? list.find((p) => p.name.toLowerCase() === needle) ?? list.find((p) => p.id.startsWith(needle));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** `soloagent login [provider] [--key]`: subscription sign-in or API key, right in the terminal. */
export async function login(connection: Connection, providerRef: string | undefined, options: { key?: boolean }): Promise<number> {
  const p = paint(process.stderr);
  const { client } = connection;
  const providers = (await client.providers()).filter((pr) => pr.id !== "demo");

  let provider: ProviderInfo | undefined;
  if (providerRef) {
    provider = findProvider(providers, providerRef);
    if (!provider) throw new Error(`Unknown provider "${providerRef}". Try: ${providers.slice(0, 8).map((pr) => pr.id).join(", ")}, …`);
  } else {
    if (!process.stdin.isTTY) throw new Error("Name a provider: soloagent login <provider>");
    const candidates = sortProviders(options.key ? providers.filter((pr) => pr.apiKey) : providers.filter((pr) => pr.oauth));
    const picked = await choose(
      options.key ? "Set an API key for…" : "Sign in with…",
      candidates.map((pr) => ({
        value: pr.id,
        label: `${pr.configured ? "✓ " : "  "}${pr.name}`,
        description: options.key ? pr.id : (pr.oauth?.label ?? pr.id),
      })),
    );
    if (!picked) return 130;
    provider = candidates.find((pr) => pr.id === picked)!;
  }

  if (options.key || !provider.oauth) {
    if (!provider.apiKey) throw new Error(`${provider.name} does not take an API key`);
    const key = process.stdin.isTTY ? await askSecret(`${p.bold(provider.name)} API key: `) : await readStdin();
    if (!key.trim()) throw new Error("No key entered");
    await client.setApiKey(provider.id, key.trim());
    out(`${p.green("✓")} Saved the ${provider.name} API key.`);
    return 0;
  }

  return oauth(connection, provider);
}

async function oauth(connection: Connection, provider: ProviderInfo): Promise<number> {
  const p = paint(process.stderr);
  const { client } = connection;
  const stream = client.connect();
  err(`${p.accent("✦")} Signing in to ${p.bold(provider.name)}${provider.oauth ? p.dim(` · ${provider.oauth.label}`) : ""}`);

  let flow = await client.startLogin(provider.id, "oauth");
  const flowId = flow.id;
  let shownUrl = false;
  let shownCode = false;
  let logIndex = 0;
  let prompt: { key: string; abort: AbortController } | undefined;

  const result = new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      prompt?.abort.abort();
      clearInterval(poll);
      stream.close();
      resolve(code);
    };

    const handle = (next: LoginFlowState) => {
      if (next.id !== flowId || settled) return;
      flow = next;
      if (flow.authUrl && !shownUrl) {
        shownUrl = true;
        const opened = openBrowser(flow.authUrl.url);
        err("");
        err(`  ${opened ? "Your browser should open. If it does not, visit:" : "Open this URL to sign in:"}`);
        err(`  ${p.cyan(flow.authUrl.url)}`);
        if (flow.authUrl.instructions) err(`  ${p.dim(flow.authUrl.instructions)}`);
        err("");
      }
      if (flow.deviceCode && !shownCode) {
        shownCode = true;
        openBrowser(flow.deviceCode.verificationUri);
        err("");
        err(`  Enter this code at ${p.cyan(flow.deviceCode.verificationUri)}`);
        err(`      ${p.bold(p.accent(flow.deviceCode.userCode.split("").join(" ")))}`);
        err("");
      }
      for (; logIndex < flow.log.length; logIndex++) {
        const entry = flow.log[logIndex]!;
        if (shownUrl && entry.message === flow.authUrl?.instructions) continue;
        if (shownCode && flow.deviceCode && entry.message.includes(flow.deviceCode.userCode)) continue;
        err(p.dim(`  · ${entry.message}`));
        for (const link of entry.links ?? []) err(p.dim(`    ${link.label ? `${link.label}: ` : ""}${link.url}`));
      }
      if (flow.status === "done") {
        out(`${p.green("✓")} Signed in to ${provider.name}. Your agents can use it now.`);
        return finish(0);
      }
      if (flow.status === "failed") {
        err(`${p.red("✗")} Sign-in failed: ${flow.error ?? "unknown error"}`);
        return finish(1);
      }
      if (flow.status === "cancelled") {
        err(p.dim("Sign-in cancelled."));
        return finish(130);
      }
      const key = flow.status === "waiting" && flow.prompt ? `${flow.prompt.type}:${flow.prompt.message}` : undefined;
      if (prompt && prompt.key !== key) {
        prompt.abort.abort();
        prompt = undefined;
      }
      if (key && !prompt && flow.prompt) {
        const abort = new AbortController();
        prompt = { key, abort };
        void answer(flow, abort.signal).then(
          async (value) => {
            if (prompt?.abort === abort) prompt = undefined;
            try {
              handle(await client.answerLogin(flowId, value));
            } catch (error) {
              err(`${p.red("✗")} ${error instanceof Error ? error.message : String(error)}`);
            }
          },
          () => {
            if (prompt?.abort === abort) prompt = undefined;
          },
        );
      }
    };

    stream.on((event) => {
      if (event.type === "login.updated") handle(event.flow);
    });
    // The stream may miss updates while it connects; polling closes the gap.
    const poll = setInterval(() => void client.loginFlow(flowId).then(handle, () => {}), 1500);
    process.once("SIGINT", () => {
      void client.cancelLogin(flowId).catch(() => {});
      err(p.dim("\nSign-in cancelled."));
      finish(130);
    });
    handle(flow);
  });

  return result;
}

async function answer(flow: LoginFlowState, signal: AbortSignal): Promise<string> {
  const p = paint(process.stderr);
  const prompt = flow.prompt!;
  switch (prompt.type) {
    case "select": {
      const options = prompt.options ?? [];
      err(`  ${prompt.message}`);
      options.forEach((o, i) => err(`   ${p.accent(String(i + 1))}. ${o.label}${o.description ? p.dim(` — ${o.description}`) : ""}`));
      const value = await ask(`  ${p.bold("›")} `, signal);
      const index = Number(value) - 1;
      return options[index]?.id ?? value.trim();
    }
    case "secret":
      return askSecret(`  ${prompt.message} `, signal);
    case "manual_code":
      return ask(`  ${prompt.message || "Paste the code or redirect URL"}${prompt.placeholder ? p.dim(` (${prompt.placeholder})`) : ""}\n  ${p.bold("›")} `, signal);
    default:
      return ask(`  ${prompt.message}${prompt.placeholder ? p.dim(` (${prompt.placeholder})`) : ""} `, signal);
  }
}
