export interface FairSchedulerOptions {
  maxConcurrent: number;
  maxConcurrentPerTenant: number;
  onTaskError?: (error: unknown) => void;
}

interface ScheduledTask {
  tenantKey: string;
  execute: () => Promise<void>;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export class FairTenantScheduler {
  private readonly queues = new Map<string, ScheduledTask[]>();
  private readonly tenantOrder: string[] = [];
  private readonly activeByTenant = new Map<string, number>();
  private readonly idleWaiters = new Set<() => void>();
  private active = 0;
  private draining = false;

  readonly maxConcurrent: number;
  readonly maxConcurrentPerTenant: number;

  constructor(private readonly options: FairSchedulerOptions) {
    this.maxConcurrent = positiveInteger(
      options.maxConcurrent,
      "maxConcurrent",
    );
    this.maxConcurrentPerTenant = positiveInteger(
      options.maxConcurrentPerTenant,
      "maxConcurrentPerTenant",
    );
  }

  enqueue(tenantKey: string, execute: () => Promise<void>): void {
    if (!tenantKey) throw new Error("Scheduler tenant key is required.");
    const queue = this.queues.get(tenantKey);
    if (queue) {
      queue.push({ tenantKey, execute });
    } else {
      this.queues.set(tenantKey, [{ tenantKey, execute }]);
      this.tenantOrder.push(tenantKey);
    }
    this.drain();
  }

  async onIdle(): Promise<void> {
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  snapshot(): {
    active: number;
    pending: number;
    tenants: number;
  } {
    let pending = 0;
    for (const queue of this.queues.values()) pending += queue.length;
    return {
      active: this.active,
      pending,
      tenants: this.queues.size,
    };
  }

  private isIdle(): boolean {
    return this.active === 0 && this.queues.size === 0;
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      let scannedWithoutDispatch = 0;
      while (
        this.active < this.maxConcurrent &&
        this.tenantOrder.length > 0 &&
        scannedWithoutDispatch < this.tenantOrder.length
      ) {
        const tenantKey = this.tenantOrder.shift()!;
        const queue = this.queues.get(tenantKey);
        if (!queue || queue.length === 0) {
          this.queues.delete(tenantKey);
          continue;
        }

        const tenantActive = this.activeByTenant.get(tenantKey) ?? 0;
        if (tenantActive >= this.maxConcurrentPerTenant) {
          this.tenantOrder.push(tenantKey);
          scannedWithoutDispatch += 1;
          continue;
        }

        const task = queue.shift()!;
        if (queue.length > 0) {
          this.tenantOrder.push(tenantKey);
        } else {
          this.queues.delete(tenantKey);
        }
        scannedWithoutDispatch = 0;
        this.active += 1;
        this.activeByTenant.set(tenantKey, tenantActive + 1);

        void task
          .execute()
          .catch((error) => this.options.onTaskError?.(error))
          .finally(() => {
            this.active -= 1;
            const remaining =
              (this.activeByTenant.get(task.tenantKey) ?? 1) - 1;
            if (remaining > 0) {
              this.activeByTenant.set(task.tenantKey, remaining);
            } else {
              this.activeByTenant.delete(task.tenantKey);
            }
            this.drain();
            this.notifyIdle();
          });
      }
    } finally {
      this.draining = false;
    }
    this.notifyIdle();
  }
}
