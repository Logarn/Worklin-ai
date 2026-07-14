import { useState } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { DetailCard } from "@/components/detail-card";
import { client } from "@/generated/api/client.gen";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useAuthStore } from "@/stores/auth-store";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

type SetupStatus =
  | { kind: "idle" }
  | { kind: "saving"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

async function requireOk(
  operation: Promise<{ response?: Response }>,
  message: string,
): Promise<void> {
  const { response } = await operation;
  if (!response?.ok) throw new Error(message);
}

export function LiveVoicePilotPanel() {
  const assistantId = useActiveAssistantId();
  const userId = useAuthStore.use.user()?.id ?? "";
  const voiceModeEnabled = useAssistantFeatureFlagStore.use.voiceMode();
  const navigate = useNavigate();
  const [apiKey, setApiKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [configId, setConfigId] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [status, setStatus] = useState<SetupStatus>({ kind: "idle" });

  const canSubmit =
    apiKey.trim().length > 0 &&
    secretKey.trim().length > 0 &&
    configId.trim().length > 0 &&
    userId.length > 0 &&
    status.kind !== "saving";

  const configurePilot = async () => {
    if (!canSubmit) return;
    setStatus({ kind: "saving", message: "Saving Hume credentials…" });

    try {
      await requireOk(
        client.post({
          url: `/v1/assistants/${assistantId}/credentials/set`,
          body: {
            service: "hume",
            field: "api_key",
            value: apiKey.trim(),
            label: "Hume API key",
            description: "Private Worklin live-voice pilot",
          },
          throwOnError: false,
        } as Parameters<typeof client.post>[0]) as Promise<{
          response?: Response;
        }>,
        "The Hume API key could not be stored.",
      );

      await requireOk(
        client.post({
          url: `/v1/assistants/${assistantId}/credentials/set`,
          body: {
            service: "hume",
            field: "secret_key",
            value: secretKey.trim(),
            label: "Hume secret key",
            description: "Private Worklin live-voice pilot",
          },
          throwOnError: false,
        } as Parameters<typeof client.post>[0]) as Promise<{
          response?: Response;
        }>,
        "The Hume secret key could not be stored.",
      );

      setStatus({ kind: "saving", message: "Configuring live voice…" });
      await requireOk(
        client.patch({
          url: `/v1/assistants/${assistantId}/config`,
          body: {
            services: {
              voice: {
                engine: "hume",
                pilotAllowlist: [userId],
                providers: {
                  hume: {
                    configId: configId.trim(),
                    voiceId: voiceId.trim(),
                  },
                },
              },
            },
          },
          throwOnError: false,
        } as Parameters<typeof client.patch>[0]) as Promise<{
          response?: Response;
        }>,
        "The Worklin voice configuration could not be saved.",
      );

      if (!voiceModeEnabled) {
        await requireOk(
          client.patch({
            url: `/v1/assistants/${assistantId}/feature-flags/voice-mode`,
            body: { enabled: true },
            throwOnError: false,
          } as Parameters<typeof client.patch>[0]) as Promise<{
            response?: Response;
          }>,
          "Voice mode could not be enabled for this assistant.",
        );
      }

      setApiKey("");
      setSecretKey("");
      setStatus({
        kind: "success",
        message:
          "Hume is configured for this assistant. Reload Worklin to start the live test.",
      });
    } catch (error) {
      setStatus({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The live-voice pilot could not be configured.",
      });
    }
  };

  return (
    <DetailCard
      title="Live Voice Pilot"
      subtitle="Internal Hume setup. Credentials are written directly to Worklin's secure credential service and are never returned to the browser."
    >
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <PilotField
            label="Hume API key"
            type="password"
            value={apiKey}
            onChange={setApiKey}
          />
          <PilotField
            label="Hume secret key"
            type="password"
            value={secretKey}
            onChange={setSecretKey}
          />
          <PilotField
            label="EVI config ID"
            value={configId}
            onChange={setConfigId}
          />
          <PilotField
            label="Voice ID (optional)"
            value={voiceId}
            onChange={setVoiceId}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!canSubmit} onClick={() => void configurePilot()}>
            {status.kind === "saving" ? "Configuring…" : "Configure Hume"}
          </Button>
          {status.kind === "success" && (
            <Button
              variant="outlined"
              onClick={() => void navigate(routes.assistant)}
            >
              Open in Worklin
            </Button>
          )}
          {status.kind !== "idle" && (
            <p
              role="status"
              className={
                status.kind === "error"
                  ? "text-body-medium-default text-[var(--system-danger-strong)]"
                  : "text-body-medium-default text-[var(--content-secondary)]"
              }
            >
              {status.message}
            </p>
          )}
        </div>
      </div>
    </DetailCard>
  );
}

function PilotField({
  label,
  onChange,
  type = "text",
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  type?: "password" | "text";
  value: string;
}) {
  return (
    <label className="space-y-1.5 text-body-medium-default text-[var(--content-secondary)]">
      <span>{label}</span>
      <input
        autoComplete="off"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-[var(--border-base)] bg-[var(--surface-default)] px-3 py-2 text-[var(--content-default)] focus:border-[var(--border-focus)] focus:outline-none"
      />
    </label>
  );
}
