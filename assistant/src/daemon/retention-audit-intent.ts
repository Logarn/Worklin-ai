const RETENTION_AUDIT_ACTION_RE =
  /\b(audit|analy[sz]e|review|inspect|diagnos(?:e|is)|deep\s+audit|full\s+audit|retention\s+audit)\b/i;
const RETENTION_AUDIT_DOMAIN_RE =
  /\b(klaviyo|shopify|retention|lifecycle|campaigns?|flows?|segments?|profiles?|email\s+marketing|sms|dtc|e-?commerce|customers?|winback|replenishment|repeat\s+purchase|ltv)\b/i;
const RETENTION_ONBOARDING_RE =
  /\b(onboard(?:ing)?|set\s*up|setup|new\s+brand|brand\s+joins?|getting\s+started|learn\s+(?:the\s+)?brand|brand\s+brain)\b/i;
const RETENTION_KLAVIYO_CONNECTION_RE =
  /\b(klaviyo)\b(?=[\s\S]*\b(connect|reconnect|connection|api\s*key|key|credential|read[-\s]?only|readonly|different|new|add|enter|paste)\b)|\b(connect|reconnect|add|enter|paste|different|new)\b(?=[\s\S]*\b(klaviyo)\b)/i;
const INTERNAL_RETENTION_AUDIT_MESSAGE_RE =
  /^(?:\[Subagent\b|You are the .+ Agent for a Worklin deep retention audit\b|You are running memory consolidation\b|You are running .*memory\b|You are analyzing .*conversation\b)/i;
const RETENTION_AUDIT_SUBAGENT_NOTIFICATION_RE =
  /^\[Subagent\s+"audit-[^"]+"\s+[^\]]+\]/i;

export function isDirectRetentionAuditIntent(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;
  if (INTERNAL_RETENTION_AUDIT_MESSAGE_RE.test(normalized)) return false;
  if (RETENTION_ONBOARDING_RE.test(normalized)) return false;
  return (
    RETENTION_AUDIT_ACTION_RE.test(normalized) &&
    RETENTION_AUDIT_DOMAIN_RE.test(normalized)
  );
}

export function isRetentionOnboardingIntent(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;
  if (INTERNAL_RETENTION_AUDIT_MESSAGE_RE.test(normalized)) return false;
  if (RETENTION_AUDIT_SUBAGENT_NOTIFICATION_RE.test(normalized)) return false;
  if (!RETENTION_ONBOARDING_RE.test(normalized)) return false;
  return (
    /\b(brand|client|customer|account|site|domain|website|shopify|klaviyo|retention|dtc|e-?commerce)\b/i.test(
      normalized,
    ) || /https?:\/\//i.test(normalized)
  );
}

export function isRetentionKlaviyoConnectionIntent(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;
  if (INTERNAL_RETENTION_AUDIT_MESSAGE_RE.test(normalized)) return false;
  if (RETENTION_AUDIT_SUBAGENT_NOTIFICATION_RE.test(normalized)) return false;
  if (!RETENTION_KLAVIYO_CONNECTION_RE.test(normalized)) return false;
  if (
    RETENTION_AUDIT_ACTION_RE.test(normalized) &&
    !/\b(connect|reconnect|connection|api\s*key|key|credential|read[-\s]?only|readonly|different|new|add|enter|paste)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  return true;
}

export function isRetentionAuditSubagentNotification(content: string): boolean {
  return RETENTION_AUDIT_SUBAGENT_NOTIFICATION_RE.test(content.trim());
}
