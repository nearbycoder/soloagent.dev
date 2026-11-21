import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { SoloAgent } from "@soloagent/core";
import { createApp } from "../src/app.ts";
import { LoginThrottle, tokenMatches } from "../src/auth.ts";
import { startServer } from "../src/server.ts";

test("tokenMatches and LoginThrottle: constant-time check and bounded throttle table", () => {
  assert.equal(tokenMatches("secret-token", "secret-token"), true);
  assert.equal(tokenMatches("secret-token", "secret-token-longer"), false);
  assert.equal(tokenMatches("secret-token", "short"), false);
  assert.equal(tokenMatches("secret-token", ""), false);
  assert.equal(tokenMatches("secret-token", undefined), false);

  const throttle = new LoginThrottle(2, 60_000, 3);
  throttle.fail("u1");
  throttle.fail("u1");
  assert.equal(throttle.blocked("u1"), true);
  // Adding more distinct keys evicts the oldest once maxEntries is reached.
  throttle.fail("u2");
  throttle.fail("u3");
  throttle.fail("u4");
  assert.equal(throttle.blocked("u1"), false);
  throttle.clear("u2");
  assert.equal(throttle.blocked("u2"), false);
});

test("HTTP hardening: security headers, Cache-Control, body limits, token throttle, and publicOrigin sanitization", async () => {
  const dir = mkdtempSync(join(tmpdir(), "solo-sec-"));
  const solo = await SoloAgent.open({ dataDir: dir, secret: "test", adminToken: "admin-secret", connectors: false, demo: false, log: () => {} });
  try {
    const app = createApp({ solo });

    // Security headers on HTML root.
    const root = await app.request("/");
    assert.equal(root.status, 200);
    assert.equal(root.headers.get("x-content-type-options"), "nosniff");
    assert.equal(root.headers.get("x-frame-options"), "DENY");
    assert.equal(root.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.ok(root.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));

    // API responses set Cache-Control: no-store by default.
    const me = await app.request("/api/me", { headers: { authorization: "Bearer admin-secret" } });
    assert.equal(me.status, 200);
    assert.equal(me.headers.get("cache-control"), "no-store");

    // Stored files keep immutable caching and sandboxed CSP.
    const ref = solo.files.put(Buffer.from("hello"), { name: "hello.txt", mimeType: "text/plain" });
    const fileRes = await app.request(`/api/files/${ref.sha256}`, { headers: { authorization: "Bearer admin-secret" } });
    assert.equal(fileRes.status, 200);
    assert.match(fileRes.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(fileRes.headers.get("content-security-policy"), "default-src 'none'; sandbox");

    // Body limit: /api/session caps at 16 KiB.
    const bigSession = await app.request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "x".repeat(20 * 1024) }),
    });
    assert.equal(bigSession.status, 413);

    // Token brute-force throttle on /api/session.
    for (let i = 0; i < 20; i++) {
      const res = await app.request("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.99" },
        body: JSON.stringify({ token: "wrong" }),
      });
      assert.equal(res.status, 401);
    }
    const throttled = await app.request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.99" },
      body: JSON.stringify({ token: "admin-secret" }),
    });
    assert.equal(throttled.status, 429);

    // publicOrigin rejects invalid x-forwarded-proto and x-forwarded-host injection.
    const inviteRes = await app.request("/api/invites", {
      method: "POST",
      headers: {
        authorization: "Bearer admin-secret",
        "content-type": "application/json",
        "x-forwarded-proto": "javascript",
        "x-forwarded-host": "evil.example/phish?x=1",
      },
      body: JSON.stringify({ role: "member", name: "Bob" }),
    });
    assert.equal(inviteRes.status, 201);
    const invite = (await inviteRes.json()) as { url: string };
    assert.match(invite.url, /^http:\/\/localhost\/invite\//);
  } finally {
    await solo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WebSocket hardening: malformed cookie, CSWSH cross-origin rejection, and maxPayload enforcement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "solo-ws-sec-"));
  const server = await startServer({ dataDir: dir, secret: "test", adminToken: "admin-secret", connectors: false, demo: false, port: 0, host: "127.0.0.1", quiet: true, log: () => {}, updateCheck: false });
  try {
    const wsUrl = `${server.url.replace("http", "ws")}/api/ws`;

    // Malformed percent-encoding in cookie returns 401 cleanly instead of crashing the server.
    const badCookieStatus = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: { cookie: "solo_session=%E0%A4%A" } });
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("open", () => {
        ws.close();
        reject(new Error("should not open"));
      });
    });
    assert.equal(badCookieStatus, 401);

    // Cross-site Origin on a cookie-authenticated upgrade is rejected with 403 (CSWSH).
    const cswshStatus = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: {
          cookie: `solo_session=${encodeURIComponent("admin-secret")}`,
          origin: "https://evil.example",
        },
      });
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("open", () => {
        ws.close();
        reject(new Error("should not open"));
      });
    });
    assert.equal(cswshStatus, 403);

    // Same-origin cookie upgrade succeeds, and sending a >64 KiB frame closes the connection.
    const ws = new WebSocket(wsUrl, {
      headers: {
        cookie: `solo_session=${encodeURIComponent("admin-secret")}`,
        origin: server.url,
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("message", () => resolve());
      ws.once("error", reject);
    });
    ws.on("error", () => {});
    const closeCode = await new Promise<number>((resolve) => {
      ws.once("close", (code) => resolve(code));
      ws.send(JSON.stringify({ type: "ping", pad: "a".repeat(80 * 1024) }));
    });
    assert.equal(closeCode, 1009); // Message Too Big
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
