// A tiny MCP server over stdio for the tests: newline-delimited JSON-RPC with initialize, tools/list, and tools/call.
// EXTRA_TOOLS=<n> adds n filler tools, to exercise deferred tool sets.
import { createInterface } from "node:readline";

const extra = Number(process.env.EXTRA_TOOLS ?? 0);
const tools = [
  {
    name: "echo",
    description: "Echo the given text back.",
    inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  { name: "env", description: "Report which environment variables the server received.", inputSchema: { type: "object" } },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
  { name: "crash", description: "Answers, then the server exits.", inputSchema: { type: "object", properties: {} } },
  ...Array.from({ length: extra }, (_, i) => ({
    name: `filler_${i + 1}`,
    description: `Filler tool number ${i + 1} for warehouse inventory reports.`,
    inputSchema: { type: "object", properties: {} },
  })),
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const error = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

function call(name, args) {
  switch (name) {
    case "echo":
      return { content: [{ type: "text", text: `echo: ${args.text}` }] };
    case "env":
      return {
        content: [{ type: "text", text: JSON.stringify({ token: process.env.TEST_TOKEN ?? null, leak: process.env.SOLO_TEST_LEAK ?? null }) }],
      };
    case "crash":
      setTimeout(() => process.exit(1), 20);
      return { content: [{ type: "text", text: "bye" }] };
    case "fail":
      return { content: [{ type: "text", text: "something broke" }], isError: true };
    default:
      if (name.startsWith("filler_")) return { content: [{ type: "text", text: `${name} ok` }] };
      return undefined;
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return; // notifications
  switch (message.method) {
    case "initialize":
      return reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "test-server", version: "1.0.0" },
      });
    case "ping":
      return reply(message.id, {});
    case "tools/list":
      return reply(message.id, { tools });
    case "tools/call": {
      const result = call(message.params.name, message.params.arguments ?? {});
      return result ? reply(message.id, result) : error(message.id, -32602, `Unknown tool ${message.params.name}`);
    }
    default:
      return error(message.id, -32601, `Method not found: ${message.method}`);
  }
});
