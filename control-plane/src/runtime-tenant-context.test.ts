import { describe, expect, test } from "bun:test";

import type { AssistantRow } from "./assistant-store.js";
import type { RuntimeStackRow } from "./runtime-stacks.js";
import {
  createRuntimeTenantContext,
  RuntimeTenantContextError,
} from "./runtime-tenant-context.js";

const assistant: AssistantRow = {
  id: "assistant-1",
  user_id: "user-1",
  org_id: "org-1",
  name: "Worklin",
  runtime_stack_id: "runtime-1",
  isolation_version: 2,
  admin_access_consented: 0,
  is_default: 1,
  created_at: "2026-07-20T00:00:00.000Z",
  updated_at: "2026-07-20T00:00:00.000Z",
};

const runtimeStack: RuntimeStackRow = {
  id: "runtime-1",
  org_id: "org-1",
  assistant_id: "assistant-1",
  status: "active",
  provider: "railway",
  gateway_url: "http://runtime.internal:8080",
  public_ingress_url: null,
  workspace_volume_ref: "volume-1",
  service_ref: "service-1",
  service_capacity_reserved: 1,
  service_create_attempted_at: null,
  volume_create_attempted_at: null,
  provisioning_lease_token: null,
  provisioning_lease_expires_at: null,
  actor_signing_key_scope: "runtime_v1:runtime-1",
  last_health_status: "200",
  last_error: null,
  created_at: "2026-07-20T00:00:00.000Z",
  updated_at: "2026-07-20T00:00:00.000Z",
};

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

describe("runtime tenant context", () => {
  test("binds the assistant owner, organization, runtime, and request", () => {
    expect(
      createRuntimeTenantContext(assistant, "user-1", runtimeStack, REQUEST_ID),
    ).toEqual({
      version: 1,
      organizationId: "org-1",
      userId: "user-1",
      assistantId: "assistant-1",
      actorId: "vellum-principal-user-1",
      requestId: REQUEST_ID,
    });
  });

  test("binds an assigned collaborator to the same assistant runtime", () => {
    expect(
      createRuntimeTenantContext(
        assistant,
        "user-2",
        runtimeStack,
        "22222222-2222-4222-8222-222222222222",
      ),
    ).toMatchObject({
      organizationId: "org-1",
      userId: "user-2",
      assistantId: "assistant-1",
      actorId: "vellum-principal-user-2",
    });
  });

  test("rejects a runtime stack belonging to another assistant", () => {
    expect(() =>
      createRuntimeTenantContext(
        assistant,
        "user-2",
        { ...runtimeStack, assistant_id: "assistant-2" },
        "33333333-3333-4333-8333-333333333333",
      ),
    ).toThrow(RuntimeTenantContextError);
  });
});
