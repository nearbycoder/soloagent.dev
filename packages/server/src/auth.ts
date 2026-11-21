import { createHash, timingSafeEqual } from "node:crypto";
import type { Context as HonoContext, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { SoloAgent } from "@soloagent/core";
import type { Actor } from "@soloagent/client";

/**
 * Who is calling. The admin token is the superuser (CLI, API, and the dashboard's token login);
 * people sign in with a name and password and get a session cookie.
 */
export type { Actor };

export type AuthEnv = { Variables: { actor: Actor } };

export const COOKIE = "solo_session";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given || !expected) return false;
  return timingSafeEqual(sha256(expected), sha256(given));
}

/** A bearer token or the session cookie. Query-string tokens are accepted only on the WebSocket upgrade. */
export function requestToken(c: HonoContext): string | undefined {
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  return getCookie(c, COOKIE) ?? undefined;
}

/** Resolve a credential (admin token or user session token) to an actor. */
export function authenticate(solo: SoloAgent, credential: string | undefined): Actor | undefined {
  if (!credential) return undefined;
  if (tokenMatches(solo.adminToken, credential)) return { kind: "token", name: "Admin", role: "admin" };
  const user = solo.team.sessionUser(credential);
  return user ? { kind: "user", userId: user.id, name: user.name, role: user.role } : undefined;
}

/** The actor of an authenticated request, for attributing actions. Throws outside authenticated routes. */
export function actorOf(c: HonoContext): Actor {
  const actor = (c as HonoContext<AuthEnv>).get("actor");
  if (!actor) throw new Error("actorOf() used on a route without authentication");
  return actor;
}

/** 401 without a valid credential; sets the actor for everything after it. */
export function requireAuth(solo: SoloAgent): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const actor = authenticate(solo, requestToken(c));
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    c.set("actor", actor);
    await next();
  };
}

/** 403 unless the actor is an admin (the admin token, or a user with the admin role). */
export const adminOnly: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (actorOf(c).role !== "admin") return c.json({ error: "Only admins can do that. Ask an admin on your team." }, 403);
  await next();
};

/** Failed password or token sign-ins per key, so a guessing script slows to a crawl. */
export class LoginThrottle {
  #failures = new Map<string, { count: number; first: number }>();
  readonly max: number;
  readonly windowMs: number;
  readonly maxEntries: number;

  constructor(max = 10, windowMs = 15 * 60_000, maxEntries = 10_000) {
    this.max = max;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
  }

  blocked(key: string): boolean {
    const k = key.toLowerCase();
    const entry = this.#failures.get(k);
    if (!entry) return false;
    if (Date.now() - entry.first > this.windowMs) {
      this.#failures.delete(k);
      return false;
    }
    return entry.count >= this.max;
  }

  fail(key: string) {
    const k = key.toLowerCase();
    const now = Date.now();
    const entry = this.#failures.get(k);
    if (!entry || now - entry.first > this.windowMs) {
      this.#prune(now);
      this.#failures.set(k, { count: 1, first: now });
    } else {
      entry.count++;
    }
  }

  clear(key: string) {
    this.#failures.delete(key.toLowerCase());
  }

  #prune(now: number) {
    if (this.#failures.size < this.maxEntries) return;
    for (const [k, entry] of this.#failures) {
      if (now - entry.first > this.windowMs) this.#failures.delete(k);
    }
    while (this.#failures.size >= this.maxEntries) {
      const oldest = this.#failures.keys().next().value;
      if (oldest === undefined) break;
      this.#failures.delete(oldest);
    }
  }
}
