import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { RuntimeWorkerLeaseClaim } from "./auth/types.js";

const MAX_AUTHORITY_FILE_BYTES = 16 * 1_024;

interface AuthorityDocument {
  version: 1;
  worker_stack_id: string;
  authority_generation: number;
  active_lease: {
    organization_id: string;
    user_id: string;
    assistant_id: string;
    worker_stack_id: string;
    lease_generation: number;
    lease_expires_at_ms: number;
  } | null;
}

export type RuntimeWorkerLeaseAuthorityUpdate =
  | "initialized"
  | "installed"
  | "idempotent"
  | "revoked"
  | "already_revoked"
  | "stale";

export function initializeRuntimeWorkerLeaseAuthority(
  authorityFile: string,
  workerStackId: string,
): RuntimeWorkerLeaseAuthorityUpdate {
  const path = assertAuthorityPath(authorityFile);
  const worker = assertOpaqueId(workerStackId, "worker stack");
  ensureAuthorityParent(path);
  if (readAuthorityDocument(path, worker)) return "idempotent";

  writeAuthorityDocument(path, {
    version: 1,
    worker_stack_id: worker,
    authority_generation: 0,
    active_lease: null,
  });
  return "initialized";
}

export function installRuntimeWorkerLeaseAuthority(
  authorityFile: string,
  claim: RuntimeWorkerLeaseClaim,
): RuntimeWorkerLeaseAuthorityUpdate {
  const path = assertAuthorityPath(authorityFile);
  assertClaim(claim);
  const current = readAuthorityDocument(path, claim.worker_stack_id);
  if (current && current.authority_generation > claim.lease_generation) {
    return "stale";
  }
  if (current?.authority_generation === claim.lease_generation) {
    if (!current.active_lease) return "stale";
    if (
      current.active_lease.organization_id !== claim.organization_id ||
      current.active_lease.user_id !== claim.user_id ||
      current.active_lease.assistant_id !== claim.assistant_id ||
      current.active_lease.worker_stack_id !== claim.worker_stack_id
    ) {
      throw new Error("Pooled worker lease authority generation conflicts.");
    }
    if (
      current.active_lease.lease_expires_at_ms >=
      claim.lease_expires_at * 1_000
    ) {
      return "idempotent";
    }
  }

  writeAuthorityDocument(path, {
    version: 1,
    worker_stack_id: claim.worker_stack_id,
    authority_generation: claim.lease_generation,
    active_lease: {
      organization_id: claim.organization_id,
      user_id: claim.user_id,
      assistant_id: claim.assistant_id,
      worker_stack_id: claim.worker_stack_id,
      lease_generation: claim.lease_generation,
      lease_expires_at_ms: claim.lease_expires_at * 1_000,
    },
  });
  return "installed";
}

export function revokeRuntimeWorkerLeaseAuthority(
  authorityFile: string,
  input: {
    workerStackId: string;
    leaseGeneration: number;
  },
): RuntimeWorkerLeaseAuthorityUpdate {
  const path = assertAuthorityPath(authorityFile);
  const workerStackId = assertOpaqueId(input.workerStackId, "worker stack");
  if (
    !Number.isSafeInteger(input.leaseGeneration) ||
    input.leaseGeneration < 1
  ) {
    throw new Error("Pooled worker lease generation is invalid.");
  }
  const current = readAuthorityDocument(path, workerStackId);
  if (current && current.authority_generation > input.leaseGeneration) {
    return "stale";
  }
  if (
    current?.authority_generation === input.leaseGeneration &&
    current.active_lease === null
  ) {
    return "already_revoked";
  }

  writeAuthorityDocument(path, {
    version: 1,
    worker_stack_id: workerStackId,
    authority_generation: input.leaseGeneration,
    active_lease: null,
  });
  return "revoked";
}

function readAuthorityDocument(
  authorityFile: string,
  expectedWorkerStackId: string,
): AuthorityDocument | null {
  assertSafeParent(authorityFile);
  if (!existsSync(authorityFile)) return null;
  const descriptor = openSync(
    authorityFile,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(descriptor);
    const parentStat = lstatSync(dirname(authorityFile));
    if (
      !stat.isFile() ||
      stat.uid !== parentStat.uid ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > MAX_AUTHORITY_FILE_BYTES
    ) {
      throw new Error("Pooled worker lease authority file is unsafe.");
    }
    return parseAuthorityDocument(
      readFileSync(descriptor, "utf8"),
      expectedWorkerStackId,
    );
  } finally {
    closeSync(descriptor);
  }
}

function writeAuthorityDocument(
  authorityFile: string,
  document: AuthorityDocument,
): void {
  const parent = assertSafeParent(authorityFile);
  const temporary = join(
    parent,
    `.lease-authority-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(document)}\n`, {
      encoding: "utf8",
      mode: 0o640,
      flag: "wx",
    });
    chmodSync(temporary, 0o640);
    const descriptor = openSync(
      temporary,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, authorityFile);
    const parentDescriptor = openSync(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      fsyncSync(parentDescriptor);
    } finally {
      closeSync(parentDescriptor);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function parseAuthorityDocument(
  raw: string,
  expectedWorkerStackId: string,
): AuthorityDocument {
  const parsed = JSON.parse(raw) as AuthorityDocument;
  if (
    parsed?.version !== 1 ||
    parsed.worker_stack_id !== expectedWorkerStackId ||
    !Number.isSafeInteger(parsed.authority_generation) ||
    parsed.authority_generation < 0
  ) {
    throw new Error("Pooled worker lease authority file is malformed.");
  }
  if (parsed.active_lease === null) return parsed;
  const active = parsed.active_lease;
  if (
    parsed.authority_generation < 1 ||
    !isOpaqueId(active.organization_id) ||
    !isOpaqueId(active.user_id) ||
    !isOpaqueId(active.assistant_id) ||
    active.worker_stack_id !== expectedWorkerStackId ||
    !Number.isSafeInteger(active.lease_generation) ||
    active.lease_generation !== parsed.authority_generation ||
    !Number.isSafeInteger(active.lease_expires_at_ms) ||
    active.lease_expires_at_ms < 1
  ) {
    throw new Error("Pooled worker lease authority file is malformed.");
  }
  return parsed;
}

function ensureAuthorityParent(authorityFile: string): void {
  const parent = dirname(authorityFile);
  if (existsSync(parent)) {
    assertSafeParent(authorityFile);
    return;
  }

  const grandparent = dirname(parent);
  const grandparentStat = lstatSync(grandparent);
  if (
    !grandparentStat.isDirectory() ||
    grandparentStat.isSymbolicLink() ||
    realpathSync(grandparent) !== resolve(grandparent) ||
    (grandparentStat.mode & 0o002) !== 0 ||
    ((grandparentStat.mode & 0o020) !== 0 &&
      (grandparentStat.mode & 0o2000) === 0)
  ) {
    throw new Error("Pooled worker lease authority parent is unsafe.");
  }
  mkdirSync(parent, { mode: 0o750 });
  chmodSync(parent, 0o750);
  assertSafeParent(authorityFile);
}

function assertSafeParent(authorityFile: string): string {
  const parent = dirname(authorityFile);
  const stat = lstatSync(parent);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(parent) !== resolve(parent) ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error("Pooled worker lease authority directory is unsafe.");
  }
  return parent;
}

function assertAuthorityPath(value: string): string {
  if (
    !value ||
    value !== value.trim() ||
    !isAbsolute(value) ||
    value.includes("\u0000")
  ) {
    throw new Error("Pooled worker lease authority path is invalid.");
  }
  return value;
}

function assertClaim(claim: RuntimeWorkerLeaseClaim): void {
  assertOpaqueId(claim.organization_id, "organization");
  assertOpaqueId(claim.user_id, "user");
  assertOpaqueId(claim.assistant_id, "assistant");
  assertOpaqueId(claim.worker_stack_id, "worker stack");
  if (
    claim.version !== 1 ||
    claim.issuer_service_id !== "runtime_dispatcher" ||
    !Number.isSafeInteger(claim.lease_generation) ||
    claim.lease_generation < 1 ||
    !Number.isSafeInteger(claim.lease_expires_at) ||
    claim.lease_expires_at < 1
  ) {
    throw new Error("Pooled worker lease claim is invalid.");
  }
}

function assertOpaqueId(value: string, label: string): string {
  if (!isOpaqueId(value)) {
    throw new Error(`Pooled worker ${label} identity is invalid.`);
  }
  return value;
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
