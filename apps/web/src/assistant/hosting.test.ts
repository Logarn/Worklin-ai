import { describe, expect, test } from "bun:test";

import {
  filterHostedAssistants,
  firstHostedAssistant,
  hostedRuntimeConnection,
  isHostedAssistant,
  isPlatformManagedAssistant,
} from "@/assistant/hosting";

describe("assistant hosting helpers", () => {
  test("treats is_local assistants as non-hosted", () => {
    expect(isHostedAssistant({ is_local: false })).toBe(true);
    expect(isHostedAssistant({ is_local: true })).toBe(false);
  });

  test("treats platform-managed proxy descriptors as hosted", () => {
    expect(
      isPlatformManagedAssistant({
        is_local: true,
        ingress_url: "https://worklin-ai-production.up.railway.app",
        platform_actor_token: "actor-token-1",
      }),
    ).toBe(true);
  });

  test("filters self-hosted assistants out of mixed platform lists", () => {
    const assistants = [
      { id: "self-hosted", is_local: true },
      {
        id: "managed-via-proxy",
        is_local: true,
        ingress_url: "https://worklin-ai-production.up.railway.app",
        platform_actor_token: "actor-token-1",
      },
      { id: "hosted-a", is_local: false },
      { id: "hosted-b", is_local: false },
    ];

    expect(filterHostedAssistants(assistants)).toEqual([
      {
        id: "managed-via-proxy",
        is_local: true,
        ingress_url: "https://worklin-ai-production.up.railway.app",
        platform_actor_token: "actor-token-1",
      },
      { id: "hosted-a", is_local: false },
      { id: "hosted-b", is_local: false },
    ]);
  });

  test("picks the first hosted assistant-like entry and ignores local-only rows", () => {
    const assistants = [
      { id: "self-hosted", is_local: true },
      {
        id: "managed-via-proxy",
        is_local: true,
        ingress_url: "https://worklin-ai-production.up.railway.app",
        platform_actor_token: "actor-token-1",
      },
    ];

    expect(firstHostedAssistant(assistants)).toEqual({
      id: "managed-via-proxy",
      is_local: true,
      ingress_url: "https://worklin-ai-production.up.railway.app",
      platform_actor_token: "actor-token-1",
    });
    expect(firstHostedAssistant([{ id: "self-hosted", is_local: true }])).toBe(
      null,
    );
  });

  test("extracts the runtime connection for platform-managed descriptors", () => {
    expect(
      hostedRuntimeConnection({
        is_local: false,
        ingress_url: "https://worklin-ai.vercel.app",
        platform_actor_token: "actor-token-1",
      }),
    ).toEqual({
      url: "https://worklin-ai.vercel.app",
      token: "actor-token-1",
    });

    expect(hostedRuntimeConnection({ is_local: true })).toBeNull();
  });
});
