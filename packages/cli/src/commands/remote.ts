import { SoloApiError, SoloClient } from "@soloagent/client";
import { clearConfig, loadConfig, paths, saveConfig } from "../config.ts";
import { out, paint } from "../style.ts";

/** `soloagent connect <url> --token <t>`: validate and remember a remote server. */
export async function connect(url: string | undefined, token: string | undefined) {
  const p = paint();
  if (!url) throw new Error("Usage: soloagent connect <url> --token <token>");
  const base = /^https?:\/\//.test(url) ? url : `${/^(localhost|127\.|\[::1\])/.test(url) ? "http" : "https"}://${url}`;
  const resolvedToken = token ?? process.env.SOLOAGENT_TOKEN;
  if (!resolvedToken) throw new Error("A token is required: soloagent connect <url> --token <token>");
  const client = new SoloClient({ baseUrl: base, token: resolvedToken });
  let version: string;
  try {
    version = (await client.me()).version;
  } catch (error) {
    if (error instanceof SoloApiError && error.status === 401) throw new Error(`The token was rejected by ${base}`);
    throw new Error(`Could not reach ${base}: ${error instanceof Error ? error.message : String(error)}`);
  }
  saveConfig({ url: client.baseUrl, token: resolvedToken });
  out(`${p.green("✓")} Connected to ${p.cyan(client.baseUrl)} ${p.dim(`(soloagent ${version})`)}`);
  out(p.dim(`  Saved to ${paths.config}. Run ${p.bold("soloagent")} to open the terminal UI.`));
}

export async function disconnect() {
  const p = paint();
  const previous = loadConfig().url;
  if (!clearConfig()) {
    out(p.dim("Not connected to a remote server. soloagent runs locally."));
    return;
  }
  out(`${p.green("✓")} Disconnected${previous ? ` from ${p.cyan(previous)}` : ""}. soloagent now runs locally.`);
}
