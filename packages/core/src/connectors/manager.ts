import type { Connector, ConnectorInput, ConnectorKind, ConnectorStatus } from "@soloagent/client";
import { type Db, newId } from "../db.ts";
import type { Sealer } from "../secrets.ts";
import { DRIVERS, kindInfo } from "./kinds.ts";
import type { ChatDecisionInput, ConnectorDriver, InboundMessage } from "./types.ts";

type Row = { id: string; kind: ConnectorKind; data: string; secrets: string | null; created_at: number; updated_at: number };
type Data = { name: string; enabled: boolean; agentId: string | null; config: Record<string, string>; approvers?: string[] };

export const SECRET_MASK = "••••••••";

export interface ConnectorEvents {
  changed(connector: Connector, deleted?: boolean): void;
  inbound(connector: Connector, message: InboundMessage): void;
  /** Approvals: a button press on an approval message. */
  decide(connector: Connector, input: ChatDecisionInput): Promise<{ ok: boolean; message: string }>;
  log(connectorId: string, message: string, error?: boolean): void;
}

/** Stores connector settings (secrets sealed) and runs one platform driver per enabled connector. */
export class ConnectorManager {
  #db: Db;
  #sealer: Sealer;
  #events: ConnectorEvents;
  #drivers = new Map<string, ConnectorDriver>();
  #status = new Map<string, { status: ConnectorStatus; detail?: string; identity?: string }>();

  constructor(db: Db, sealer: Sealer, events: ConnectorEvents) {
    this.#db = db;
    this.#sealer = sealer;
    this.#events = events;
  }

  list(): Connector[] {
    return this.#db.all<Row>("SELECT * FROM connectors ORDER BY created_at").map((row) => this.#public(row));
  }

  get(id: string): Connector | undefined {
    const row = this.#row(id);
    return row ? this.#public(row) : undefined;
  }

  driver(id: string): ConnectorDriver | undefined {
    return this.#drivers.get(id);
  }

  /** Full config, secrets included. Server-side only. */
  config(id: string): Record<string, string> {
    const row = this.#row(id);
    if (!row) return {};
    const data = JSON.parse(row.data) as Data;
    return { ...data.config, ...this.#secrets(row) };
  }

  create(input: ConnectorInput): Connector {
    const info = kindInfo(input.kind);
    if (!info) throw new Error(`Unknown connector kind ${input.kind}`);
    const now = Date.now();
    const id = newId(input.kind.slice(0, 3));
    const { config, secrets } = this.#split(input.kind, input.config ?? {}, {});
    const data: Data = {
      name: input.name?.trim() || info.name,
      enabled: input.enabled ?? true,
      agentId: input.agentId ?? null,
      config,
      approvers: cleanApprovers(input.approvers ?? []),
    };
    this.#db.run(
      "INSERT INTO connectors (id, kind, data, secrets, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      input.kind,
      JSON.stringify(data),
      this.#sealer.seal(JSON.stringify(secrets)),
      now,
      now,
    );
    void this.restart(id);
    return this.get(id)!;
  }

  update(id: string, input: Partial<ConnectorInput>): Connector {
    const row = this.#row(id);
    if (!row) throw new Error("Connector not found");
    const data = JSON.parse(row.data) as Data;
    const currentSecrets = this.#secrets(row);
    const { config, secrets } = input.config ? this.#split(row.kind, input.config, currentSecrets) : { config: data.config, secrets: currentSecrets };
    const next: Data = {
      name: input.name?.trim() || data.name,
      enabled: input.enabled ?? data.enabled,
      agentId: input.agentId === undefined ? data.agentId : input.agentId,
      config: { ...data.config, ...config },
      approvers: input.approvers !== undefined ? cleanApprovers(input.approvers) : (data.approvers ?? []),
    };
    this.#db.run(
      "UPDATE connectors SET data = ?, secrets = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(next),
      this.#sealer.seal(JSON.stringify(secrets)),
      Date.now(),
      id,
    );
    const needsRestart = input.config !== undefined || input.enabled !== undefined;
    if (needsRestart) void this.restart(id);
    else this.#events.changed(this.get(id)!);
    return this.get(id)!;
  }

  async delete(id: string) {
    const connector = this.get(id);
    if (!connector) return;
    await this.#stop(id);
    this.#db.run("DELETE FROM connectors WHERE id = ?", id);
    this.#status.delete(id);
    this.#events.changed(connector, true);
  }

  async startAll() {
    await Promise.all(this.list().filter((c) => c.enabled).map((c) => this.restart(c.id).catch((error) => this.#setStatus(c.id, "error", String(error)))));
  }

  async stopAll() {
    await Promise.all([...this.#drivers.keys()].map((id) => this.#stop(id)));
  }

  async restart(id: string): Promise<Connector | undefined> {
    await this.#stop(id);
    const connector = this.get(id);
    if (!connector) return undefined;
    if (!connector.enabled) {
      this.#setStatus(id, "stopped");
      return this.get(id);
    }
    const missing = kindInfo(connector.kind)!.fields.filter((f) => !f.optional && !this.config(id)[f.key]);
    if (missing.length) {
      const row = this.#row(id);
      const unreadable = row?.secrets && Object.keys(this.#secrets(row)).length === 0 && row.secrets.length > 60;
      this.#setStatus(
        id,
        "error",
        unreadable
          ? "Saved tokens can't be decrypted (SOLOAGENT_SECRET changed?). Enter them again."
          : `Missing ${missing.map((f) => f.label).join(", ")}`,
      );
      return this.get(id);
    }
    this.#setStatus(id, "starting");
    const driver = DRIVERS[connector.kind](this.config(id), {
      receive: (message) => {
        const current = this.get(id);
        if (current) this.#events.inbound(current, message);
      },
      decide: async (input) => {
        const current = this.get(id);
        return current ? this.#events.decide(current, input) : { ok: false, message: "This connector was removed." };
      },
      status: (status, detail, identity) => this.#setStatus(id, status, detail, identity),
      log: (message) => this.#events.log(id, message, true),
    });
    this.#drivers.set(id, driver);
    try {
      await driver.start();
      if (this.#status.get(id)?.status === "starting" && connector.kind !== "telegram") this.#setStatus(id, "connected");
      this.#events.log(id, `${connector.name} connected`);
    } catch (error) {
      this.#drivers.delete(id);
      await driver.stop().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      this.#setStatus(id, "error", message);
      this.#events.log(id, `${connector.name}: ${message}`, true);
    }
    return this.get(id);
  }

  async #stop(id: string) {
    const driver = this.#drivers.get(id);
    this.#drivers.delete(id);
    if (driver) await driver.stop().catch(() => {});
    if (this.#status.has(id)) this.#setStatus(id, "stopped");
  }

  #setStatus(id: string, status: ConnectorStatus, detail?: string, identity?: string) {
    const previous = this.#status.get(id);
    this.#status.set(id, { status, detail, identity: identity ?? (status === "stopped" ? undefined : previous?.identity) });
    const connector = this.get(id);
    if (connector) this.#events.changed(connector);
  }

  #split(kind: ConnectorKind, input: Record<string, string>, currentSecrets: Record<string, string>) {
    const info = kindInfo(kind)!;
    const config: Record<string, string> = {};
    const secrets: Record<string, string> = { ...currentSecrets };
    for (const field of info.fields) {
      const value = input[field.key];
      if (value === undefined) continue;
      if (field.secret) {
        if (value === SECRET_MASK) continue; // unchanged
        if (value === "") delete secrets[field.key];
        else secrets[field.key] = value.trim();
      } else {
        config[field.key] = value.trim();
      }
    }
    return { config, secrets };
  }

  /** Sealed secrets, or {} when they were sealed with another SOLOAGENT_SECRET (the user re-enters them). */
  #secrets(row: Row): Record<string, string> {
    if (!row.secrets) return {};
    try {
      return JSON.parse(this.#sealer.open(row.secrets)) as Record<string, string>;
    } catch {
      return {};
    }
  }

  #row(id: string): Row | undefined {
    return this.#db.get<Row>("SELECT * FROM connectors WHERE id = ?", id);
  }

  #public(row: Row): Connector {
    const data = JSON.parse(row.data) as Data;
    const info = kindInfo(row.kind);
    const secrets = this.#secrets(row);
    const config: Record<string, string> = { ...data.config };
    for (const field of info?.fields ?? []) if (field.secret && secrets[field.key]) config[field.key] = SECRET_MASK;
    const status = this.#status.get(row.id) ?? { status: "stopped" as const };
    return {
      id: row.id,
      kind: row.kind,
      name: data.name,
      enabled: data.enabled,
      agentId: data.agentId,
      config,
      status: status.status,
      statusDetail: status.detail,
      identity: status.identity,
      approvers: data.approvers ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function cleanApprovers(approvers: readonly string[]): string[] {
  return [...new Set(approvers.map((a) => String(a).trim()).filter(Boolean))].slice(0, 100);
}
