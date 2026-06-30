import { useCallback, useEffect, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Typography } from "@vellumai/design-library/components/typography";
import { Loader2 } from "lucide-react";

import {
  inferenceChatgptsubscriptionAuthExchangePost,
  inferenceChatgptsubscriptionAuthPost,
  inferenceChatgptsubscriptionAuthStatusGet,
  inferenceProviderconnectionsGet,
} from "@/generated/daemon/sdk.gen";
import { extractErrorMessage } from "@/utils/api-errors";

import type { ProviderConnection } from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// ChatGPT Subscription OAuth Section
// ---------------------------------------------------------------------------
//
// Self-contained OAuth flow for connecting a ChatGPT subscription.
// Renders anywhere Worklin needs ChatGPT subscription setup. Manages a
// state machine:
//   idle -> starting -> waiting -> exchanging -> completed | failed
//
// On successful exchange the component calls `onConnected` with the
// resulting connection so the parent can persist it.

type ChatgptOAuthState =
  | "idle"
  | "starting"
  | "waiting"
  | "exchanging"
  | "completed"
  | "failed";

interface ChatgptOAuthSectionProps {
  assistantId: string;
  onConnected: (connection: ProviderConnection) => void;
}

interface ChatgptStartAuthResponse {
  authorize_url: string;
  state: string;
  mode?: "device_code" | "loopback";
  callback_listening: boolean;
  code_verifier?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string | null;
  expires_in?: number;
}

interface ChatgptExchangeBody {
  code: string;
  state: string;
  code_verifier?: string;
}

function formatChatgptAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("expired") || lower.includes("invalid or expired state")) {
    return "This ChatGPT sign-in expired before Worklin could finish it. Start a new ChatGPT sign-in and try again.";
  }
  if (lower.includes("missing required security")) {
    return "This ChatGPT sign-in is missing required security details. Start a new ChatGPT sign-in and try again.";
  }
  if (lower.includes("denied") || lower.includes("not approved")) {
    return "ChatGPT sign-in was not approved. Start again when you are ready to connect your subscription.";
  }
  if (
    lower.includes("token exchange") ||
    lower.includes("invalid_grant") ||
    lower.includes("authorization code")
  ) {
    return "ChatGPT did not accept that sign-in response. Start a fresh ChatGPT sign-in and try again.";
  }
  if (
    lower.includes("store access token") ||
    lower.includes("store refresh token") ||
    lower.includes("store chatgpt credentials")
  ) {
    return "Worklin signed in to ChatGPT, but could not save the connection. Try again, or choose an API-key provider from the previous screen for now.";
  }
  if (lower.includes("did not return an access token")) {
    return "ChatGPT finished sign-in but did not send Worklin the subscription access it needs. Start a new ChatGPT sign-in and try again.";
  }
  if (
    lower.includes("device code") ||
    lower.includes("device auth") ||
    lower.includes("failed to start chatgpt sign-in")
  ) {
    return "Worklin could not open the ChatGPT sign-in page. Try again in a moment, or choose an API-key provider from the previous screen for now.";
  }
  return "We could not complete ChatGPT sign-in. Start a new sign-in and try again.";
}

export function ChatgptOAuthSection({
  assistantId,
  onConnected,
}: ChatgptOAuthSectionProps) {
  const [oauthState, setOauthState] = useState<ChatgptOAuthState>("idle");
  const [pastedUrl, setPastedUrl] = useState("");
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [authState, setAuthState] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"device_code" | "loopback">(
    "device_code",
  );
  const [authCodeVerifier, setAuthCodeVerifier] = useState<string | null>(null);
  const [callbackListening, setCallbackListening] = useState(false);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [expiresInMinutes, setExpiresInMinutes] = useState<number | null>(null);
  const [copiedSignInLink, setCopiedSignInLink] = useState(false);
  const [copiedUserCode, setCopiedUserCode] = useState(false);

  const notifyConnectedConnection = useCallback(async () => {
    const { data } = await inferenceProviderconnectionsGet({
      path: { assistant_id: assistantId },
      query: { provider: "openai" },
      throwOnError: true,
    });
    const conns = data.connections;
    const chatgptConn = conns.find(
      (c) => c.name === "chatgpt-subscription" || c.name === "openai-chatgpt",
    );
    if (chatgptConn) {
      onConnected(chatgptConn);
    } else {
      onConnected({
        name: "chatgpt-subscription",
        provider: "openai",
        auth: {
          type: "oauth_subscription",
          credential: "credential/chatgpt/access_token",
        },
        label: "ChatGPT Subscription",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        baseUrl: null,
        models: null,
        isManaged: false,
      });
    }
  }, [assistantId, onConnected]);

  useEffect(() => {
    if (oauthState !== "waiting" || !authState) {
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const { data } = await inferenceChatgptsubscriptionAuthStatusGet({
          path: { assistant_id: assistantId },
          query: { state: authState },
          throwOnError: true,
        });

        if (cancelled) return;

        setCallbackListening(data.callback_listening);

        if (data.status === "completed") {
          setOauthState("completed");
          setOauthError(null);
          await notifyConnectedConnection();
          return;
        }

        if (data.status === "failed" || data.status === "expired") {
          setOauthState("failed");
          setOauthError(
            formatChatgptAuthError(
              data.error ??
                "ChatGPT sign-in did not complete. Please try again.",
            ),
          );
          return;
        }

        const delay = data.status === "exchanging" ? 750 : 1500;
        timeoutId = setTimeout(() => void poll(), delay);
      } catch {
        if (!cancelled) {
          timeoutId = setTimeout(() => void poll(), 2000);
        }
      }
    };

    timeoutId = setTimeout(() => void poll(), 1000);

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [assistantId, authState, notifyConnectedConnection, oauthState]);

  async function handleSignIn() {
    setOauthState("starting");
    setOauthError(null);
    setAuthorizeUrl(null);
    setAuthState(null);
    setAuthMode("device_code");
    setAuthCodeVerifier(null);
    setCallbackListening(false);
    setUserCode(null);
    setExpiresInMinutes(null);
    setCopiedSignInLink(false);
    setCopiedUserCode(false);
    try {
      const { data } = await inferenceChatgptsubscriptionAuthPost({
        path: { assistant_id: assistantId },
        throwOnError: true,
      });
      const {
        authorize_url,
        state,
        mode,
        callback_listening,
        code_verifier,
        user_code,
        verification_uri,
        verification_uri_complete,
        expires_in,
      } = data as ChatgptStartAuthResponse;
      const nextMode = mode ?? "device_code";
      const effectiveAuthorizeUrl =
        authorize_url || verification_uri_complete || verification_uri || null;
      setAuthorizeUrl(effectiveAuthorizeUrl);
      setAuthState(state);
      setAuthMode(nextMode);
      setAuthCodeVerifier(code_verifier ?? null);
      setCallbackListening(callback_listening);
      setUserCode(user_code ?? null);
      setExpiresInMinutes(
        expires_in ? Math.max(1, Math.ceil(expires_in / 60)) : null,
      );
      setOauthState("waiting");

      if (nextMode === "device_code" && effectiveAuthorizeUrl) {
        window.open(effectiveAuthorizeUrl, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      setOauthState("failed");
      const detail = extractErrorMessage(
        error,
        undefined,
        "Failed to start ChatGPT sign-in.",
      );
      setOauthError(formatChatgptAuthError(detail));
    }
  }

  async function handleCopyUserCode() {
    if (!userCode) return;
    setOauthError(null);
    try {
      await navigator.clipboard.writeText(userCode);
      setCopiedUserCode(true);
    } catch {
      setOauthError("Could not copy the code. You can type it manually.");
    }
  }

  async function handleCopySignInLink() {
    if (!authorizeUrl) return;
    setOauthError(null);
    try {
      await navigator.clipboard.writeText(authorizeUrl);
      setCopiedSignInLink(true);
    } catch {
      setOauthError(
        "Could not copy the sign-in link. Open it directly instead.",
      );
    }
  }

  async function handleUrlSubmit() {
    setOauthError(null);
    const trimmed = pastedUrl.trim();
    if (!trimmed) {
      setOauthError("Please paste the URL from the error page.");
      return;
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      setOauthError(
        "Invalid URL. Please paste the full URL from the address bar.",
      );
      return;
    }
    const code = parsedUrl.searchParams.get("code");
    const state = parsedUrl.searchParams.get("state");
    if (!code) {
      setOauthError(
        "The URL is missing the authorization code. Make sure you copied the full URL.",
      );
      return;
    }
    if (!state) {
      setOauthError(
        "The URL is missing the state parameter. Make sure you copied the full URL.",
      );
      return;
    }
    if (authState && state !== authState) {
      setOauthError(
        "This URL belongs to a different ChatGPT sign-in attempt. Create a fresh ChatGPT sign-in link and paste the new URL.",
      );
      return;
    }
    setOauthState("exchanging");
    try {
      const body: ChatgptExchangeBody = { code, state };
      if (authCodeVerifier) {
        body.code_verifier = authCodeVerifier;
      }
      await inferenceChatgptsubscriptionAuthExchangePost({
        path: { assistant_id: assistantId },
        body,
        throwOnError: true,
      });
      setOauthState("completed");
      await notifyConnectedConnection();
    } catch (error) {
      setOauthState("failed");
      const detail = extractErrorMessage(
        error,
        undefined,
        "Failed to complete ChatGPT sign-in.",
      );
      setOauthError(formatChatgptAuthError(detail));
    }
  }

  function handleReset() {
    setOauthState("idle");
    setPastedUrl("");
    setOauthError(null);
    setAuthorizeUrl(null);
    setAuthState(null);
    setAuthMode("device_code");
    setAuthCodeVerifier(null);
    setCallbackListening(false);
    setUserCode(null);
    setExpiresInMinutes(null);
    setCopiedSignInLink(false);
    setCopiedUserCode(false);
  }

  const isDeviceCodeFlow = authMode === "device_code";

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border-base)] p-4">
      <Typography
        variant="body-small-default"
        as="p"
        className="text-[var(--content-tertiary)]"
      >
        Use a ChatGPT subscription instead of an API key. Worklin will open a
        secure ChatGPT sign-in page and guide you through the shortest sign-in
        path available.
      </Typography>

      {oauthState === "idle" || oauthState === "waiting" ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-secondary)]"
            >
              {isDeviceCodeFlow
                ? "1. Open the ChatGPT sign-in page."
                : "1. Open the backup ChatGPT sign-in link."}
            </Typography>
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-secondary)]"
            >
              {isDeviceCodeFlow
                ? "2. Enter the code below and approve Worklin."
                : "2. Sign in and approve Worklin."}
            </Typography>
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-secondary)]"
            >
              {oauthState === "waiting" && !isDeviceCodeFlow
                ? "3. If Safari shows a page that cannot load, copy that page address and paste it below."
                : "3. Leave this screen open while Worklin finishes automatically."}
            </Typography>
          </div>

          {oauthState === "idle" ? (
            <Button
              variant="outlined"
              size="compact"
              onClick={() => void handleSignIn()}
            >
              Continue with ChatGPT
            </Button>
          ) : isDeviceCodeFlow ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
                <Typography
                  variant="body-small-default"
                  className="text-[var(--content-tertiary)]"
                >
                  Waiting for ChatGPT approval...
                </Typography>
              </div>

              {userCode ? (
                <div className="space-y-2 rounded-md border border-[var(--border-base)] p-3">
                  <Typography
                    variant="body-small-default"
                    as="p"
                    className="text-[var(--content-tertiary)]"
                  >
                    Enter this code in ChatGPT:
                  </Typography>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="rounded border border-[var(--border-base)] px-2 py-1 font-mono text-sm text-[var(--content-primary)]">
                      {userCode}
                    </code>
                    <Button
                      variant="ghost"
                      size="compact"
                      onClick={() => void handleCopyUserCode()}
                    >
                      {copiedUserCode ? "Copied" : "Copy Code"}
                    </Button>
                  </div>
                </div>
              ) : null}

              {authorizeUrl ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outlined" size="compact" asChild>
                    <a href={authorizeUrl} target="_blank" rel="noreferrer">
                      Open ChatGPT
                    </a>
                  </Button>
                  <Button
                    variant="ghost"
                    size="compact"
                    onClick={() => void handleCopySignInLink()}
                  >
                    {copiedSignInLink ? "Copied" : "Copy Sign-in Link"}
                  </Button>
                </div>
              ) : null}

              <Typography
                variant="body-small-default"
                as="p"
                className="text-[var(--content-tertiary)]"
              >
                No callback URL is needed. Leave this screen open after
                approving ChatGPT; Worklin checks for completion automatically
                {expiresInMinutes
                  ? ` for about ${expiresInMinutes} minutes`
                  : ""}
                .
              </Typography>
            </div>
          ) : (
            <>
              {authorizeUrl ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outlined" size="compact" asChild>
                    <a href={authorizeUrl} target="_blank" rel="noreferrer">
                      Open ChatGPT Sign-in
                    </a>
                  </Button>
                  <Button
                    variant="ghost"
                    size="compact"
                    onClick={() => void handleCopySignInLink()}
                  >
                    {copiedSignInLink ? "Copied" : "Copy Sign-in Link"}
                  </Button>
                </div>
              ) : null}
              <Typography
                variant="body-small-default"
                as="p"
                className="text-[var(--content-tertiary)]"
              >
                {callbackListening
                  ? "This backup method may need one extra step. After sign-in, return here; if the browser shows a page that does not load, paste that page URL below."
                  : "This backup method may need one extra step. If the browser lands on a page that does not load, paste that page URL below to finish."}
              </Typography>
              <Input
                value={pastedUrl}
                onChange={(e) => {
                  setPastedUrl(e.target.value);
                  setOauthError(null);
                }}
                placeholder="Paste backup callback URL here..."
                fullWidth
              />
              <div className="flex justify-end">
                <Button
                  variant="primary"
                  size="compact"
                  disabled={!pastedUrl.trim()}
                  onClick={() => void handleUrlSubmit()}
                >
                  Complete Sign In
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {oauthState === "starting" ? (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
          <Typography
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
          >
            Starting sign-in...
          </Typography>
        </div>
      ) : null}

      {oauthState === "exchanging" ? (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
          <Typography
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
          >
            Completing sign-in...
          </Typography>
        </div>
      ) : null}

      {oauthState === "completed" ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--system-positive-strong)]"
        >
          ChatGPT subscription connected successfully.
        </Typography>
      ) : null}

      {oauthError ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--system-negative-strong)]"
        >
          {oauthError}
        </Typography>
      ) : null}

      {oauthState === "failed" ? (
        <Button variant="outlined" size="compact" onClick={handleReset}>
          Try Again
        </Button>
      ) : null}
    </div>
  );
}
