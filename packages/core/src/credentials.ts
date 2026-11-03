import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { Db } from "./db.ts";
import type { Sealer } from "./secrets.ts";

/**
 * pi-ai credential store backed by soloagent's database, sealed at rest.
 * Writes for one provider are serialized, so concurrent requests never double-refresh an OAuth token.
 */
export class SealedCredentialStore implements CredentialStore {
  #db: Db;
  #sealer: Sealer;
  #locks = new Map<string, Promise<unknown>>();
  #onChange: () => void;

  constructor(db: Db, sealer: Sealer, onChange: () => void = () => {}) {
    this.#db = db;
    this.#sealer = sealer;
    this.#onChange = onChange;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const row = this.#db.get<{ data: string }>("SELECT data FROM credentials WHERE provider_id = ?", providerId);
    if (!row) return undefined;
    try {
      return JSON.parse(this.#sealer.open(row.data)) as Credential;
    } catch {
      return undefined; // sealed with another secret: treat as absent so the user can log in again
    }
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return this.#db
      .all<{ provider_id: string; type: Credential["type"] }>("SELECT provider_id, type FROM credentials")
      .map((row) => ({ providerId: row.provider_id, type: row.type }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#serialize(providerId, async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next === undefined) return current;
      this.#db.run(
        `INSERT INTO credentials (provider_id, type, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET type = excluded.type, data = excluded.data, updated_at = excluded.updated_at`,
        providerId,
        next.type,
        this.#sealer.seal(JSON.stringify(next)),
        Date.now(),
      );
      if (current?.type !== next.type || current === undefined) this.#onChange();
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.#serialize(providerId, async () => {
      this.#db.run("DELETE FROM credentials WHERE provider_id = ?", providerId);
      this.#onChange();
    });
  }

  #serialize<T>(providerId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(providerId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.#locks.set(
      providerId,
      next.catch(() => {}),
    );
    return next;
  }
}
