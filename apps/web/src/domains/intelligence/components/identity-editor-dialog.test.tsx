import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import type { IdentityGetResponse } from "@/generated/daemon/types.gen";
import { assistantIdentityQueryKey } from "@/lib/sync/query-tags";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import { applySavedIdentity } from "./identity-save-cache";

const savedIdentity: IdentityGetResponse = {
  name: "North Star",
  role: "Lifecycle marketing partner",
  personality: "Clear, curious, and candid",
  emoji: ":sparkles:",
  home: "",
  version: "0.8.12",
};

const updateAssistantIdentity = mock(
  async (): Promise<IdentityGetResponse> => savedIdentity,
);
const captureError = mock(() => {});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

mock.module("@/assistant/identity", () => ({
  updateAssistantIdentity,
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError,
}));

const { IdentityEditorDialog } = await import("./identity-editor-dialog");

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
  updateAssistantIdentity.mockClear();
  updateAssistantIdentity.mockImplementation(async () => savedIdentity);
  captureError.mockClear();
});

describe("IdentityEditorDialog", () => {
  test("closes only after the server returns the persisted identity", async () => {
    const onClose = mock(() => {});
    const onSaved = mock(() => {});

    render(
      <IdentityEditorDialog
        assistantId="assistant-123"
        field="role"
        initialValue=""
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "  Lifecycle marketing partner  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateAssistantIdentity).toHaveBeenCalledWith("assistant-123", {
        role: "Lifecycle marketing partner",
      });
      expect(onSaved).toHaveBeenCalledWith("assistant-123", savedIdentity);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  test("refreshes assistant A's cache without touching active assistant B", async () => {
    const onClose = mock(() => {});
    const queryClient = new QueryClient();
    const assistantBIdentity: IdentityGetResponse = {
      ...savedIdentity,
      name: "Assistant B",
      role: "Active role",
      version: "0.9.0",
    };
    queryClient.setQueryData(
      assistantIdentityQueryKey("assistant-b"),
      assistantBIdentity,
    );
    useAssistantIdentityStore
      .getState()
      .setIdentity(assistantBIdentity.name, assistantBIdentity.version);
    useResolvedAssistantsStore.setState({
      activeAssistantId: "assistant-b",
    });
    const onSaved = mock(
      (savedAssistantId: string, identity: IdentityGetResponse) => {
        applySavedIdentity({
          identity,
          queryClient,
          savedAssistantId,
        });
      },
    );
    const deferred = createDeferred<IdentityGetResponse>();
    updateAssistantIdentity.mockImplementationOnce(() => deferred.promise);

    const view = render(
      <IdentityEditorDialog
        key="assistant-a:role"
        assistantId="assistant-a"
        field="role"
        initialValue="Old role"
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "Saved for assistant A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateAssistantIdentity).toHaveBeenCalledWith("assistant-a", {
        role: "Saved for assistant A",
      });
    });

    view.rerender(
      <IdentityEditorDialog
        key="assistant-b:role"
        assistantId="assistant-b"
        field="role"
        initialValue="Assistant B role"
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    expect((screen.getByLabelText("Role") as HTMLTextAreaElement).value).toBe(
      "Assistant B role",
    );

    deferred.resolve(savedIdentity);
    await deferred.promise;
    await Promise.resolve();

    expect(onSaved).toHaveBeenCalledWith("assistant-a", savedIdentity);
    expect(
      queryClient.getQueryData<IdentityGetResponse>(
        assistantIdentityQueryKey("assistant-a"),
      ),
    ).toEqual(savedIdentity);
    expect(
      queryClient.getQueryData<IdentityGetResponse>(
        assistantIdentityQueryKey("assistant-b"),
      ),
    ).toEqual(assistantBIdentity);
    expect(useAssistantIdentityStore.getState()).toMatchObject({
      name: "Assistant B",
      version: "0.9.0",
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(captureError).not.toHaveBeenCalled();
  });

  test("rejects multiline values before sending them to the server", () => {
    const onClose = mock(() => {});
    const onSaved = mock(() => {});

    render(
      <IdentityEditorDialog
        assistantId="assistant-123"
        field="personality"
        initialValue="Thoughtful"
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByLabelText("Personality"), {
      target: { value: "Warm\nand precise" },
    });

    expect(
      screen.getByText("Personality must be a single line."),
    ).not.toBeNull();
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(updateAssistantIdentity).not.toHaveBeenCalled();
  });

  test("keeps the editor open and shows the error when persistence fails", async () => {
    const onClose = mock(() => {});
    const onSaved = mock(() => {});
    updateAssistantIdentity.mockRejectedValueOnce(
      new Error("Could not save the assistant identity."),
    );

    render(
      <IdentityEditorDialog
        assistantId="assistant-123"
        field="personality"
        initialValue="Thoughtful"
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByLabelText("Personality"), {
      target: { value: "Warm and precise" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Could not save the assistant identity."),
    ).not.toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("dialog", { name: "Edit personality" }),
    ).not.toBeNull();
  });
});
