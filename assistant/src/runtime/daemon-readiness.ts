export type DaemonReadinessReason =
  | "daemon_starting"
  | "database_unavailable"
  | "daemon_startup_failed";

export interface DaemonReadinessState {
  ready: boolean;
  reason: DaemonReadinessReason | null;
}

let state: DaemonReadinessState = {
  ready: false,
  reason: "daemon_starting",
};

export function getDaemonReadiness(): DaemonReadinessState {
  return state;
}

export function markDaemonReady(): void {
  state = { ready: true, reason: null };
}

export function markDaemonNotReady(reason: DaemonReadinessReason): void {
  state = { ready: false, reason };
}
