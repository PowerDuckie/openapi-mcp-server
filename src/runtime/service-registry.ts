import type { ManagedServiceRecord } from "../types";

export class ServiceRegistry {
  private readonly records = new Map<string, ManagedServiceRecord>();

  upsert(record: ManagedServiceRecord): void {
    this.records.set(record.id, record);
  }

  list(): ManagedServiceRecord[] {
    return Array.from(this.records.values()).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  get(id: string): ManagedServiceRecord | undefined {
    return this.records.get(id);
  }

  remove(id: string): boolean {
    return this.records.delete(id);
  }

  clear(): void {
    this.records.clear();
  }

  start(id: string): ManagedServiceRecord | undefined {
    const current = this.records.get(id);
    if (!current) return undefined;
    const next: ManagedServiceRecord = {
      ...current,
      status: "running",
      updatedAt: new Date().toISOString(),
      lastError: undefined,
    };
    this.records.set(id, next);
    return next;
  }

  stop(id: string): ManagedServiceRecord | undefined {
    const current = this.records.get(id);
    if (!current) return undefined;
    const next: ManagedServiceRecord = {
      ...current,
      status: "stopped",
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, next);
    return next;
  }

  fail(id: string, message: string): ManagedServiceRecord | undefined {
    const current = this.records.get(id);
    if (!current) return undefined;
    const next: ManagedServiceRecord = {
      ...current,
      status: "error",
      updatedAt: new Date().toISOString(),
      lastError: {
        message,
        at: new Date().toISOString(),
      },
    };
    this.records.set(id, next);
    return next;
  }
}
