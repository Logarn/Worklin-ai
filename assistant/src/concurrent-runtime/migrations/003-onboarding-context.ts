export const CONCURRENT_RUNTIME_MIGRATION_003 = `
ALTER TABLE concurrent_conversations
  ADD COLUMN IF NOT EXISTS onboarding_context JSONB;

INSERT INTO concurrent_runtime_schema_migrations (version, name)
VALUES (3, 'onboarding_context')
ON CONFLICT (version) DO NOTHING;
`;
