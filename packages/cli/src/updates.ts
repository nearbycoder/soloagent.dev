import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareSemver, fetchLatestRelease } from "@soloagent/client";
import { soloHome } from "./config.ts";

/** ~/.soloagent/update-check.json: the newest release seen, refreshed at most once a day. */
type Cache = { latest?: string; url?: string; checkedAt: number };

const DAY = 24 * 60 * 60 * 1000;
const file = () => join(soloHome(), "update-check.json");

export function updateChecksEnabled(): boolean {
  return !/^(0|false|off|no)$/i.test(process.env.SOLOAGENT_UPDATE_CHECK ?? "");
}

function read(): Cache | undefined {
  try {
    const cache = JSON.parse(readFileSync(file(), "utf8")) as Cache;
    return typeof cache.checkedAt === "number" ? cache : undefined;
  } catch {
    return undefined;
  }
}

function write(cache: Cache) {
  try {
    mkdirSync(soloHome(), { recursive: true });
    writeFileSync(file(), `${JSON.stringify(cache)}\n`);
  } catch {
    // a cache is a convenience
  }
}

/** The newer release this CLI knows about, from the cache only (no network). Nothing when checks are off. */
export function knownUpdate(current: string): { latest: string; url: string } | undefined {
  if (!updateChecksEnabled()) return undefined;
  const cache = read();
  if (!cache?.latest || compareSemver(cache.latest, current) <= 0) return undefined;
  return { latest: cache.latest, url: cache.url ?? "https://github.com/nearbycoder/soloagent.dev/releases" };
}

/**
 * Refresh the cache when it is more than a day old. A failed check is retried after an hour rather
 * than on every run. Resolves quickly: the request is capped at `timeoutMs`, and errors are swallowed.
 */
export async function refreshUpdateCache(options: { timeoutMs?: number } = {}): Promise<void> {
  if (!updateChecksEnabled()) return;
  const cache = read();
  if (cache && Date.now() - cache.checkedAt < DAY) return;
  try {
    const release = await fetchLatestRelease({ timeoutMs: options.timeoutMs ?? 1500 });
    write({ latest: release.version, url: release.url, checkedAt: Date.now() });
  } catch {
    write({ latest: cache?.latest, url: cache?.url, checkedAt: Date.now() - DAY + 60 * 60 * 1000 });
  }
}
