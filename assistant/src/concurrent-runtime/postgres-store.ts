import { randomUUID } from "node:crypto";

import {
  type TenantExecutionContext,
  TenantExecutionContextSchema,
} from "@vellumai/service-contracts/tenant-context";
import postgres from "postgres";

import { CONCURRENT_RUNTIME_MIGRATION_001 } from "./migrations/001-initial-schema.js";
import {
  type ConcurrentRuntimeStore,
  ConcurrentRuntimeStoreError,
} from "./store.js";
import type {
  AcceptConcurrentMessageInput,
  AcceptedConcurrentRun,
  ClaimedConcurrentRun,
  CompleteConcurrentRunInput,
  ConcurrentEvent,
  ConcurrentMessage,
  ConcurrentRun,
  FailConcurrentRunInput,
} from "./types.js";

type Sql = ReturnType<typeof postgres>;

interface TransactionSql extends postgres.TransactionSql {
  <T extends readonly (object | undefined)[] = postgres.Row[]>(
    template: TemplateStringsArray,
    ...parameters: readonly postgres.SerializableParameter[]
  ): postgres.PendingQuery<T>;
}

interface MessageRow {
  organization_id: string;
  assistant_id: string;
  conversation_id: string;
  message_id: string;
  role: "user" | "assistant";
  content: string;
  client_message_id: string | null;
  created_at: Date | string;
}

interface RunRow {
  organization_id: string;
  assistant_id: string;
  conversation_id: string;
  run_id: string;
  request_id: string;
  idempotency_key: string;
  user_message_id: string;
  assistant_message_id: string | null;
  status: ConcurrentRun["status"];
  execution_context: unknown;
  lease_owner: string | null;
  lease_expires_at: number | string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EventRow {
  seq: number | string;
  event_id: string;
  organization_id: string;
  assistant_id: string;
  conversation_id: string;
  message: Record<string, unknown>;
  emitted_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function numberOrUndefined(value: number | string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapMessage(row: MessageRow): ConcurrentMessage {
  return {
    id: row.message_id,
    organizationId: row.organization_id,
    assistantId: row.assistant_id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    ...(row.client_message_id
      ? { clientMessageId: row.client_message_id }
      : {}),
    createdAt: iso(row.created_at),
  };
}

function mapRun(row: RunRow): ConcurrentRun {
  return {
    id: row.run_id,
    organizationId: row.organization_id,
    assistantId: row.assistant_id,
    conversationId: row.conversation_id,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    userMessageId: row.user_message_id,
    ...(row.assistant_message_id
      ? { assistantMessageId: row.assistant_message_id }
      : {}),
    status: row.status,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(numberOrUndefined(row.lease_expires_at) !== undefined
      ? { leaseExpiresAt: numberOrUndefined(row.lease_expires_at) }
      : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapEvent(row: EventRow): ConcurrentEvent {
  return {
    id: row.event_id,
    organizationId: row.organization_id,
    assistantId: row.assistant_id,
    conversationId: row.conversation_id,
    seq: Number(row.seq),
    emittedAt: iso(row.emitted_at),
    message: row.message,
  };
}

async function setTenantContext(
  sql: TransactionSql,
  context: TenantExecutionContext,
): Promise<void> {
  await sql`
    SELECT
      set_config('worklin.organization_id', ${context.organizationId}, true),
      set_config('worklin.assistant_id', ${context.assistantId}, true)
  `;
}

export interface PostgresConcurrentRuntimeStoreOptions {
  applicationDatabaseUrl: string;
  migrationDatabaseUrl?: string;
  maxConnections?: number;
}

export class PostgresConcurrentRuntimeStore implements ConcurrentRuntimeStore {
  private readonly sql: Sql;
  private readonly migrationSql: Sql;
  private readonly ownsMigrationConnection: boolean;

  constructor(options: PostgresConcurrentRuntimeStoreOptions) {
    if (!options.applicationDatabaseUrl.trim()) {
      throw new Error("Concurrent runtime database URL is required.");
    }
    this.sql = postgres(options.applicationDatabaseUrl, {
      max: options.maxConnections ?? 20,
      prepare: true,
    });
    if (
      options.migrationDatabaseUrl &&
      options.migrationDatabaseUrl !== options.applicationDatabaseUrl
    ) {
      this.migrationSql = postgres(options.migrationDatabaseUrl, {
        max: 1,
        prepare: false,
      });
      this.ownsMigrationConnection = true;
    } else {
      this.migrationSql = this.sql;
      this.ownsMigrationConnection = false;
    }
  }

  private transaction<T>(
    callback: (sql: TransactionSql) => Promise<T>,
  ): Promise<T> {
    return this.sql.begin((sql) =>
      callback(sql as TransactionSql),
    ) as Promise<T>;
  }

  async initialize(): Promise<void> {
    await this.migrationSql.unsafe(CONCURRENT_RUNTIME_MIGRATION_001);
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
    if (this.ownsMigrationConnection) {
      await this.migrationSql.end({ timeout: 5 });
    }
  }

  async acceptMessage(
    context: TenantExecutionContext,
    input: AcceptConcurrentMessageInput,
  ): Promise<AcceptedConcurrentRun> {
    const idempotencyKey =
      context.idempotencyKey ?? input.clientMessageId ?? context.requestId;
    const conversationId =
      input.conversationId ?? context.conversationId ?? randomUUID();
    if (
      context.conversationId &&
      input.conversationId &&
      context.conversationId !== input.conversationId
    ) {
      throw new ConcurrentRuntimeStoreError(
        "Conversation identity does not match the execution context.",
        "tenant_mismatch",
      );
    }

    return this.transaction(async (tx) => {
      await setTenantContext(tx, context);
      await tx`
        INSERT INTO concurrent_assistants (
          organization_id,
          assistant_id,
          config_version,
          runtime_generation
        ) VALUES (
          ${context.organizationId},
          ${context.assistantId},
          ${context.configVersion},
          ${context.runtimeGeneration}
        )
        ON CONFLICT (organization_id, assistant_id) DO NOTHING
      `;
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${JSON.stringify([
              context.organizationId,
              context.assistantId,
              idempotencyKey,
            ])},
            0
          )
        )
      `;

      const existingRuns = await tx<RunRow[]>`
        SELECT *
        FROM concurrent_runs
        WHERE organization_id = ${context.organizationId}
          AND assistant_id = ${context.assistantId}
          AND idempotency_key = ${idempotencyKey}
        LIMIT 1
      `;
      const existingRun = existingRuns[0];
      if (existingRun) {
        const [messageRow] = await tx<MessageRow[]>`
          SELECT *
          FROM concurrent_messages
          WHERE organization_id = ${context.organizationId}
            AND assistant_id = ${context.assistantId}
            AND message_id = ${existingRun.user_message_id}
        `;
        const [eventRow] = await tx<EventRow[]>`
          SELECT *
          FROM concurrent_events
          WHERE organization_id = ${context.organizationId}
            AND assistant_id = ${context.assistantId}
            AND conversation_id = ${existingRun.conversation_id}
            AND message->>'type' = 'user_message_echo'
            AND message->>'messageId' = ${existingRun.user_message_id}
          ORDER BY seq
          LIMIT 1
        `;
        if (!messageRow || !eventRow) {
          throw new ConcurrentRuntimeStoreError(
            "Idempotent run has incomplete persisted state.",
            "invalid_state",
          );
        }
        return {
          created: false,
          conversationId: existingRun.conversation_id,
          userMessage: mapMessage(messageRow),
          run: mapRun(existingRun),
          event: mapEvent(eventRow),
        };
      }

      await tx`
        INSERT INTO concurrent_conversations (
          organization_id,
          assistant_id,
          conversation_id
        ) VALUES (
          ${context.organizationId},
          ${context.assistantId},
          ${conversationId}
        )
        ON CONFLICT (
          organization_id,
          assistant_id,
          conversation_id
        ) DO NOTHING
      `;
      const [sequenceRow] = await tx<{ turn_sequence: string | number }[]>`
        UPDATE concurrent_conversations
        SET next_turn_sequence = next_turn_sequence + 1,
            updated_at = NOW()
        WHERE organization_id = ${context.organizationId}
          AND assistant_id = ${context.assistantId}
          AND conversation_id = ${conversationId}
        RETURNING next_turn_sequence - 1 AS turn_sequence
      `;
      if (!sequenceRow) {
        throw new ConcurrentRuntimeStoreError(
          "Conversation turn allocation failed.",
          "conversation_not_found",
        );
      }

      const userMessageId = randomUUID();
      const runId = randomUUID();
      const eventId = randomUUID();
      const executionContext: TenantExecutionContext = {
        ...context,
        conversationId,
        idempotencyKey,
      };
      const echo = {
        type: "user_message_echo",
        text: input.content,
        conversationId,
        messageId: userMessageId,
        requestId: context.requestId,
        ...(input.clientMessageId
          ? { clientMessageId: input.clientMessageId }
          : {}),
      };

      const [messageRow] = await tx<MessageRow[]>`
        INSERT INTO concurrent_messages (
          organization_id,
          assistant_id,
          conversation_id,
          message_id,
          turn_sequence,
          turn_position,
          role,
          content,
          client_message_id
        ) VALUES (
          ${context.organizationId},
          ${context.assistantId},
          ${conversationId},
          ${userMessageId},
          ${sequenceRow.turn_sequence},
          0,
          'user',
          ${input.content},
          ${input.clientMessageId ?? null}
        )
        RETURNING *
      `;
      const [runRow] = await tx<RunRow[]>`
        INSERT INTO concurrent_runs (
          organization_id,
          assistant_id,
          conversation_id,
          run_id,
          request_id,
          idempotency_key,
          user_message_id,
          turn_sequence,
          status,
          execution_context
        ) VALUES (
          ${context.organizationId},
          ${context.assistantId},
          ${conversationId},
          ${runId},
          ${context.requestId},
          ${idempotencyKey},
          ${userMessageId},
          ${sequenceRow.turn_sequence},
          'queued',
          ${tx.json(executionContext)}
        )
        RETURNING *
      `;
      const [eventRow] = await tx<EventRow[]>`
        INSERT INTO concurrent_events (
          event_id,
          organization_id,
          assistant_id,
          conversation_id,
          message
        ) VALUES (
          ${eventId},
          ${context.organizationId},
          ${context.assistantId},
          ${conversationId},
          ${tx.json(echo)}
        )
        RETURNING *
      `;
      if (!messageRow || !runRow || !eventRow) {
        throw new ConcurrentRuntimeStoreError(
          "Message acceptance did not return persisted rows.",
          "invalid_state",
        );
      }
      return {
        created: true,
        conversationId,
        userMessage: mapMessage(messageRow),
        run: mapRun(runRow),
        event: mapEvent(eventRow),
      };
    });
  }

  async claimRun(
    context: TenantExecutionContext,
    runId: string,
    leaseOwner: string,
    leaseExpiresAt: number,
  ): Promise<ClaimedConcurrentRun | null> {
    return this.transaction(async (tx) => {
      await setTenantContext(tx, context);
      const [runRow] = await tx<RunRow[]>`
        UPDATE concurrent_runs
        SET status = 'processing',
            lease_owner = ${leaseOwner},
            lease_expires_at = ${leaseExpiresAt},
            updated_at = NOW()
        WHERE organization_id = ${context.organizationId}
          AND assistant_id = ${context.assistantId}
          AND run_id = ${runId}
          AND (
            status = 'queued'
            OR (
              status = 'processing'
              AND lease_expires_at <= ${Date.now()}
            )
          )
        RETURNING *
      `;
      if (!runRow) return null;
      const messages = await tx<MessageRow[]>`
        SELECT message.*
        FROM concurrent_messages AS message
        JOIN concurrent_runs AS run
          ON run.organization_id = message.organization_id
         AND run.assistant_id = message.assistant_id
         AND run.conversation_id = message.conversation_id
        WHERE run.organization_id = ${context.organizationId}
          AND run.assistant_id = ${context.assistantId}
          AND run.run_id = ${runId}
          AND (
            message.turn_sequence < run.turn_sequence
            OR (
              message.turn_sequence = run.turn_sequence
              AND message.turn_position = 0
            )
          )
        ORDER BY message.turn_sequence, message.turn_position
      `;
      return {
        context: TenantExecutionContextSchema.parse(runRow.execution_context),
        run: mapRun(runRow),
        messages: messages.map(mapMessage),
      };
    });
  }

  async renewRunLease(
    context: TenantExecutionContext,
    runId: string,
    leaseOwner: string,
    leaseExpiresAt: number,
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      await setTenantContext(tx, context);
      const result = await tx`
        UPDATE concurrent_runs
        SET lease_expires_at = ${leaseExpiresAt},
            updated_at = NOW()
        WHERE organization_id = ${context.organizationId}
          AND assistant_id = ${context.assistantId}
          AND run_id = ${runId}
          AND status = 'processing'
          AND lease_owner = ${leaseOwner}
      `;
      return result.count === 1;
    });
  }

  async completeRun(
    context: TenantExecutionContext,
    runId: string,
    input: CompleteConcurrentRunInput,
  ): Promise<ConcurrentMessage> {
    return this.transaction(async (tx) => {
      await setTenantContext(tx, context);
      const [runRow] = await tx<
        (RunRow & { turn_sequence: number | string })[]
      >`
        SELECT *
        FROM concurrent_runs
        WHERE organization_id = ${context.organizationId}
          AND assistant_id = ${context.assistantId}
          AND run_id = ${runId}
          AND status = 'processing'
          AND lease_owner = ${input.leaseOwner}
        FOR UPDATE
      `;
      if (!runRow) {
        throw new ConcurrentRuntimeStoreError(
          "Run lease is no longer owned by this worker.",
          "lease_lost",
        );
      }
      const [messageRow] = await tx<MessageRow[]>`
        INSERT INTO concurrent_messages (
          organization_id,
          assistant_id,
          conversation_id,
          message_id,
          turn_sequence,
          turn_position,
          role,
          content
        ) VALUES (
          ${context.organizationId},
          ${context.assistantId},
          ${runRow.conversation_id},
          ${input.assistantMessageId},
          ${runRow.turn_sequence},
          1,
          'assistant',
          ${input.content}
        )
        RETURNING *
      `;
      await tx`
        UPDATE concurrent_runs
        SET status = 'completed',
            assistant_message_id = ${input.assistantMessageId},
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
        WHERE organization_id = ${context.organizationId}
          AND assistant_id = ${context.assistantId}
          AND run_id = ${runId}
          AND lease_owner = ${input.leaseOwner}
      `;
      if (!messageRow) {
        throw new ConcurrentRuntimeStoreError(
          "Assistant message persistence failed.",
          "invalid_state",
        );
      }
      return mapMessage(messageRow);
    });
  }

  async failRun(
    context: TenantExecutionContext,
    runId: string,
    input: FailConcurrentRunInput,
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      await setTenantContext(tx, context);
      const result = await tx`
        UPDATE concurrent_runs
        SET status = 'failed',
            error_code = ${input.errorCode},
            error_message = ${input.errorMessage.slice(0, 2_000)},
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
        WHERE organization_id = ${context.organizationId}
          AND assistant_id = ${context.assistantId}
          AND run_id = ${runId}
          AND status = 'processing'
          AND lease_owner = ${input.leaseOwner}
      `;
      return result.count === 1;
    });
  }

  async cancelRun(
    context: TenantExecutionContext,
    runId: string,
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      await setTenantContext(tx, context);
      const result = await tx`
        UPDATE concurrent_runs
        SET status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
        WHERE organization_id = ${context.organizationId}
          AND assistant_id = ${context.assistantId}
          AND run_id = ${runId}
          AND status IN ('queued', 'processing')
      `;
      return result.count === 1;
    });
  }

  async cancelConversationRuns(
    context: TenantExecutionContext,
    conversationId: string,
  ): Promise<ConcurrentRun[]> {
    return this.transaction(async (tx) => {
      await setTenantContext(tx, context);
      const rows = await tx<RunRow[]>`
        UPDATE concurrent_runs
        SET status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
        WHERE organization_id = ${context.organizationId}
          AND assistant_id = ${context.assistantId}
          AND conversation_id = ${conversationId}
          AND status IN ('queued', 'processing')
        RETURNING *
      `;
      return rows.map(mapRun);
    });
  }

  async getRun(
    context: TenantExecutionContext,
    runId: string,
  ): Promise<ConcurrentRun | null> {
    return this.transaction(async (tx) => {
      await setTenantContext(tx, context);
      const [row] = await tx<RunRow[]>`
        SELECT *
        FROM concurrent_runs
        WHERE organization_id = ${context.organizationId}
          AND assistant_id = ${context.assistantId}
          AND run_id = ${runId}
      `;
      return row ? mapRun(row) : null;
    });
  }

  async listMessages(
    context: TenantExecutionContext,
    conversationId: string,
  ): Promise<ConcurrentMessage[]> {
    return this.transaction(async (tx) => {
      await setTenantContext(tx, context);
      const rows = await tx<MessageRow[]>`
        SELECT *
        FROM concurrent_messages
        WHERE organization_id = ${context.organizationId}
          AND assistant_id = ${context.assistantId}
          AND conversation_id = ${conversationId}
        ORDER BY turn_sequence, turn_position
      `;
      return rows.map(mapMessage);
    });
  }

  async hasActiveRun(
    context: TenantExecutionContext,
    conversationId: string,
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      await setTenantContext(tx, context);
      const [row] = await tx<{ active: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM concurrent_runs
          WHERE organization_id = ${context.organizationId}
            AND assistant_id = ${context.assistantId}
            AND conversation_id = ${conversationId}
            AND status IN ('queued', 'processing')
        ) AS active
      `;
      return row?.active === true;
    });
  }

  async appendEvent(
    context: TenantExecutionContext,
    conversationId: string,
    message: Record<string, unknown>,
  ): Promise<ConcurrentEvent> {
    return this.transaction(async (tx) => {
      await setTenantContext(tx, context);
      const [row] = await tx<EventRow[]>`
        INSERT INTO concurrent_events (
          event_id,
          organization_id,
          assistant_id,
          conversation_id,
          message
        ) VALUES (
          ${randomUUID()},
          ${context.organizationId},
          ${context.assistantId},
          ${conversationId},
          ${tx.json(message as postgres.JSONValue)}
        )
        RETURNING *
      `;
      if (!row) {
        throw new ConcurrentRuntimeStoreError(
          "Event persistence failed.",
          "invalid_state",
        );
      }
      return mapEvent(row);
    });
  }

  async listEvents(
    context: TenantExecutionContext,
    input: {
      afterSeq: number;
      conversationId?: string;
      limit: number;
    },
  ): Promise<ConcurrentEvent[]> {
    const limit = Math.max(1, Math.min(1_000, input.limit));
    return this.transaction(async (tx) => {
      await setTenantContext(tx, context);
      const rows = input.conversationId
        ? await tx<EventRow[]>`
            SELECT *
            FROM concurrent_events
            WHERE organization_id = ${context.organizationId}
              AND assistant_id = ${context.assistantId}
              AND conversation_id = ${input.conversationId}
              AND seq > ${input.afterSeq}
            ORDER BY seq
            LIMIT ${limit}
          `
        : await tx<EventRow[]>`
            SELECT *
            FROM concurrent_events
            WHERE organization_id = ${context.organizationId}
              AND assistant_id = ${context.assistantId}
              AND seq > ${input.afterSeq}
            ORDER BY seq
            LIMIT ${limit}
          `;
      return rows.map(mapEvent);
    });
  }
}
