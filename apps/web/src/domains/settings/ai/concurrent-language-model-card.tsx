import { ByoServiceCard } from "@/domains/settings/ai/shared-ui";

export function ConcurrentLanguageModelCard() {
  return (
    <ByoServiceCard
      id="managed-concurrent-model"
      title="Your assistant's model"
      subtitle="Managed by Worklin for fast, always-ready conversations."
    >
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-4">
        <p className="text-body-medium-default font-medium text-[var(--content-emphasised)]">
          Worklin managed model
        </p>
        <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
          Model selection and credentials are managed by Worklin on this
          assistant. Personal API keys and custom model endpoints require a
          dedicated assistant.
        </p>
      </div>
    </ByoServiceCard>
  );
}
