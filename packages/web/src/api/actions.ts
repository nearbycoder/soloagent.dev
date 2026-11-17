import { client } from "./client.ts";
import { local } from "./store.ts";
import { toUploads } from "../lib/files.ts";
import { toast } from "../lib/toast.ts";

/**
 * Starts a web chat with an agent and sends the first message. Returns the new thread id, or undefined when it
 * failed (a toast says why, and the empty thread is cleaned up so it doesn't linger in the list).
 */
export async function startChat(agentId: string, text: string, files: File[] = []): Promise<string | undefined> {
  let threadId: string | undefined;
  try {
    const thread = await client.createThread({ agentId, source: "web" });
    threadId = thread.id;
    local.thread(thread);
    await client.send(thread.id, text, { source: "web", ...(files.length ? { attachments: await toUploads(files) } : {}) });
    return thread.id;
  } catch (error) {
    toast.error(error, "Could not start the chat");
    if (threadId) {
      const id = threadId;
      void client.deleteThread(id).then(() => local.threadDeleted(id), () => {});
    }
    return undefined;
  }
}
