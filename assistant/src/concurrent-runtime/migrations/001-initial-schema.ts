export const CONCURRENT_RUNTIME_MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS concurrent_runtime_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS concurrent_assistants (
  organization_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  config_version INTEGER NOT NULL DEFAULT 1 CHECK (config_version > 0),
  runtime_generation INTEGER NOT NULL DEFAULT 1 CHECK (runtime_generation > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, assistant_id)
);

CREATE TABLE IF NOT EXISTS concurrent_conversations (
  organization_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  next_turn_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_turn_sequence > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, assistant_id, conversation_id),
  FOREIGN KEY (organization_id, assistant_id)
    REFERENCES concurrent_assistants (organization_id, assistant_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS concurrent_messages (
  organization_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  turn_sequence BIGINT NOT NULL CHECK (turn_sequence > 0),
  turn_position SMALLINT NOT NULL CHECK (turn_position IN (0, 1)),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  client_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, assistant_id, message_id),
  UNIQUE (
    organization_id,
    assistant_id,
    conversation_id,
    turn_sequence,
    turn_position
  ),
  FOREIGN KEY (organization_id, assistant_id, conversation_id)
    REFERENCES concurrent_conversations (
      organization_id,
      assistant_id,
      conversation_id
    )
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS concurrent_runs (
  organization_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  user_message_id TEXT NOT NULL,
  assistant_message_id TEXT,
  turn_sequence BIGINT NOT NULL CHECK (turn_sequence > 0),
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  execution_context JSONB NOT NULL,
  lease_owner TEXT,
  lease_expires_at BIGINT,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, assistant_id, run_id),
  UNIQUE (organization_id, assistant_id, idempotency_key),
  FOREIGN KEY (organization_id, assistant_id, conversation_id)
    REFERENCES concurrent_conversations (
      organization_id,
      assistant_id,
      conversation_id
    )
    ON DELETE CASCADE,
  FOREIGN KEY (organization_id, assistant_id, user_message_id)
    REFERENCES concurrent_messages (
      organization_id,
      assistant_id,
      message_id
    )
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS concurrent_events (
  seq BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message JSONB NOT NULL,
  emitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (organization_id, assistant_id, conversation_id)
    REFERENCES concurrent_conversations (
      organization_id,
      assistant_id,
      conversation_id
    )
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_concurrent_messages_transcript
  ON concurrent_messages (
    organization_id,
    assistant_id,
    conversation_id,
    turn_sequence,
    turn_position
  );
CREATE INDEX IF NOT EXISTS idx_concurrent_runs_status
  ON concurrent_runs (
    organization_id,
    assistant_id,
    status,
    created_at
  );
CREATE INDEX IF NOT EXISTS idx_concurrent_events_replay
  ON concurrent_events (
    organization_id,
    assistant_id,
    conversation_id,
    seq
  );

ALTER TABLE concurrent_assistants ENABLE ROW LEVEL SECURITY;
ALTER TABLE concurrent_assistants FORCE ROW LEVEL SECURITY;
ALTER TABLE concurrent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE concurrent_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE concurrent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE concurrent_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE concurrent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE concurrent_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE concurrent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE concurrent_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS concurrent_assistants_tenant ON concurrent_assistants;
CREATE POLICY concurrent_assistants_tenant ON concurrent_assistants
  USING (
    organization_id = current_setting('worklin.organization_id', true)
    AND assistant_id = current_setting('worklin.assistant_id', true)
  )
  WITH CHECK (
    organization_id = current_setting('worklin.organization_id', true)
    AND assistant_id = current_setting('worklin.assistant_id', true)
  );

DROP POLICY IF EXISTS concurrent_conversations_tenant
  ON concurrent_conversations;
CREATE POLICY concurrent_conversations_tenant ON concurrent_conversations
  USING (
    organization_id = current_setting('worklin.organization_id', true)
    AND assistant_id = current_setting('worklin.assistant_id', true)
  )
  WITH CHECK (
    organization_id = current_setting('worklin.organization_id', true)
    AND assistant_id = current_setting('worklin.assistant_id', true)
  );

DROP POLICY IF EXISTS concurrent_messages_tenant ON concurrent_messages;
CREATE POLICY concurrent_messages_tenant ON concurrent_messages
  USING (
    organization_id = current_setting('worklin.organization_id', true)
    AND assistant_id = current_setting('worklin.assistant_id', true)
  )
  WITH CHECK (
    organization_id = current_setting('worklin.organization_id', true)
    AND assistant_id = current_setting('worklin.assistant_id', true)
  );

DROP POLICY IF EXISTS concurrent_runs_tenant ON concurrent_runs;
CREATE POLICY concurrent_runs_tenant ON concurrent_runs
  USING (
    organization_id = current_setting('worklin.organization_id', true)
    AND assistant_id = current_setting('worklin.assistant_id', true)
  )
  WITH CHECK (
    organization_id = current_setting('worklin.organization_id', true)
    AND assistant_id = current_setting('worklin.assistant_id', true)
  );

DROP POLICY IF EXISTS concurrent_events_tenant ON concurrent_events;
CREATE POLICY concurrent_events_tenant ON concurrent_events
  USING (
    organization_id = current_setting('worklin.organization_id', true)
    AND assistant_id = current_setting('worklin.assistant_id', true)
  )
  WITH CHECK (
    organization_id = current_setting('worklin.organization_id', true)
    AND assistant_id = current_setting('worklin.assistant_id', true)
  );

INSERT INTO concurrent_runtime_schema_migrations (version, name)
VALUES (1, 'initial_concurrent_runtime')
ON CONFLICT (version) DO NOTHING;
`;
