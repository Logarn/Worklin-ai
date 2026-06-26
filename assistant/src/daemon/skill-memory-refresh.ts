import { getIsContainerized } from "../config/env-registry.js";
import { getConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/schema.js";
import {
  seedSkillGraphNodes,
  seedUninstalledCatalogSkillMemories,
} from "../memory/graph/capability-seed.js";
import { getLogger } from "../util/logger.js";
import {
  maybeSeedMemoryV2CliCommands,
  maybeSeedMemoryV2Skills,
} from "./memory-v2-startup.js";

const log = getLogger("skill-memory-refresh");
const CONTAINERIZED_MEMORY_V2_SEED_DELAY_MS = 20_000;
let deferredMemoryV2SeedTimer: ReturnType<typeof setTimeout> | null = null;

function runMemoryV2CapabilitySeeds(config: AssistantConfig): void {
  maybeSeedMemoryV2Skills(config);
  maybeSeedMemoryV2CliCommands(config);
}

function clearDeferredMemoryV2SeedTimer(): void {
  if (!deferredMemoryV2SeedTimer) return;
  clearTimeout(deferredMemoryV2SeedTimer);
  deferredMemoryV2SeedTimer = null;
}

function scheduleDeferredMemoryV2CapabilitySeeds(
  config: AssistantConfig,
): void {
  clearDeferredMemoryV2SeedTimer();
  deferredMemoryV2SeedTimer = setTimeout(() => {
    deferredMemoryV2SeedTimer = null;
    log.info(
      "Running deferred memory v2 capability seeding after container startup",
    );
    runMemoryV2CapabilitySeeds(config);
  }, CONTAINERIZED_MEMORY_V2_SEED_DELAY_MS);
  deferredMemoryV2SeedTimer.unref?.();
  log.info(
    { delayMs: CONTAINERIZED_MEMORY_V2_SEED_DELAY_MS },
    "Deferring memory v2 capability seeding during container startup",
  );
}

function refreshSkillCapabilityGraph(): void {
  seedSkillGraphNodes();
  void seedUninstalledCatalogSkillMemories()
    .then(() => {
      // Re-run after the async catalog fetch populates the cache so stale
      // installed-skill nodes can be pruned without deleting catalog-only nodes.
      seedSkillGraphNodes();
    })
    .catch((err) =>
      log.warn(
        { err },
        "Uninstalled catalog skill memory seeding failed — continuing",
      ),
    );
}

export function refreshSkillCapabilityMemories(
  config: AssistantConfig = getConfig(),
): void {
  clearDeferredMemoryV2SeedTimer();
  refreshSkillCapabilityGraph();
  runMemoryV2CapabilitySeeds(config);
}

export function refreshSkillCapabilityMemoriesOnStartup(
  config: AssistantConfig = getConfig(),
): void {
  refreshSkillCapabilityGraph();
  if (getIsContainerized()) {
    scheduleDeferredMemoryV2CapabilitySeeds(config);
    return;
  }
  runMemoryV2CapabilitySeeds(config);
}
