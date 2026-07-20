import { Copy, Loader2, UserPlus, UsersRound, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@vellumai/design-library/components/button";
import { DetailCard } from "@/components/detail-card";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";
import {
  assignWorkspaceAssistant,
  changeWorkspaceRole,
  connectWorkspaceResearchProvider,
  fetchWorkspace,
  inviteWorkspaceMember,
  removeWorkspaceMember,
  disconnectWorkspaceResearchProvider,
  unassignWorkspaceAssistant,
  type WorkspaceResearchProviderId,
  type WorkspaceRole,
} from "@/domains/settings/api/workspace";

const ROLE_OPTIONS: WorkspaceRole[] = ["admin", "manager", "collaborator"];
const RESEARCH_PROVIDERS: Array<{
  id: WorkspaceResearchProviderId;
  label: string;
}> = [
  { id: "meld", label: "Meld" },
  { id: "instagram", label: "Instagram" },
  { id: "facebook", label: "Facebook" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "youtube", label: "YouTube" },
];

export function WorkspacePage() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("collaborator");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [providerId, setProviderId] =
    useState<WorkspaceResearchProviderId>("meld");
  const [providerCredential, setProviderCredential] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["workspace-management"],
    queryFn: fetchWorkspace,
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["workspace-management"] });
  const isAdmin = data?.current_user.role === "admin";
  const canAssign = isAdmin || data?.current_user.role === "manager";
  const connectedProviders = new Set(
    data?.research_providers.map((provider) => provider.provider_id) ?? [],
  );
  const activeMembers = useMemo(
    () => data?.members.filter((member) => member.status === "active") ?? [],
    [data?.members],
  );

  const invite = useMutation({
    mutationFn: () => inviteWorkspaceMember({ email, role: inviteRole }),
    onSuccess: (result) => {
      setInviteUrl(result.invite_url);
      setEmail("");
      setError(null);
      refresh();
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Invite failed."),
  });

  const mutateMember = async (operation: Promise<unknown>) => {
    try {
      await operation;
      setError(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workspace change failed.");
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-[var(--content-secondary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading workspace…
      </div>
    );
  }

  if (!data)
    return (
      <Notice tone="warning">
        Workspace details are unavailable right now.
      </Notice>
    );

  return (
    <div className="space-y-4">
      {error && <Notice tone="warning">{error}</Notice>}
      <DetailCard
        title="Workspace members"
        subtitle="Invite people, choose their access level, and keep assistant access assigned to the right team members."
        accessory={
          <UsersRound
            className="h-5 w-5 text-[var(--content-secondary)]"
            aria-hidden="true"
          />
        }
      >
        <div className="space-y-3">
          {data.members.map((member) => {
            const isOwner = member.user_id === data.organization.owner_user_id;
            return (
              <div
                key={member.user_id}
                className="flex flex-col gap-2 border-b border-[var(--border-element)] pb-3 last:border-b-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="truncate text-body-medium-default text-[var(--content-default)]">
                    {member.email}
                  </div>
                  <div className="text-body-small-default text-[var(--content-tertiary)]">
                    {isOwner
                      ? "Assistant owner"
                      : member.status === "active"
                        ? "Active member"
                        : "Deactivated"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isAdmin && !isOwner ? (
                    <select
                      className="h-8 rounded-md border border-[var(--border-element)] bg-[var(--surface-base)] px-2 text-body-small-default"
                      value={member.role}
                      onChange={(event) =>
                        void mutateMember(
                          changeWorkspaceRole(
                            member.user_id,
                            event.target.value as WorkspaceRole,
                          ),
                        )
                      }
                      aria-label={`Role for ${member.email}`}
                    >
                      {ROLE_OPTIONS.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-body-small-default capitalize text-[var(--content-secondary)]">
                      {member.role}
                    </span>
                  )}
                  {isAdmin && !isOwner && member.status === "active" && (
                    <Button
                      variant="ghost"
                      size="compact"
                      onClick={() =>
                        void mutateMember(removeWorkspaceMember(member.user_id))
                      }
                    >
                      Deactivate
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </DetailCard>

      {isAdmin && (
        <DetailCard
          title="Invite a member"
          subtitle="The link works once and expires after seven days."
          accessory={
            <UserPlus
              className="h-5 w-5 text-[var(--content-secondary)]"
              aria-hidden="true"
            />
          }
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <Input
              label="Email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
              fullWidth
            />
            <label className="flex min-w-40 flex-col gap-1 text-body-small-default text-[var(--content-secondary)]">
              Role
              <select
                className="h-9 rounded-md border border-[var(--border-element)] bg-[var(--surface-base)] px-2 text-body-medium-default text-[var(--content-default)]"
                value={inviteRole}
                onChange={(event) =>
                  setInviteRole(event.target.value as WorkspaceRole)
                }
              >
                {ROLE_OPTIONS.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="primary"
              onClick={() => invite.mutate()}
              disabled={!email.trim() || invite.isPending}
              leftIcon={<UserPlus className="h-4 w-4" />}
            >
              {invite.isPending ? "Creating…" : "Create invite"}
            </Button>
          </div>
          {inviteUrl && (
            <div className="mt-4 flex flex-col gap-2 rounded-md border border-[var(--border-element)] bg-[var(--surface-base)] p-3">
              <span className="break-all text-body-small-default text-[var(--content-secondary)]">
                {inviteUrl}
              </span>
              <Button
                variant="outlined"
                size="compact"
                onClick={() => void navigator.clipboard?.writeText(inviteUrl)}
                leftIcon={<Copy className="h-4 w-4" />}
              >
                Copy invite link
              </Button>
            </div>
          )}
        </DetailCard>
      )}

      <DetailCard
        title="Assistant access"
        subtitle="Admins and managers can assign assistants. Collaborators only see assistants assigned to them."
      >
        {data.assistants.length === 0 ? (
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            No assistants are available yet.
          </p>
        ) : (
          <div className="space-y-3">
            {data.assistants.map((assistant) => {
              const assigned = data.assignments.filter(
                (item) => item.assistant_id === assistant.id,
              );
              return (
                <div
                  key={assistant.id}
                  className="flex flex-col gap-2 border-b border-[var(--border-element)] pb-3 last:border-b-0 last:pb-0"
                >
                  <div className="text-body-medium-default text-[var(--content-default)]">
                    {assistant.name}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {assigned.length === 0 ? (
                      <span className="text-body-small-default text-[var(--content-tertiary)]">
                        No collaborators assigned
                      </span>
                    ) : (
                      assigned.map((item) => (
                        <span
                          key={item.user_id}
                          className="inline-flex items-center gap-1 rounded-md bg-[var(--surface-active)] py-1 pl-2 text-body-small-default text-[var(--content-secondary)]"
                        >
                          <span>
                            {data.members.find(
                              (member) => member.user_id === item.user_id,
                            )?.email ?? item.user_id}
                          </span>
                          {canAssign && (
                            <Button
                              variant="ghost"
                              size="compact"
                              iconOnly={<X className="h-3.5 w-3.5" />}
                              tooltip="Remove assignment"
                              aria-label="Remove assignment"
                              onClick={() =>
                                void mutateMember(
                                  unassignWorkspaceAssistant(
                                    assistant.id,
                                    item.user_id,
                                  ),
                                )
                              }
                            />
                          )}
                        </span>
                      ))
                    )}
                    {canAssign && (
                      <select
                        className="h-7 rounded-md border border-[var(--border-element)] bg-[var(--surface-base)] px-2 text-body-small-default"
                        defaultValue=""
                        onChange={(event) => {
                          if (event.target.value)
                            void mutateMember(
                              assignWorkspaceAssistant(
                                assistant.id,
                                event.target.value,
                              ),
                            );
                        }}
                        aria-label={`Assign ${assistant.name}`}
                      >
                        <option value="">Assign member…</option>
                        {activeMembers
                          .filter(
                            (member) =>
                              !assigned.some(
                                (item) => item.user_id === member.user_id,
                              ),
                          )
                          .map((member) => (
                            <option key={member.user_id} value={member.user_id}>
                              {member.email}
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DetailCard>

      {isAdmin && (
        <DetailCard
          title="Research connections"
          subtitle="Connect approved research providers for deeper competitive and social signals. Credentials are kept private to workspace admins."
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <label className="flex min-w-40 flex-col gap-1 text-body-small-default text-[var(--content-secondary)]">
              Provider
              <select
                className="h-9 rounded-md border border-[var(--border-element)] bg-[var(--surface-base)] px-2 text-body-medium-default text-[var(--content-default)]"
                value={providerId}
                onChange={(event) =>
                  setProviderId(
                    event.target.value as WorkspaceResearchProviderId,
                  )
                }
              >
                {RESEARCH_PROVIDERS.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </label>
            <Input
              label="Provider credential"
              type="password"
              value={providerCredential}
              onChange={(event) => setProviderCredential(event.target.value)}
              placeholder="Paste a provider token"
              fullWidth
            />
            <Button
              variant="primary"
              onClick={() =>
                void mutateMember(
                  connectWorkspaceResearchProvider(
                    providerId,
                    providerCredential,
                  ).then(() => setProviderCredential("")),
                )
              }
              disabled={!providerCredential.trim()}
            >
              Connect
            </Button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {RESEARCH_PROVIDERS.map((provider) => {
              const connected = connectedProviders.has(provider.id);
              return (
                <span
                  key={provider.id}
                  className="inline-flex items-center gap-2 rounded-md border border-[var(--border-element)] px-2.5 py-1.5 text-body-small-default text-[var(--content-secondary)]"
                >
                  <span>
                    {provider.label}:{" "}
                    {connected ? "Connected" : "Not connected"}
                  </span>
                  {connected && (
                    <Button
                      variant="ghost"
                      size="compact"
                      onClick={() =>
                        void mutateMember(
                          disconnectWorkspaceResearchProvider(provider.id),
                        )
                      }
                    >
                      Disconnect
                    </Button>
                  )}
                </span>
              );
            })}
          </div>
        </DetailCard>
      )}
    </div>
  );
}
