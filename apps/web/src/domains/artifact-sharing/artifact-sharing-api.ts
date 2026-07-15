import {
  buildVellumHeaders,
  buildVellumMutatingHeaders,
} from "@/lib/auth/request-headers";
import { resolvePlatformActionUrl } from "@/lib/api-origins";

export type ArtifactCollaborationRole = "viewer" | "commenter" | "editor";

export interface SharedCopybookMonth {
  id: string;
  month: number;
  strategyStatus: string;
  document: {
    surfaceId: string;
    title: string;
    content: string;
    updatedAt: number;
  } | null;
}

export interface SharedCopybookSnapshot {
  artifactId: string;
  collaborationRole: "viewer" | "commenter" | "editor" | "owner";
  copybook: { id: string; title: string; year: number };
  brand: { id: string; name: string } | null;
  months: SharedCopybookMonth[];
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const mutation = !["GET", "HEAD"].includes(init.method ?? "GET");
  const headers = mutation
    ? await buildVellumMutatingHeaders({ "Content-Type": "application/json" })
    : buildVellumHeaders();
  const response = await fetch(resolvePlatformActionUrl(path), {
    ...init,
    credentials: "include",
    headers: { ...headers, ...init.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      detail?: string;
    } | null;
    throw new Error(body?.detail ?? "This action could not be completed.");
  }
  return response.json() as Promise<T>;
}

export async function createArtifactInvitations(input: {
  assistantId: string;
  artifactId: string;
  recipients: Array<{ email: string; role: ArtifactCollaborationRole }>;
}) {
  return request<{
    invitations: Array<{
      email: string;
      role: ArtifactCollaborationRole;
      inviteUrl: string;
      expiresAt: number;
    }>;
  }>(
    `/v1/assistants/${encodeURIComponent(input.assistantId)}/artifact-invitations/`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function acceptArtifactInvitation(token: string) {
  return request<{
    artifactId: string;
    ownerAssistantId: string;
    role: ArtifactCollaborationRole;
  }>(`/v1/artifact-invitations/${encodeURIComponent(token)}/accept/`, {
    method: "POST",
  });
}

export async function getSharedCopybookSnapshot(artifactId: string) {
  return request<SharedCopybookSnapshot>(
    `/v1/shared-artifacts/${encodeURIComponent(artifactId)}/snapshot`,
  );
}

export async function updateSharedCopybookMonth(input: {
  artifactId: string;
  monthId: string;
  content: string;
}) {
  return request<{ success: true }>(
    `/v1/shared-artifacts/${encodeURIComponent(input.artifactId)}/months/${encodeURIComponent(input.monthId)}/document`,
    { method: "PATCH", body: JSON.stringify({ content: input.content }) },
  );
}

export interface SharedComment {
  id: string;
  surfaceId: string;
  conversationId: string;
  author: string;
  content: string;
  anchorStart: number | null;
  anchorEnd: number | null;
  anchorText: string | null;
  parentCommentId: string | null;
  status: "open" | "resolved";
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export async function listSharedCopybookComments(
  artifactId: string,
  monthId: string,
) {
  return request<{ comments: SharedComment[] }>(
    `/v1/shared-artifacts/${encodeURIComponent(artifactId)}/months/${encodeURIComponent(monthId)}/comments`,
  );
}

export async function createSharedCopybookComment(input: {
  artifactId: string;
  monthId: string;
  content: string;
  anchorStart?: number | null;
  anchorEnd?: number | null;
  anchorText?: string | null;
  parentCommentId?: string | null;
}) {
  return request<SharedComment>(
    `/v1/shared-artifacts/${encodeURIComponent(input.artifactId)}/months/${encodeURIComponent(input.monthId)}/comments`,
    { method: "POST", body: JSON.stringify(input) },
  );
}
