import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

const acceptInvitationMock = mock(async (_token: string) => ({
  org_id: "org-team",
  user_id: "user-1",
  role: "manager" as const,
  status: "active" as const,
}));
const fetchOrganizationsMock = mock(async () => {});
const setCurrentOrganizationIdMock = mock((_orgId: string) => {});
const clearAssistantsMock = mock(() => {});
const setSelectedAssistantMock = mock((_assistantId: string | null) => {});
const setActiveAssistantIdMock = mock((_assistantId: string | null) => {});

mock.module("@/domains/settings/api/workspace", () => ({
  acceptWorkspaceInvitation: acceptInvitationMock,
}));
mock.module("@/stores/organization-store", () => ({
  useOrganizationStore: {
    getState: () => ({
      fetchOrganizations: fetchOrganizationsMock,
      setCurrentOrganizationId: setCurrentOrganizationIdMock,
    }),
  },
}));
mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    getState: () => ({
      clear: clearAssistantsMock,
      setSelectedAssistant: setSelectedAssistantMock,
      setActiveAssistantId: setActiveAssistantIdMock,
    }),
  },
}));

const { AcceptWorkspaceInvitationPage } = await import(
  "./accept-workspace-invitation-page"
);

describe("AcceptWorkspaceInvitationPage", () => {
  afterEach(() => {
    cleanup();
    acceptInvitationMock.mockClear();
    fetchOrganizationsMock.mockClear();
    setCurrentOrganizationIdMock.mockClear();
    clearAssistantsMock.mockClear();
    setSelectedAssistantMock.mockClear();
    setActiveAssistantIdMock.mockClear();
  });

  test("accepts the invite, selects its workspace, and opens workspace settings", async () => {
    render(
      <MemoryRouter
        initialEntries={["/assistant/workspace/invitations/invite-token"]}
      >
        <Routes>
          <Route
            path="/assistant/workspace/invitations/:token"
            element={<AcceptWorkspaceInvitationPage />}
          />
          <Route
            path="/assistant/settings/workspace"
            element={<div>Workspace settings</div>}
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Workspace settings")).toBeTruthy();
    });
    expect(acceptInvitationMock).toHaveBeenCalledWith("invite-token");
    expect(fetchOrganizationsMock).toHaveBeenCalledTimes(1);
    expect(setCurrentOrganizationIdMock).toHaveBeenCalledWith("org-team");
    expect(setSelectedAssistantMock).toHaveBeenCalledWith(null);
    expect(setActiveAssistantIdMock).toHaveBeenCalledWith(null);
    expect(clearAssistantsMock).toHaveBeenCalledTimes(1);
  });
});
