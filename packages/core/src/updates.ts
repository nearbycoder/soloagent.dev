import { compareSemver, fetchLatestRelease, type VersionInfo } from "@soloagent/client";

const SETTING = "update_check";
const TWELVE_HOURS = 12 * 60 * 60 * 1000;

type Cached = { latest: string; url: string; checkedAt: number };
type Settings = { setting(key: string): string | undefined; setSetting(key: string, value: string): void };

export type UpdateCheckerOptions = {
  current: string;
  /** Where the last result is cached (soloagent's settings table). */
  settings: Settings;
  /** False disables network checks; cached results are still reported. Default: SOLOAGENT_UPDATE_CHECK !== "0". */
  enabled?: boolean;
  fetch?: typeof fetch;
  intervalMs?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
};

/** True unless SOLOAGENT_UPDATE_CHECK is "0", "false", "off", or "no". */
export function updateCheckEnabled(env = process.env): boolean {
  return !/^(0|false|off|no)$/i.test(env.SOLOAGENT_UPDATE_CHECK ?? "");
}

/**
 * Asks GitHub for the latest release at startup and every 12 hours. Never throws and never blocks:
 * a failed or slow check just leaves the last cached answer in place.
 */
export class UpdateChecker {
  readonly current: string;
  readonly enabled: boolean;
  #settings: Settings;
  #fetch: typeof fetch | undefined;
  #intervalMs: number;
  #timeoutMs: number;
  #log: (message: string) => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  #inflight: Promise<VersionInfo> | undefined;
  #failures = 0;

  constructor(options: UpdateCheckerOptions) {
    this.current = options.current;
    this.enabled = options.enabled ?? updateCheckEnabled();
    this.#settings = options.settings;
    this.#fetch = options.fetch;
    this.#intervalMs = options.intervalMs ?? TWELVE_HOURS;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#log = options.log ?? (() => {});
  }

  info(): VersionInfo {
    const cached = this.#cached();
    const latest = cached?.latest;
    return {
      current: this.current,
      latest,
      url: cached?.url,
      updateAvailable: latest ? compareSemver(latest, this.current) > 0 : false,
      checkedAt: cached?.checkedAt,
      enabled: this.enabled,
    };
  }

  /** Ask GitHub now. Resolves with the (possibly unchanged) info; never rejects. */
  check(): Promise<VersionInfo> {
    if (!this.enabled) return Promise.resolve(this.info());
    this.#inflight ??= (async () => {
      try {
        const release = await fetchLatestRelease({ fetch: this.#fetch, timeoutMs: this.#timeoutMs, userAgent: `soloagent/${this.current}` });
        this.#settings.setSetting(SETTING, JSON.stringify({ latest: release.version, url: release.url, checkedAt: Date.now() } satisfies Cached));
        const info = this.info();
        if (info.updateAvailable) this.#log(`soloagent ${info.latest} is available (running ${this.current}): ${info.url}`);
      } catch (error) {
        // Once per process: offline and air-gapped servers shouldn't fill their logs.
        if (this.#failures++ === 0) this.#log(`update check failed: ${(error as Error).message} (SOLOAGENT_UPDATE_CHECK=0 turns it off)`);
      } finally {
        this.#inflight = undefined;
      }
      return this.info();
    })();
    return this.#inflight;
  }

  /** Check in the background now (unless checked within the hour) and on an interval. Returns stop(). */
  start(): () => void {
    if (!this.enabled || this.#timer) return () => this.stop();
    const last = this.#cached()?.checkedAt ?? 0;
    if (Date.now() - last > 60 * 60 * 1000) void this.check();
    this.#timer = setInterval(() => void this.check(), this.#intervalMs);
    this.#timer.unref?.();
    return () => this.stop();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #cached(): Cached | undefined {
    try {
      const raw = this.#settings.setting(SETTING);
      const parsed = raw ? (JSON.parse(raw) as Cached) : undefined;
      return parsed?.latest ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}
