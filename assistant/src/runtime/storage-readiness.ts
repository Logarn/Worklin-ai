/**
 * Small, side-effect-free storage probe used by the runtime readiness check.
 * Keeping the probe injectable makes the failure mode testable without
 * opening the live workspace database.
 */
export type StorageProbe = () => unknown;

export type StorageReadiness =
  | { ready: true }
  | { ready: false; error: string };

export function checkStorageReadiness(probe: StorageProbe): StorageReadiness {
  try {
    probe();
    return { ready: true };
  } catch (error) {
    return {
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
