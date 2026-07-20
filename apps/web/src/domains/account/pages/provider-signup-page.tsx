import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import {
  AccountForm,
  AccountHeading,
  AccountInput,
} from "@/components/account/account-form";
import { AccountShell } from "@/components/account/account-shell";
import { PersonalPageShell } from "@/domains/account/components/personal-page-shell";
import {
  resolvePostAuthDestination,
  resolvePostLoginDestination,
} from "@/domains/account/login-flow";
import {
  getProviderSignup,
  isConflict,
  submitProviderSignup,
} from "@/lib/auth/allauth-client";
import { useAuthStore } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { routes } from "@/utils/routes";

/**
 * Provider signup completion page. Shown when allauth's provider flow needs
 * additional information before creating the account.
 *
 * Default (control / variant-a): collect email + username.
 *
 * When `experiment-activation-flow-2026-06-03` serves `personal-page`, complete
 * the account automatically from the provider-supplied email and username. The
 * onboarding flow collects the user's identity and role once, then persists
 * those answers in the assistant handoff.
 */
export function ProviderSignupPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const refreshSession = useAuthStore.use.refreshSession();
  const returnTo = searchParams.get("returnTo");

  const activationArm =
    useClientFeatureFlagStore.use.stringFlags().experimentActivationFlow20260603 ??
    "control";
  const personalPage = activationArm === "personal-page";

  // Provider-supplied identity used to complete the account.
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingContext, setIsLoadingContext] = useState(true);
  const didLoad = useRef(false);
  const didAutoComplete = useRef(false);

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;

    (async () => {
      try {
        const result = await getProviderSignup();
        if (!result.ok) {
          navigate(routes.account.login, { replace: true });
          return;
        }

        setEmail(result.data.user.email ?? "");
        setUsername(result.data.user.username ?? "");
        setIsLoadingContext(false);
      } catch {
        navigate(routes.account.login, { replace: true });
      }
    })();
  }, [navigate]);

  const completeSignup = useCallback(async () => {
    const result = await submitProviderSignup({ email, username });

    if (!result.ok) {
      if (isConflict(result)) {
        await refreshSession();
        const conflict = resolvePostLoginDestination(returnTo, routes.account.root);
        if (conflict.requiresFullPageNavigation) {
          window.location.href = conflict.destination;
        } else {
          navigate(conflict.destination);
        }
        return;
      }

      setError(result.errors[0]?.message ?? "Failed to complete signup.");
      return;
    }

    await refreshSession();
    const post = resolvePostAuthDestination({
      returnTo,
      fallback: routes.account.root,
      authIntent: "signup",
    });
    if (post.requiresFullPageNavigation) {
      window.location.href = post.destination;
    } else {
      navigate(post.destination);
    }
  }, [email, navigate, refreshSession, returnTo, username]);

  const submitSignup = useCallback(async () => {
    setError(null);
    setIsSubmitting(true);
    try {
      await completeSignup();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }, [completeSignup]);

  useEffect(() => {
    if (
      !personalPage ||
      isLoadingContext ||
      !email ||
      !username ||
      didAutoComplete.current
    ) {
      return;
    }
    didAutoComplete.current = true;
    void submitSignup();
  }, [email, isLoadingContext, personalPage, submitSignup, username]);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void submitSignup();
  };

  if (isLoadingContext) {
    return (
      <AccountShell>
        <AccountHeading
          title="Completing signup..."
          subtitle="Please wait while we load your information."
        />
      </AccountShell>
    );
  }

  // If the provider omitted a required value, fall through to the editable
  // control form so the user can complete signup.
  if (personalPage && email && username) {
    if (!error) {
      return (
        <AccountShell>
          <AccountHeading
            title="Finishing signup..."
            subtitle="We're getting your assistant ready."
          />
        </AccountShell>
      );
    }

    return (
      <PersonalPageShell>
        <div className="cast-about__thread">
          <h2 className="cast-about__heading">
            We couldn't finish
            <br /> your signup
          </h2>

          <p className="cast-about__error" role="alert">
            {error}
          </p>

          <div className="cast-about__step">
            <button
              type="button"
              className="cast-about__continue"
              disabled={isSubmitting}
              onClick={() => void submitSignup()}
            >
              {isSubmitting ? "Trying again…" : "Try again"}
            </button>
          </div>
        </div>
      </PersonalPageShell>
    );
  }

  return (
    <AccountShell>
      <AccountHeading
        title="Complete your account"
        subtitle="We need a few more details to finish setting up your account."
      />

      <AccountForm
        onSubmit={onSubmit}
        error={error}
        submitLabel="Complete signup"
        submittingLabel="Completing..."
        isSubmitting={isSubmitting}
        footer={
          <Link
            to={routes.account.login}
            className="text-sm text-[var(--content-secondary)] hover:text-[var(--content-default)]"
          >
            &larr; Back to sign in
          </Link>
        }
      >
        <AccountInput
          id="email"
          type="email"
          autoComplete="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <AccountInput
          id="username"
          type="text"
          autoComplete="username"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </AccountForm>
    </AccountShell>
  );
}
