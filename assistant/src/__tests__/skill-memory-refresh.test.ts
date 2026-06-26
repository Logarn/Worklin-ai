import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import type { AssistantConfig } from "../config/schema.js";

interface TimerRecord {
  callback: () => void;
  cleared: boolean;
  delayMs: number | undefined;
  unrefCalled: boolean;
}

interface TestState {
  containerized: boolean;
  skillGraphSeedCount: number;
  uninstalledCatalogSeedCount: number;
  v2SkillSeedCount: number;
  v2CliCommandSeedCount: number;
  timers: TimerRecord[];
  warnCalls: Array<{ obj: unknown; msg: unknown }>;
  infoCalls: Array<{ obj: unknown; msg: unknown }>;
}

const state: TestState = {
  containerized: false,
  skillGraphSeedCount: 0,
  uninstalledCatalogSeedCount: 0,
  v2SkillSeedCount: 0,
  v2CliCommandSeedCount: 0,
  timers: [],
  warnCalls: [],
  infoCalls: [],
};

mock.module("../config/env-registry.js", () => ({
  getIsContainerized: (): boolean => state.containerized,
}));

mock.module("../config/loader.js", () => ({
  getConfig: (): AssistantConfig => makeConfig(true),
}));

mock.module("../memory/graph/capability-seed.js", () => ({
  seedSkillGraphNodes: (): void => {
    state.skillGraphSeedCount += 1;
  },
  seedUninstalledCatalogSkillMemories: async (): Promise<void> => {
    state.uninstalledCatalogSeedCount += 1;
  },
}));

mock.module("../daemon/memory-v2-startup.js", () => ({
  maybeSeedMemoryV2Skills: (): void => {
    state.v2SkillSeedCount += 1;
  },
  maybeSeedMemoryV2CliCommands: (): void => {
    state.v2CliCommandSeedCount += 1;
  },
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    warn: (obj: unknown, msg: unknown) => {
      state.warnCalls.push({ obj, msg });
    },
    info: (obj: unknown, msg: unknown) => {
      state.infoCalls.push({ obj, msg });
    },
    error: () => {},
    debug: () => {},
  }),
}));

const {
  refreshSkillCapabilityMemories,
  refreshSkillCapabilityMemoriesOnStartup,
} = await import("../daemon/skill-memory-refresh.js");

function makeConfig(v2Enabled: boolean): AssistantConfig {
  return {
    memory: {
      v2: { enabled: v2Enabled },
    },
  } as unknown as AssistantConfig;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function resetState(): void {
  state.containerized = false;
  state.skillGraphSeedCount = 0;
  state.uninstalledCatalogSeedCount = 0;
  state.v2SkillSeedCount = 0;
  state.v2CliCommandSeedCount = 0;
  state.timers = [];
  state.warnCalls = [];
  state.infoCalls = [];
}

let originalSetTimeout: typeof globalThis.setTimeout;
let originalClearTimeout: typeof globalThis.clearTimeout;

describe("skill-memory-refresh", () => {
  beforeAll(() => {
    originalSetTimeout = globalThis.setTimeout;
    originalClearTimeout = globalThis.clearTimeout;

    globalThis.setTimeout = ((
      callback: TimerHandler,
      ms?: number,
      ...args: unknown[]
    ) => {
      const timer: TimerRecord = {
        callback: () => {
          if (typeof callback === "function") {
            callback(...args);
          }
        },
        cleared: false,
        delayMs: typeof ms === "number" ? ms : undefined,
        unrefCalled: false,
      };
      state.timers.push(timer);
      return {
        __timerRecord: timer,
        unref: () => {
          timer.unrefCalled = true;
        },
      } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    globalThis.clearTimeout = ((handle: unknown) => {
      const timer = (handle as { __timerRecord?: TimerRecord }).__timerRecord;
      if (timer) timer.cleared = true;
    }) as typeof clearTimeout;
  });

  afterAll(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  beforeEach(resetState);

  test("refreshSkillCapabilityMemories seeds graph and v2 memories immediately", async () => {
    refreshSkillCapabilityMemories(makeConfig(true));
    await flushMicrotasks();

    expect(state.skillGraphSeedCount).toBe(2);
    expect(state.uninstalledCatalogSeedCount).toBe(1);
    expect(state.v2SkillSeedCount).toBe(1);
    expect(state.v2CliCommandSeedCount).toBe(1);
    expect(state.timers).toHaveLength(0);
    expect(state.warnCalls).toHaveLength(0);
  });

  test("startup refresh seeds immediately outside containers", async () => {
    refreshSkillCapabilityMemoriesOnStartup(makeConfig(true));
    await flushMicrotasks();

    expect(state.skillGraphSeedCount).toBe(2);
    expect(state.uninstalledCatalogSeedCount).toBe(1);
    expect(state.v2SkillSeedCount).toBe(1);
    expect(state.v2CliCommandSeedCount).toBe(1);
    expect(state.timers).toHaveLength(0);
  });

  test("startup refresh defers only the v2 seeding in containers", async () => {
    state.containerized = true;

    refreshSkillCapabilityMemoriesOnStartup(makeConfig(true));
    await flushMicrotasks();

    expect(state.skillGraphSeedCount).toBe(2);
    expect(state.uninstalledCatalogSeedCount).toBe(1);
    expect(state.v2SkillSeedCount).toBe(0);
    expect(state.v2CliCommandSeedCount).toBe(0);
    expect(state.timers).toHaveLength(1);
    expect(state.timers[0]?.delayMs).toBe(20_000);
    expect(state.timers[0]?.unrefCalled).toBeTrue();

    state.timers[0]?.callback();

    expect(state.v2SkillSeedCount).toBe(1);
    expect(state.v2CliCommandSeedCount).toBe(1);
  });

  test("an immediate refresh cancels any deferred startup timer", async () => {
    state.containerized = true;

    refreshSkillCapabilityMemoriesOnStartup(makeConfig(true));
    expect(state.timers).toHaveLength(1);

    refreshSkillCapabilityMemories(makeConfig(true));
    await flushMicrotasks();

    expect(state.timers[0]?.cleared).toBeTrue();
    expect(state.v2SkillSeedCount).toBe(1);
    expect(state.v2CliCommandSeedCount).toBe(1);
  });
});
