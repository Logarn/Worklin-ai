import type { RuntimeStackRow } from "./runtime-stacks.js";

export type RuntimeAction = "restart" | "terminal" | "doctor" | "update_window";

export interface RuntimeActionCapability {
  capability: RuntimeAction;
  supported: boolean;
  code: "supported" | "runtime_capability_unavailable";
  detail: string;
}

export interface RuntimeActionCapabilities {
  restart: RuntimeActionCapability;
  terminal: RuntimeActionCapability;
  doctor: RuntimeActionCapability;
  update_window: RuntimeActionCapability;
}

const SUPPORTED_DETAILS: Record<RuntimeAction, string> = {
  restart: "Restart this managed assistant.",
  terminal: "Open an interactive terminal session.",
  doctor: "Start an Assistant Doctor session.",
  update_window: "Configure a custom update window.",
};

const UNAVAILABLE_DETAILS: Record<RuntimeAction, string> = {
  restart: "Managed restart is not available for this assistant.",
  terminal:
    "Interactive terminal access isn't available for managed Worklin assistants yet.",
  doctor:
    "Assistant Doctor isn't available for managed Worklin assistants yet.",
  update_window:
    "Worklin applies updates automatically during launch, so custom update windows aren't available yet.",
};

function capability(
  action: RuntimeAction,
  supported: boolean,
): RuntimeActionCapability {
  return {
    capability: action,
    supported,
    code: supported ? "supported" : "runtime_capability_unavailable",
    detail: supported ? SUPPORTED_DETAILS[action] : UNAVAILABLE_DETAILS[action],
  };
}

export function runtimeActionCapabilitiesForStack(
  stack: RuntimeStackRow,
  restartConfigured: boolean,
): RuntimeActionCapabilities {
  const restartSupported =
    stack.provider === "railway" &&
    restartConfigured &&
    stack.status === "active" &&
    stack.service_ref !== null &&
    stack.gateway_url !== null;

  return {
    restart: capability("restart", restartSupported),
    terminal: capability("terminal", false),
    doctor: capability("doctor", false),
    update_window: capability("update_window", false),
  };
}
