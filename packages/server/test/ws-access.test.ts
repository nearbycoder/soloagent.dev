import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startServer, WS_ACCESS_CHANGED, WS_SESSION_ENDED } from "../src/server.ts";

/** Open a socket and wait for the server's hello. */
async function connect(url: string, credential: string) {
  const ws = new WebSocket(`${url.replace("http", "ws")}/api/ws?token=${encodeURIComponent(credential)}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("message", () => resolve());
    ws.once("error", reject);
  });
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  return { ws, closed };
}

test("WebSockets close when their credential stops working, and reconnect on a role change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "solo-ws-"));
  const server = await startServer({ dataDir: dir, secret: "test", connectors: false, demo: false, port: 0, host: "127.0.0.1", quiet: true, log: () => {}, updateCheck: false });
  try {
    const { solo, url } = server;
    const user = await solo.team.createUser({ name: "Mia", role: "member", password: "correct horse battery" });
    const other = await solo.team.createUser({ name: "Ann", role: "member", password: "correct horse battery" });

    // Role change: the socket asks the client to reconnect and reload permissions.
    const roleSession = solo.team.createSession(user.id).token;
    const promoted = await connect(url, roleSession);
    solo.team.updateUser(user.id, { role: "admin" });
    assert.equal(await promoted.closed, WS_ACCESS_CHANGED);
    // A rename alone keeps the socket open.
    const renamed = await connect(url, roleSession);
    solo.team.updateUser(user.id, { name: "Mia R" });
    assert.equal(renamed.ws.readyState, WebSocket.OPEN);
    renamed.ws.close();

    // Removing a user ends their sockets; other people's stay open.
    const annSocket = await connect(url, solo.team.createSession(other.id).token);
    const removed = await connect(url, solo.team.createSession(user.id).token);
    solo.team.deleteUser(user.id);
    assert.equal(await removed.closed, WS_SESSION_ENDED);
    assert.equal(annSocket.ws.readyState, WebSocket.OPEN);
    annSocket.ws.close();

    // Rotating the admin token ends sockets that used the old one.
    const admin = await connect(url, solo.adminToken);
    solo.rotateAdminToken();
    assert.equal(await admin.closed, WS_SESSION_ENDED);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
