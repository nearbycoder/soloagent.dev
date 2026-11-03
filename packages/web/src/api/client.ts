import { SoloApiError, SoloClient } from "@soloagent/client";

let onUnauthorized: () => void = () => {};

/** Called whenever any request comes back 401 (expired or wrong session). */
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

class AppClient extends SoloClient {
  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await super.request<T>(method, path, body);
    } catch (error) {
      if (error instanceof SoloApiError && error.status === 401 && path !== "/session") onUnauthorized();
      throw error;
    }
  }
}

/** Same-origin client: the session cookie carries auth for REST and the WebSocket. */
export const client = new AppClient({ baseUrl: "" });

export function errorMessage(error: unknown): string {
  if (error instanceof SoloApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export { SoloApiError };
