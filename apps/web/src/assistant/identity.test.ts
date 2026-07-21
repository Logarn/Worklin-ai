import { afterEach, describe, expect, mock, test } from "bun:test";

import { client } from "@/generated/daemon/client.gen";
import type { IdentityGetResponse } from "@/generated/daemon/types.gen";
import { ApiError } from "@/utils/api-errors";

import {
  IdentityResponseValidationError,
  updateAssistantIdentity,
} from "./identity";

const savedIdentity: IdentityGetResponse = {
  name: "North Star",
  role: "Lifecycle marketing partner",
  personality: "Clear, curious, and candid",
  emoji: ":sparkles:",
  home: "",
  version: "0.8.12",
};

type CapturedPatchOptions = {
  url: string;
  path?: unknown;
  body?: unknown;
  headers?: unknown;
  throwOnError?: boolean;
};

const originalPatch = client.patch;
let capturedPatch: CapturedPatchOptions | null = null;

function stubPatch(result: {
  data: unknown;
  error: unknown;
  response?: Response;
}): void {
  capturedPatch = null;
  client.patch = mock(async (options: CapturedPatchOptions) => {
    capturedPatch = options;
    return result;
  }) as typeof client.patch;
}

afterEach(() => {
  client.patch = originalPatch;
  capturedPatch = null;
});

describe("updateAssistantIdentity", () => {
  test("sends the identity patch to the selected assistant", async () => {
    stubPatch({
      data: savedIdentity,
      error: undefined,
      response: new Response(null, { status: 200 }),
    });

    const result = await updateAssistantIdentity("assistant-123", {
      role: "Lifecycle marketing partner",
    });

    expect(capturedPatch).toEqual({
      url: "/v1/assistants/{assistant_id}/identity",
      path: { assistant_id: "assistant-123" },
      body: { role: "Lifecycle marketing partner" },
      headers: { "Content-Type": "application/json" },
      throwOnError: false,
    });
    expect(result).toEqual(savedIdentity);
  });

  test("rejects a success response that does not contain the saved value", async () => {
    stubPatch({
      data: { ...savedIdentity, role: "Research partner" },
      error: undefined,
      response: new Response(null, { status: 200 }),
    });

    const error = await updateAssistantIdentity("assistant-123", {
      role: "Lifecycle marketing partner",
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(IdentityResponseValidationError);
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as { status?: number }).status).toBeUndefined();
    expect((error as Error).message).toContain("could not be verified");
  });

  test("surfaces persistence errors instead of returning success", async () => {
    stubPatch({
      data: undefined,
      error: {
        error: {
          code: "INTERNAL_ERROR",
          message: "Could not save the assistant identity.",
        },
      },
      response: new Response(null, { status: 500 }),
    });

    await expect(
      updateAssistantIdentity("assistant-123", {
        personality: "Warm and precise",
      }),
    ).rejects.toThrow("Could not save the assistant identity.");
  });
});
