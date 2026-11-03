import { resolve } from "node:path";
import { clearRuntime, paths, saveRuntime } from "../config.ts";
import { out, paint } from "../style.ts";

export async function serve(options: { port?: string; data?: string; host?: string }) {
  const p = paint();
  const dataDir = resolve(options.data ?? process.env.SOLOAGENT_DATA_DIR ?? paths.data);
  const port = Number(options.port ?? process.env.PORT ?? 7420);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${options.port}`);

  const { startServer } = await import("@soloagent/server");
  const server = await startServer({ dataDir, port, host: options.host });
  const publicUrl = process.env.SOLOAGENT_PUBLIC_URL ?? server.url;
  const usesHomeData = dataDir === resolve(paths.data);
  if (usesHomeData) saveRuntime({ url: server.url, token: server.solo.adminToken, pid: process.pid, dataDir, startedAt: Date.now() });

  out();
  out(`  ${p.bold("soloagent")} is up — ${p.cyan(publicUrl)}`);
  out(`    ${p.dim("data     ")} ${dataDir}`);
  out(`    ${p.dim("token    ")} ${process.env.SOLOAGENT_TOKEN ? "(from SOLOAGENT_TOKEN)" : server.solo.adminToken}`);
  out(`    ${p.dim("web      ")} ${publicUrl}`);
  out(
    `    ${p.dim("terminal ")} ${usesHomeData ? "soloagent" : `soloagent --url ${publicUrl} --token <token>`}`,
  );
  out();

  let closing = false;
  await new Promise<void>((done) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, async () => {
        if (closing) process.exit(1);
        closing = true;
        out(`\n  shutting down — durable work resumes on next start`);
        clearRuntime();
        await server.close().catch(() => {});
        done();
      });
    }
  });
  process.exit(0);
}
