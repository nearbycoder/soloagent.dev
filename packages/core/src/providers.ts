import type { AuthPrompt, MutableModels, Provider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { LoginFlowState, ProviderInfo } from "@soloagent/client";
import { newId } from "./db.ts";
import type { SealedCredentialStore } from "./credentials.ts";

/** Subscriptions and popular APIs, shown first. */
const FEATURED = ["demo", "anthropic", "openai", "github-copilot", "google", "openrouter", "xai", "openai-codex", "groq", "mistral", "deepseek"];

/** Providers that only make sense in a test harness or need a desktop session. */
const HIDDEN = new Set(["typesafe", "faux"]);

export class ProviderHub {
  readonly models: MutableModels;
  #flows = new Map<string, LoginFlow>();
  #onFlow: (flow: LoginFlowState) => void;
  #credentials: SealedCredentialStore;

  constructor(credentials: SealedCredentialStore, onFlow: (flow: LoginFlowState) => void) {
    this.#credentials = credentials;
    this.models = builtinModels({ credentials });
    this.#onFlow = onFlow;
  }

  async list(): Promise<ProviderInfo[]> {
    const providers = this.models.getProviders().filter((p) => !HIDDEN.has(p.id));
    const infos = await Promise.all(providers.map((provider) => this.#info(provider)));
    return infos.sort((a, b) => {
      const fa = FEATURED.indexOf(a.id);
      const fb = FEATURED.indexOf(b.id);
      if (fa !== fb) return (fa === -1 ? 999 : fa) - (fb === -1 ? 999 : fb);
      return a.name.localeCompare(b.name);
    });
  }

  async configured(): Promise<ProviderInfo[]> {
    return (await this.list()).filter((p) => p.configured !== null);
  }

  async #info(provider: Provider): Promise<ProviderInfo> {
    let configured: ProviderInfo["configured"] = provider.id === "demo" ? { type: "api_key", source: "built-in" } : null;
    if (!configured) try {
      const check = await this.models.checkAuth(provider.id);
      if (check) configured = { type: check.type, source: check.source };
    } catch {
      configured = null;
    }
    const oauth = provider.auth.oauth;
    return {
      id: provider.id,
      name: provider.name,
      oauth: oauth ? { label: oauth.loginLabel ?? oauth.name, subscription: oauth.isSubscription === true } : null,
      apiKey: provider.auth.apiKey !== undefined,
      configured,
      featured: FEATURED.includes(provider.id),
      models: provider
        .getModels()
        .filter((m) => m.type === undefined || m.type === "chat")
        .map((m) => ({
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          vision: m.input.includes("image"),
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          cost: { input: m.cost.input, output: m.cost.output },
        })),
    };
  }

  async setApiKey(providerId: string, key: string) {
    if (!this.models.getProvider(providerId)) throw new Error(`Unknown provider ${providerId}`);
    await this.#credentials.modify(providerId, async () => ({ type: "api_key", key: key.trim() }));
  }

  async logout(providerId: string) {
    await this.models.logout(providerId);
  }

  /**
   * Start a provider-owned login. The flow runs on the server; the GUI or TUI renders its prompts
   * (auth URL, device code, paste-the-code box) and answers them through `answer()`.
   */
  startLogin(providerId: string, type: "oauth" | "api_key"): LoginFlowState {
    const provider = this.models.getProvider(providerId);
    if (!provider) throw new Error(`Unknown provider ${providerId}`);
    if (type === "oauth" && !provider.auth.oauth) throw new Error(`${provider.name} has no subscription login`);
    for (const flow of this.#flows.values()) if (flow.state.providerId === providerId && flow.active) flow.cancel();
    const flow = new LoginFlow(providerId, type, (state) => this.#onFlow(state));
    this.#flows.set(flow.state.id, flow);
    flow.run(this.models);
    return flow.snapshot();
  }

  flow(id: string): LoginFlowState | undefined {
    return this.#flows.get(id)?.snapshot();
  }

  answer(id: string, value: string): LoginFlowState {
    const flow = this.#flows.get(id);
    if (!flow) throw new Error("Login flow not found");
    flow.answer(value);
    return flow.snapshot();
  }

  cancel(id: string): LoginFlowState {
    const flow = this.#flows.get(id);
    if (!flow) throw new Error("Login flow not found");
    flow.cancel();
    return flow.snapshot();
  }
}

class LoginFlow {
  state: LoginFlowState;
  #abort = new AbortController();
  #pending: { resolve: (value: string) => void; reject: (error: Error) => void } | undefined;
  #emit: (state: LoginFlowState) => void;

  constructor(providerId: string, type: "oauth" | "api_key", emit: (state: LoginFlowState) => void) {
    this.state = { id: newId("login"), providerId, type, status: "running", log: [] };
    this.#emit = emit;
  }

  get active() {
    return this.state.status === "running" || this.state.status === "waiting";
  }

  snapshot(): LoginFlowState {
    return structuredClone(this.state);
  }

  #update(change: Partial<LoginFlowState>) {
    this.state = { ...this.state, ...change };
    this.#emit(this.snapshot());
  }

  run(models: MutableModels) {
    models
      .login(this.state.providerId, this.state.type, {
        signal: this.#abort.signal,
        prompt: (prompt) => this.#prompt(prompt),
        notify: (event) => {
          const at = Date.now();
          switch (event.type) {
            case "auth_url":
              this.#update({
                authUrl: { url: event.url, instructions: event.instructions },
                log: [...this.state.log, { at, message: event.instructions ?? "Open the sign-in page to continue." }],
              });
              break;
            case "device_code":
              this.#update({
                deviceCode: { userCode: event.userCode, verificationUri: event.verificationUri },
                log: [...this.state.log, { at, message: `Enter code ${event.userCode} at ${event.verificationUri}` }],
              });
              break;
            case "info":
              this.#update({ log: [...this.state.log, { at, message: event.message, links: event.links?.map((l) => ({ ...l })) }] });
              break;
            case "progress":
              this.#update({ log: [...this.state.log, { at, message: event.message }] });
              break;
          }
        },
      })
      .then(
        () => this.#update({ status: "done", prompt: undefined, log: [...this.state.log, { at: Date.now(), message: "Signed in." }] }),
        (error: unknown) => {
          if (this.state.status === "cancelled") return;
          this.#update({ status: "failed", prompt: undefined, error: error instanceof Error ? error.message : String(error) });
        },
      );
  }

  #prompt(prompt: AuthPrompt): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.#pending = { resolve, reject };
      const clear = () => {
        if (this.#pending?.resolve === resolve) {
          this.#pending = undefined;
          if (this.state.status === "waiting") this.#update({ status: "running", prompt: undefined });
        }
      };
      // A manual-code prompt races the provider's local callback server; when the server wins, the prompt is aborted.
      prompt.signal?.addEventListener("abort", () => {
        clear();
        reject(new Error("Prompt no longer needed"));
      });
      this.#update({
        status: "waiting",
        prompt: {
          type: prompt.type,
          message: prompt.message,
          placeholder: "placeholder" in prompt ? prompt.placeholder : undefined,
          options: prompt.type === "select" ? prompt.options.map((o) => ({ ...o })) : undefined,
        },
      });
    });
  }

  answer(value: string) {
    const pending = this.#pending;
    if (!pending) throw new Error("The login is not waiting for input");
    this.#pending = undefined;
    this.#update({ status: "running", prompt: undefined });
    pending.resolve(value);
  }

  cancel() {
    if (!this.active) return;
    this.#update({ status: "cancelled", prompt: undefined });
    this.#pending?.reject(new Error("Cancelled"));
    this.#abort.abort();
  }
}
