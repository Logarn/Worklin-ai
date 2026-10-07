const PROVIDER_NOT_CONFIGURED_CODE = "PROVIDER_NOT_CONFIGURED";
const REDACTION_BLOCKED_CODE = "secret_blocked";

function isProviderMissingMessage(message?: string | null): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return (
    normalized.includes("needs an ai provider") ||
    normalized.includes("choose a provider in settings") ||
    normalized.includes("connect chatgpt or add an api key")
  );
}

function isSubscriptionModelUnavailableMessage(
  message?: string | null,
): boolean {
  return (
    message
      ?.toLowerCase()
      .includes("isn't available through your chatgpt subscription") ?? false
  );
}

export function shouldAttemptProviderProfileRepair(error: {
  code?: string | null;
  errorCategory?: string | null;
  message?: string | null;
  detail?: string | null;
  status?: number | null;
}): boolean {
  const isProviderMissing =
    isProviderMissingMessage(error.message) ||
    isProviderMissingMessage(error.detail);
  const isSubscriptionModelUnavailable =
    isSubscriptionModelUnavailableMessage(error.message) ||
    isSubscriptionModelUnavailableMessage(error.detail);

  return (
    error.code === PROVIDER_NOT_CONFIGURED_CODE ||
    (error.code === REDACTION_BLOCKED_CODE && isProviderMissing) ||
    isProviderMissing ||
    isSubscriptionModelUnavailable
  );
}
