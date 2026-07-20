import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const upsertContactMock = mock(async () => {
  throw new Error("Contact service is temporarily unavailable");
});
const toastErrorMock = mock((_message: string) => {});

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    error: toastErrorMock,
    success: () => {},
  },
}));

mock.module("@/components/mobile-sidebar-drawer", () => ({
  MobileSidebarDrawer: () => null,
  MobileSidebarTrigger: () => null,
}));

mock.module("@/domains/contacts/components/assistant-channels-detail", () => ({
  AssistantChannelsDetail: () => null,
}));
mock.module("@/domains/contacts/components/contact-detail-view", () => ({
  ContactDetailView: () => null,
}));
mock.module("@/domains/contacts/components/contact-merge-dialog", () => ({
  ContactMergeDialog: () => null,
}));
mock.module("@/domains/contacts/components/contacts-list", () => ({
  ContactsList: ({ onAddContact }: { onAddContact: () => void }) => (
    <button type="button" onClick={onAddContact}>
      Add Contact
    </button>
  ),
}));
mock.module(
  "@/domains/contacts/components/generate-invite-link-dialog",
  () => ({
    GenerateInviteLinkDialog: () => null,
  }),
);
mock.module("@/domains/contacts/components/guardian-detail-view", () => ({
  GuardianDetailView: () => null,
}));

mock.module("@/domains/contacts/contacts-gateway", () => ({
  deleteContact: async () => {},
  upsertContact: upsertContactMock,
  verifyContactChannel: async () => {},
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  channelsAvailableGetOptions: () => ({
    queryKey: ["channels-available"],
    queryFn: async () => ({ channels: [] }),
  }),
  channelsReadinessGetOptions: () => ({
    queryKey: ["channels-readiness"],
    queryFn: async () => ({ snapshots: [] }),
  }),
  channelsReadinessGetQueryKey: () => ["channels-readiness"],
  contactsGetOptions: () => ({
    queryKey: ["contacts"],
    queryFn: async () => ({ contacts: [] }),
  }),
  contactsGetQueryKey: () => ["contacts"],
  contactsGetSetQueryData: () => {},
  useContactchannelsByContactChannelIdPatchMutation: () => ({
    mutate: () => {},
  }),
  useContactsMergePostMutation: () => ({
    error: null,
    isPending: false,
    mutate: () => {},
    reset: () => {},
  }),
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  channelsAvailableGet: async () => ({
    data: { channels: [] },
    error: undefined,
    response: new Response(null, { status: 200 }),
  }),
  integrationsSlackChannelConfigDelete: async () => {},
  integrationsSlackChannelConfigPost: async () => {},
  integrationsTelegramConfigDelete: async () => {},
  integrationsTelegramConfigPost: async () => {},
  integrationsTwilioCredentialsDelete: async () => {},
  integrationsTwilioCredentialsPost: async () => {},
}));

mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: {
      a2aChannel: () => false,
    },
  },
}));
mock.module("@/stores/assistant-identity-store", () => ({
  useAssistantIdentityStore: {
    use: {
      name: () => "Test Assistant",
    },
  },
}));

const { ContactsPage } = await import("@/domains/contacts/contacts-page");

afterEach(() => {
  cleanup();
  upsertContactMock.mockClear();
  toastErrorMock.mockClear();
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <ContactsPage assistantId="assistant-1" />
    </QueryClientProvider>,
  );
}

describe("ContactsPage", () => {
  test("shows the contact creation failure instead of returning silently", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Add Contact" }));

    await waitFor(() => {
      expect(upsertContactMock).toHaveBeenCalledWith("assistant-1", {
        displayName: "New Contact",
      });
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Couldn't add contact. Please try again.",
      );
    });
  });
});
