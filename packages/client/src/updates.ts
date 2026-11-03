/**
 * Semantic version comparison and the GitHub "latest release" check. Dependency-free and
 * environment-agnostic, shared by the server (upgrade notices) and the CLI (`--version`).
 */

export const RELEASES_API = "https://api.github.com/repos/nearbycoder/soloagent.dev/releases/latest";
export const RELEASES_URL = "https://github.com/nearbycoder/soloagent.dev/releases";

export type SemVer = { major: number; minor: number; patch: number; prerelease: (string | number)[] };

/** Parse "1.2.3", "v1.2.3", or "1.2.3-beta.1+build". Returns undefined for anything else. */
export function parseSemver(input: string): SemVer | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (!match) return undefined;
  const prerelease = match[4] ? match[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

/**
 * Compare two versions by semver precedence: -1 when a < b, 0 when equal, 1 when a > b.
 * Build metadata is ignored; a prerelease sorts before its release. Unparseable versions sort lowest.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (!va || !vb) return va ? 1 : vb ? -1 : 0;
  for (const key of ["major", "minor", "patch"] as const) {
    if (va[key] !== vb[key]) return va[key] < vb[key] ? -1 : 1;
  }
  const pa = va.prerelease;
  const pb = vb.prerelease;
  if (pa.length === 0 || pb.length === 0) return pa.length === pb.length ? 0 : pa.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    // Numeric identifiers have lower precedence than alphanumeric ones.
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export type LatestRelease = { version: string; url: string };

/**
 * Ask GitHub for the latest published release. Drafts and prereleases are excluded by that endpoint.
 * Throws on network errors, timeouts, and unexpected responses; callers decide how quiet to be.
 */
export async function fetchLatestRelease(options: { fetch?: typeof fetch; timeoutMs?: number; userAgent?: string } = {}): Promise<LatestRelease> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const response = await doFetch(RELEASES_API, {
    headers: { accept: "application/vnd.github+json", "user-agent": options.userAgent ?? "soloagent-update-check" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
  const tag = typeof body.tag_name === "string" ? body.tag_name : "";
  const version = parseSemver(tag) ? tag.replace(/^v/, "") : undefined;
  if (!version) throw new Error(`Unrecognized release tag "${tag}"`);
  return { version, url: typeof body.html_url === "string" ? body.html_url : `${RELEASES_URL}/tag/v${version}` };
}
