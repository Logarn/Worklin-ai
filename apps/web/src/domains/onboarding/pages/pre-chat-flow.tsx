import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

import { saveAssistantCharacterProfile } from "@/assistant/avatar-api";
import { useIsIOSWeb } from "@/runtime/platform-detection";
import { readIOSAppDownloaded } from "@/hooks/use-ios-app-nudge";
import { fetchOnboardingRecipe } from "@/domains/onboarding/recipe-client.js";
import { enqueueBrandResearchRun } from "@/lib/brand-research";
import {
  emitOnboardingFunnelStepCompleted,
  onboardingFunnelVariantFromExperiment,
  ONBOARDING_FUNNEL_STEPS,
  ONBOARDING_FUNNEL_VARIANTS,
  readOnboardingFunnelVariant,
  resolveOnboardingFunnelVariant,
} from "@/domains/onboarding/funnel-events";
import { GetIOSAppScreen } from "@/domains/onboarding/screens/get-ios-app-screen.js";
import { BrandProfileScreen } from "@/domains/onboarding/screens/brand-profile-screen.js";
import { GoogleConnectScreen } from "@/domains/onboarding/screens/google-connect-screen.js";
import { NameExchangeScreen } from "@/domains/onboarding/screens/name-exchange-screen.js";
import { NameStepScreen } from "@/domains/onboarding/screens/name-step-screen.js";
import { PriorAssistantSelectionScreen } from "@/domains/onboarding/screens/prior-assistant-selection-screen.js";
import { TaskToneSelectionScreen } from "@/domains/onboarding/screens/task-tone-selection-screen.js";
import { ToolSelectionScreen } from "@/domains/onboarding/screens/tool-selection-screen.js";
import { VibeStepScreen } from "@/domains/onboarding/screens/vibe-step-screen.js";
import { useAssistantQuery } from "@/assistant/queries";
import {
  WORKLIN_AVATAR_CHOICES,
  profileFromCharacter,
  type AssistantCharacter,
} from "@/components/avatar/assistant-character-packs";
import { usePrefilledInput } from "@/hooks/use-prefilled-input.js";
import {
  setPendingAssistantName,
  setPendingPreChatContext,
} from "@/domains/onboarding/prechat";
import { buildPreChatContext } from "@/domains/onboarding/prechat-context";
import {
  isPlatformFunnelAvailable,
  nextStep,
  prevStep,
  resolveNativeSteps,
  resolveWebSteps,
  type PreChatStep,
} from "@/domains/onboarding/prechat-steps";
import { DEFAULT_GROUP_ID } from "@/domains/onboarding/prechat-names";
import { GOOGLE_TOOL_IDS } from "@/domains/onboarding/prechat-tools";
import { usePreChatStepState } from "@/domains/onboarding/use-prechat-step-state";
import { completeAccountOnboarding } from "@/domains/onboarding/complete-account-onboarding";
import {
  getPlatformAssistants,
  getSelectedAssistant,
  isLocalMode,
} from "@/lib/local-mode";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useIsNativePlatform } from "@/runtime/native-auth.js";
import {
  useAuthStore,
  useIsAuthenticated,
  useIsSessionInitializing,
} from "@/stores/auth-store.js";
import { hasLivePlatformSession } from "@/stores/session-status";
import { lifecycleService } from "@/assistant/lifecycle-service";
import { captureError } from "@/lib/sentry/capture-error";
import { avatarQueryKey } from "@/lib/sync/query-tags";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes.js";

const IOS_TOTAL_STEPS = 3;

function readLocalPlatformAssistantId(): string | null {
  const selected = getSelectedAssistant();
  if (selected?.cloud === "vellum") {
    return selected.assistantId;
  }
  return getPlatformAssistants()[0]?.assistantId ?? null;
}

export function PreChatFlow() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get("preview") === "true";
  const user = useAuthStore.use.user();
  const isAuthenticated = useIsAuthenticated();
  const isAuthInitializing = useIsSessionInitializing();
  const userId = user?.id ?? null;
  const firstName = user?.firstName ?? "";
  const lastName = user?.lastName ?? "";
  const isNative = useIsNativePlatform();
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const selectedAssistantId =
    useResolvedAssistantsStore.use.selectedAssistantId();
  const localMode = isLocalMode();
  const isIOSWeb = useIsIOSWeb();
  const showIOSAppStep = isIOSWeb && !readIOSAppDownloaded();
  const preChatExperimentArm =
    useClientFeatureFlagStore.use.stringFlags()
      .preChatOnboardingExperiment20260606 ?? "control";
  const activationFlowArm =
    useClientFeatureFlagStore.use.stringFlags()
      .experimentActivationFlow20260603 ?? "control";
  const activationFlowEnabled = activationFlowArm === "variant-a";
  const selfIntroGreetingEnabled =
    useClientFeatureFlagStore.use.selfIntroGreeting();
  const preferredFunnelVariant =
    onboardingFunnelVariantFromExperiment(preChatExperimentArm);
  const webFunnelVariant =
    readOnboardingFunnelVariant() ?? preferredFunnelVariant;
  const paredDownPrechat =
    webFunnelVariant === ONBOARDING_FUNNEL_VARIANTS.paredDown;
  const localPlatformAssistantId = localMode
    ? readLocalPlatformAssistantId()
    : null;

  const { currentStep, setCurrentStep, clearPersistedStep } =
    usePreChatStepState(userId, isNative);

  const platformSession = useAuthStore.use.platformSession();
  const hasPlatformSession = hasLivePlatformSession(platformSession);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedPriorAssistants, setSelectedPriorAssistants] = useState<
    Set<string>
  >(() => new Set());
  const [brandName, setBrandName] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const { value: userName, onChange: handleUserNameChange } = usePrefilledInput(
    localMode && !hasPlatformSession ? "" : firstName || lastName,
  );
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedAvatarId, setSelectedAvatarId] = useState<string>(
    () => WORKLIN_AVATAR_CHOICES[0]?.id ?? "",
  );
  const [assistantName, setAssistantName] = useState<string>(
    () => WORKLIN_AVATAR_CHOICES[0]?.shortName ?? "",
  );
  const [googleConnected, setGoogleConnected] = useState(false);
  const [googleScopes, setGoogleScopes] = useState<string[]>([]);

  const { data: activeAssistantResult } = useAssistantQuery({
    enabled:
      !isAuthInitializing &&
      isAuthenticated &&
      (!localMode || hasPlatformSession),
    selectedPlatformAssistantId: localMode ? null : selectedAssistantId,
  });
  const activeAssistant = activeAssistantResult?.ok
    ? activeAssistantResult.data
    : null;
  const { data: fetchedRecipe, isLoading: recipeLoading } = useQuery({
    queryKey: ["onboarding-recipe", userId],
    queryFn: fetchOnboardingRecipe,
    enabled: !isAuthInitializing && isAuthenticated && !isNative && !localMode,
    staleTime: Infinity,
  });
  const recipe = fetchedRecipe ?? null;
  const googleAssistantId =
    activeAssistant?.id ??
    selectedAssistantId ??
    activeAssistantId ??
    localPlatformAssistantId;
  const selectedAvatar =
    WORKLIN_AVATAR_CHOICES.find((avatar) => avatar.id === selectedAvatarId) ??
    WORKLIN_AVATAR_CHOICES[0] ??
    null;
  const platformFunnelAvailable = isPlatformFunnelAvailable({
    localMode,
    platformSession,
    hasCachedPlatformAssistant: localPlatformAssistantId !== null,
  });
  // The Google-connect step needs a concrete assistant id to bind the OAuth
  // connection. If the assistant has not been resolved yet, skip the step
  // instead of rendering a dead-end null screen.
  const canOfferGoogleStep =
    platformFunnelAvailable &&
    googleAssistantId !== undefined &&
    googleAssistantId !== null;
  const canOfferPriorAssistants = platformFunnelAvailable;

  const handleAssistantAvatarChange = (avatar: AssistantCharacter): void => {
    setSelectedAvatarId(avatar.id);
    setAssistantName(avatar.shortName);
  };

  async function persistSelectedAvatarProfile(
    assistantIdOverride?: string,
  ): Promise<void> {
    const assistantId = assistantIdOverride ?? googleAssistantId;
    if (!assistantId || !selectedAvatar) return;
    const nextProfile = {
      ...profileFromCharacter(selectedAvatar),
      assistantName: assistantName.trim() || selectedAvatar.shortName,
    };
    const saved = await saveAssistantCharacterProfile(
      assistantId,
      nextProfile,
    );
    if (!saved) return;
    void queryClient.invalidateQueries({
      queryKey: avatarQueryKey(assistantId),
    });
  }

  const navigateToChatAfterLifecycleRefresh = async () => {
    let handoffAssistantId =
      activeAssistant?.id ??
      selectedAssistantId ??
      activeAssistantId ??
      localPlatformAssistantId;

    if (!localMode) {
      const completedAssistant = await completeAccountOnboarding();
      handoffAssistantId = completedAssistant.id;
    }

    await persistSelectedAvatarProfile(handoffAssistantId ?? undefined);

    if (localMode && !handoffAssistantId) {
      void navigate(routes.onboarding.hatching, { replace: true });
      return;
    }

    if (
      !isNative &&
      !localMode &&
      handoffAssistantId &&
      (brandName.trim() || websiteUrl.trim())
    ) {
      // Queueing is durable and deliberately best-effort here: onboarding
      // should never wait on research or strand the user at the handoff.
      void enqueueBrandResearchRun({
        assistantId: handoffAssistantId,
        brandName,
        websiteUrl,
      }).catch((err) => {
        captureError(err, { context: "onboarding_queue_brand_research" });
      });
    }

    await lifecycleService.checkAssistant(handoffAssistantId ?? undefined);
    void navigate(`${routes.assistant}?onboarding=1`, { replace: true });
  };

  function emitWebFunnelStep(
    step: (typeof ONBOARDING_FUNNEL_STEPS)[keyof typeof ONBOARDING_FUNNEL_STEPS],
    variant = webFunnelVariant,
  ): void {
    if (isPreview) {
      return;
    }
    emitOnboardingFunnelStepCompleted(step, {
      userId,
      variant: resolveOnboardingFunnelVariant(variant),
    });
  }

  const hasGoogleTool = [...selectedTools].some((id) =>
    GOOGLE_TOOL_IDS.has(id),
  );

  const steps: PreChatStep[] = isNative
    ? resolveNativeSteps()
    : resolveWebSteps({
        paredDown: paredDownPrechat,
        canOfferPriorAssistants,
        canOfferGoogleStep: isPreview ? false : canOfferGoogleStep,
        hasGoogleTool,
        showIOSAppStep,
      });

  async function completeFlow(args?: {
    connectedScopes?: string[];
    selectedPriorAssistants?: Set<string>;
  }): Promise<void> {
    if (isPreview) {
      navigate(-1);
      return;
    }

    const context = buildPreChatContext({
      mode: isNative ? "native" : paredDownPrechat ? "paredDown" : "control",
      recipe: isNative ? null : recipe,
      selectedTools,
      selectedTasks,
      selectedPriorAssistants:
        args?.selectedPriorAssistants ?? selectedPriorAssistants,
      tone: selectedGroupId ?? recipe?.tone ?? DEFAULT_GROUP_ID,
      userName,
      brandName,
      websiteUrl,
      assistantName,
      selfIntroGreetingEnabled,
      activationFlowEnabled: isNative ? undefined : activationFlowEnabled,
      googleConnected,
      googleScopes,
      connectedScopes: args?.connectedScopes,
    });

    setPendingPreChatContext(context);
    const trimmedAssistant = assistantName.trim();
    if (trimmedAssistant) setPendingAssistantName(trimmedAssistant);

    try {
      lifecycleService.markExpectingFirstMessage();
      await navigateToChatAfterLifecycleRefresh();
      clearPersistedStep();
    } catch (err) {
      captureError(err, { context: "prechat_complete_onboarding" });
      toast.error("Setup could not be completed. Please try again.");
    }
  }

  const advance = (
    from: PreChatStep,
    finishArgs?: {
      connectedScopes?: string[];
      selectedPriorAssistants?: Set<string>;
    },
  ): void => {
    if (from.funnelStep) emitWebFunnelStep(from.funnelStep);
    const next = nextStep(steps, from.id);
    if (next) {
      setCurrentStep(next);
    } else {
      void completeFlow(finishArgs);
    }
  };

  const goBack = (from: PreChatStep): void => {
    const previous = prevStep(steps, from.id);
    if (previous) setCurrentStep(previous);
  };

  if (recipeLoading) {
    return null;
  }

  const activeStep = steps.find((step) => step.id === currentStep) ?? steps[0];
  if (!activeStep) {
    return null;
  }

  if (activeStep.id === "nativeName") {
    return (
      <NameStepScreen
        userName={userName}
        assistantName={assistantName}
        selectedAvatarId={selectedAvatarId}
        onUserNameChange={handleUserNameChange}
        onAssistantNameChange={setAssistantName}
        onAssistantAvatarChange={handleAssistantAvatarChange}
        onContinue={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
        currentStep={0}
        totalSteps={IOS_TOTAL_STEPS}
      />
    );
  }

  if (activeStep.id === "nativeVibe") {
    return (
      <VibeStepScreen
        selectedGroupId={selectedGroupId}
        onGroupChange={setSelectedGroupId}
        onBack={() => goBack(activeStep)}
        onContinue={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
        currentStep={1}
        totalSteps={IOS_TOTAL_STEPS}
      />
    );
  }

  if (activeStep.id === "name") {
    return (
      <NameExchangeScreen
        userName={userName}
        assistantName={assistantName}
        selectedAvatarId={selectedAvatarId}
        selectedGroupId={selectedGroupId}
        onUserNameChange={handleUserNameChange}
        onAssistantNameChange={setAssistantName}
        onAssistantAvatarChange={handleAssistantAvatarChange}
        onGroupChange={setSelectedGroupId}
        onComplete={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
      />
    );
  }

  if (activeStep.id === "taskTone") {
    return (
      <TaskToneSelectionScreen
        selectedTasks={selectedTasks}
        onChange={setSelectedTasks}
        onBack={() => goBack(activeStep)}
        onContinue={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
      />
    );
  }

  if (activeStep.id === "brand") {
    return (
      <BrandProfileScreen
        brandName={brandName}
        websiteUrl={websiteUrl}
        onBrandNameChange={setBrandName}
        onWebsiteUrlChange={setWebsiteUrl}
        onBack={() => goBack(activeStep)}
        onContinue={() => advance(activeStep)}
        onSkip={() => {
          setBrandName("");
          setWebsiteUrl("");
          advance(activeStep);
        }}
      />
    );
  }

  if (activeStep.id === "tools") {
    return (
      <ToolSelectionScreen
        selectedTools={selectedTools}
        onChange={setSelectedTools}
        onBack={() => goBack(activeStep)}
        onContinue={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
      />
    );
  }

  if (activeStep.id === "priorAssistants") {
    return (
      <PriorAssistantSelectionScreen
        selectedAssistants={selectedPriorAssistants}
        onChange={setSelectedPriorAssistants}
        onBack={() => goBack(activeStep)}
        onContinue={() => advance(activeStep)}
        onSkip={() => {
          const emptyPriorAssistants = new Set<string>();
          setSelectedPriorAssistants(emptyPriorAssistants);
          advance(activeStep, {
            selectedPriorAssistants: emptyPriorAssistants,
          });
        }}
      />
    );
  }

  if (activeStep.id === "google") {
    if (!googleAssistantId) {
      return null;
    }
    return (
      <GoogleConnectScreen
        assistantId={googleAssistantId}
        assistantName={assistantName}
        onConnect={(scopes) => {
          setGoogleConnected(true);
          setGoogleScopes(scopes);
          advance(activeStep, { connectedScopes: scopes });
        }}
        onSkip={() => advance(activeStep)}
        onBack={() => goBack(activeStep)}
      />
    );
  }

  if (activeStep.id === "iosApp") {
    return <GetIOSAppScreen onComplete={() => advance(activeStep)} />;
  }

  return null;
}
