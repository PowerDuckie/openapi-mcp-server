
import type { ManagedServiceRecord } from "../types";

export class ServiceRegistry {
  private readonly records = new Map<string, ManagedServiceRecord>();

  upsert(record: ManagedServiceRecord): void {
    this.records.set(record.id, record);
  }

  list(): ManagedServiceRecord[] {
    return Array.from(this.records.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): ManagedServiceRecord | undefined {
    return this.records.get(id);
  }

  stop(id: string): ManagedServiceRecord | undefined {
    const current = this.records.get(id);
    if (!current) return undefined;
    const next: ManagedServiceRecord = { ...current, status: "stopped", updatedAt: new Date().toISOString() };
    this.records.set(id, next);
    return next;
  }
}
