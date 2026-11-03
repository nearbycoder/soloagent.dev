#!/usr/bin/env node
import { startServer } from "./server.ts";

const dataDir = process.env.SOLOAGENT_DATA_DIR ?? (process.env.RAILWAY_VOLUME_MOUNT_PATH || "./.data");
const port = Number(process.env.PORT ?? 7420);

const server = await startServer({ dataDir, port });
const publicUrl = process.env.SOLOAGENT_PUBLIC_URL ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : server.url);

console.log(`
  soloagent is up — ${publicUrl}
    data      ${dataDir}
    token     ${process.env.SOLOAGENT_TOKEN ? "(from SOLOAGENT_TOKEN)" : server.solo.adminToken}
    terminal  soloagent connect ${publicUrl} --token <token>
`);

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log("\n  ✦ shutting down — durable work resumes on next start");
    await server.close().catch(() => {});
    process.exit(0);
  });
}
