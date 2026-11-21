import type { ConnectorDriver, DriverFactory } from "./types.ts";

/**
 * Generic HTTP connector. Inbound messages arrive at `POST /api/hooks/:connectorId` (handled by the server);
 * replies go to the request's `callback_url`, or back in the HTTP response when the caller waits.
 */
export const webhookDriver: DriverFactory = (config, host): ConnectorDriver => ({
  maxLength: 100_000,

  async start() {
    if (!config.secret) throw new Error("A shared secret is required");
    host.status("connected", undefined, "POST /api/hooks/<id>");
  },

  async stop() {},

  async post(target, markdown) {
    if (!target.callbackUrl) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(target.callbackUrl);
    } catch {
      host.log(`webhook callback rejected invalid URL`);
      return undefined;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      host.log(`webhook callback rejected non-http(s) protocol ${parsed.protocol}`);
      return undefined;
    }
    const response = await fetch(parsed, {
      method: "POST",
      headers: { "content-type": "application/json", "x-solo-secret": config.secret ?? "" },
      body: JSON.stringify({ thread: target.thread, text: markdown }),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) host.log(`webhook callback ${parsed.origin}${parsed.pathname} answered ${response.status}`);
    return undefined;
  },
});
