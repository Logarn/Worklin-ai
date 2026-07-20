import { client } from "@/generated/api/client.gen";
import { assertHasResponse, extractErrorMessage } from "@/utils/api-errors";

export type WorkspaceRole = "admin" | "manager" | "collaborator";

export interface WorkspaceMember {
  user_id: string;
  email: string;
  username: string;
  first_name: string;
  last_name: string;
  role: WorkspaceRole;
  status: "active" | "deactivated";
  created_at: string;
  updated_at: string;
}

export interface WorkspaceAssistant {
  id: string;
  name: string;
  user_id: string;
  org_id: string;
}

export interface WorkspaceAssignment {
  org_id: string;
  assistant_id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceState {
  organization: { id: string; name: string; owner_user_id: string };
  current_user: { user_id: string; role: WorkspaceRole };
  members: WorkspaceMember[];
  assistants: WorkspaceAssistant[];
  assignments: WorkspaceAssignment[];
  research_providers: WorkspaceResearchProvider[];
}

export type WorkspaceResearchProviderId =
  | "meld"
  | "instagram"
  | "facebook"
  | "linkedin"
  | "youtube";

export interface WorkspaceResearchProvider {
  org_id: string;
  provider_id: WorkspaceResearchProviderId;
  connected_at: string;
  updated_at: string;
}

async function request<T>(
  method: "get" | "post" | "patch" | "delete",
  options: Record<string, unknown>,
): Promise<T> {
  const result = await client[method]<T, unknown>({
    ...options,
    throwOnError: false,
  } as never);
  assertHasResponse(result.response, result.error, "Workspace request failed.");
  if (!result.response.ok) {
    throw new Error(
      extractErrorMessage(
        result.error,
        result.response,
        "Workspace request failed.",
      ),
    );
  }
  return (result.data ?? {}) as T;
}

export function fetchWorkspace(): Promise<WorkspaceState> {
  return request<WorkspaceState>("get", { url: "/v1/workspace/" });
}

export function inviteWorkspaceMember(input: {
  email: string;
  role: WorkspaceRole;
}): Promise<{ invite_url: string; expires_at: string }> {
  return request("post", {
    url: "/v1/workspace/members/invite/",
    body: input,
    headers: { "Content-Type": "application/json" },
  });
}

export function changeWorkspaceRole(userId: string, role: WorkspaceRole) {
  return request("patch", {
    url: "/v1/workspace/members/{user_id}/role/",
    path: { user_id: userId },
    body: { role },
    headers: { "Content-Type": "application/json" },
  });
}

export function removeWorkspaceMember(userId: string) {
  return request("delete", {
    url: "/v1/workspace/members/{user_id}/",
    path: { user_id: userId },
  });
}

export function assignWorkspaceAssistant(assistantId: string, userId: string) {
  return request("post", {
    url: "/v1/workspace/assistants/assignments/",
    body: { assistantId, userId },
    headers: { "Content-Type": "application/json" },
  });
}

export function unassignWorkspaceAssistant(
  assistantId: string,
  userId: string,
) {
  return request("delete", {
    url: "/v1/workspace/assistants/assignments/",
    body: { assistantId, userId },
    headers: { "Content-Type": "application/json" },
  });
}

export function connectWorkspaceResearchProvider(
  providerId: WorkspaceResearchProviderId,
  credential: string,
) {
  return request("post", {
    url: "/v1/workspace/research-providers/{provider_id}/",
    path: { provider_id: providerId },
    body: { credential },
    headers: { "Content-Type": "application/json" },
  });
}

export function disconnectWorkspaceResearchProvider(
  providerId: WorkspaceResearchProviderId,
) {
  return request("delete", {
    url: "/v1/workspace/research-providers/{provider_id}/",
    path: { provider_id: providerId },
  });
}
