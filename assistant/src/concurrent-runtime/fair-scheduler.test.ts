import { describe, expect, test } from "bun:test";

import { FairTenantScheduler } from "./fair-scheduler.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("FairTenantScheduler", () => {
  test("enforces global and per-tenant concurrency without starving peers", async () => {
    const tenantAGate = deferred();
    const tenantBGate = deferred();
    const started: string[] = [];
    const scheduler = new FairTenantScheduler({
      maxConcurrent: 2,
      maxConcurrentPerTenant: 1,
    });

    scheduler.enqueue("tenant-a", async () => {
      started.push("a1");
      await tenantAGate.promise;
    });
    scheduler.enqueue("tenant-a", async () => {
      started.push("a2");
    });
    scheduler.enqueue("tenant-b", async () => {
      started.push("b1");
      await tenantBGate.promise;
    });

    await Bun.sleep(5);
    expect(started).toEqual(["a1", "b1"]);
    expect(scheduler.snapshot()).toEqual({
      active: 2,
      pending: 1,
      tenants: 1,
    });

    tenantAGate.resolve();
    tenantBGate.resolve();
    await scheduler.onIdle();
    expect(started).toEqual(["a1", "b1", "a2"]);
  });
});
