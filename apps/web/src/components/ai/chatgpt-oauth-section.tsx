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
// 6-state machine:
//   idle → starting → paste_url → exchanging → completed | failed
//
// On successful exchange the component calls `onConnected` with the
// resulting connection so the parent can persist it.

type ChatgptOAuthState =
  | "idle"
  | "starting"
  | "paste_url"
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
  callback_listening: boolean;
  code_verifier?: string;
}

interface ChatgptExchangeBody {
  code: string;
  state: string;
  code_verifier?: string;
}

function formatChatgptAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("expired") || lower.includes("invalid or expired state")) {
    return "This ChatGPT sign-in link expired before Worklin could finish it. Create a new ChatGPT sign-in link and try again.";
  }
  if (lower.includes("missing required security")) {
    return "This ChatGPT sign-in link is missing required security details. Create a new ChatGPT sign-in link and try again.";
  }
  if (
    lower.includes("token exchange") ||
    lower.includes("invalid_grant") ||
    lower.includes("authorization code")
  ) {
    return "ChatGPT did not accept that sign-in response. Create a fresh ChatGPT sign-in link and try again.";
  }
  if (lower.includes("store access token") || lower.includes("store refresh token")) {
    return "Worklin signed in to ChatGPT, but could not save the connection. Try again, or choose an API-key provider from the previous screen for now.";
  }
  return "We could not complete ChatGPT sign-in. Create a new sign-in link and try again.";
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
  const [authCodeVerifier, setAuthCodeVerifier] = useState<string | null>(null);
  const [callbackListening, setCallbackListening] = useState(false);
  const [copiedSignInLink, setCopiedSignInLink] = useState(false);

  const notifyConnectedConnection = useCallback(async () => {
    const { data } = await inferenceProviderconnectionsGet({
      path: { assistant_id: assistantId },
      query: { provider: "openai" },
      throwOnError: true,
    });
    const conns = data.connections;
    const chatgptConn = conns.find(
      (c) =>
        c.name === "chatgpt-subscription" || c.name === "openai-chatgpt",
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
    if (
      oauthState !== "paste_url" ||
      !authState ||
      !callbackListening
    ) {
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
            data.error ??
              "ChatGPT sign-in did not complete. Please try again.",
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
  }, [
    assistantId,
    authState,
    callbackListening,
    notifyConnectedConnection,
    oauthState,
  ]);

  async function handleSignIn() {
    setOauthState("starting");
    setOauthError(null);
    setAuthorizeUrl(null);
    setAuthState(null);
    setAuthCodeVerifier(null);
    setCallbackListening(false);
    setCopiedSignInLink(false);
    try {
      const { data } = await inferenceChatgptsubscriptionAuthPost({
        path: { assistant_id: assistantId },
        throwOnError: true,
      });
      const {
        authorize_url,
        state,
        callback_listening,
        code_verifier,
      } = data as ChatgptStartAuthResponse;
      setAuthorizeUrl(authorize_url);
      setAuthState(state);
      setAuthCodeVerifier(code_verifier ?? null);
      setCallbackListening(callback_listening);
      setOauthState("paste_url");
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
    setAuthCodeVerifier(null);
    setCallbackListening(false);
    setCopiedSignInLink(false);
  }

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border-base)] p-4">
      <Typography
        variant="body-small-default"
        as="p"
        className="text-[var(--content-tertiary)]"
      >
        Use a ChatGPT subscription instead of an API key. You will sign in in
        your browser, then return here to finish.
      </Typography>

      {oauthState === "idle" || oauthState === "paste_url" ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <Typography
              variant="body-small-default"
              as="p"
              className={
                oauthState === "paste_url"
                  ? "text-[var(--content-tertiary)] line-through"
                  : "text-[var(--content-secondary)]"
              }
            >
              1. Create a secure ChatGPT sign-in link
            </Typography>
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-secondary)]"
            >
              2. Open the link and sign in to ChatGPT.
            </Typography>
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-secondary)]"
            >
              3. Return here. If the browser lands on a page that does not
              load, paste that page URL below.
            </Typography>
          </div>

          {oauthState === "idle" ? (
            <Button
              variant="outlined"
              size="compact"
              onClick={() => void handleSignIn()}
            >
              Create ChatGPT Sign-in Link
            </Button>
          ) : (
            <>
              {authorizeUrl ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outlined" size="compact" asChild>
                    <a
                      href={authorizeUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
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
                  ? "After sign-in, return to this screen. If the browser shows a page that does not load, paste that page URL below."
                  : "After sign-in, paste the page URL below to finish."}
              </Typography>
              <Input
                value={pastedUrl}
                onChange={(e) => {
                  setPastedUrl(e.target.value);
                  setOauthError(null);
                }}
                placeholder="Paste callback URL here..."
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
