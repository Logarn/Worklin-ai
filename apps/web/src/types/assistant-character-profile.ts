export const ASSISTANT_CHARACTER_PROFILE_PATH =
  "data/avatar/assistant-character-profile.json";

export const ASSISTANT_CHARACTER_PACK_IDS = [
  "rick_and_morty",
  "simpsons",
  "futurama",
] as const;

export type AssistantCharacterPackId =
  (typeof ASSISTANT_CHARACTER_PACK_IDS)[number];

export const ASSISTANT_PERSONALITY_PRESETS = [
  "witty",
  "chaotic",
  "analytical",
  "calm",
  "blunt",
  "strategic",
  "playful",
] as const;

export type AssistantPersonalityPreset =
  (typeof ASSISTANT_PERSONALITY_PRESETS)[number];

export const ASSISTANT_ROLE_PRESETS = [
  "strategist",
  "operator",
  "researcher",
  "creative partner",
  "growth lead",
] as const;

export type AssistantRolePreset = (typeof ASSISTANT_ROLE_PRESETS)[number];

export const ASSISTANT_AVATAR_STYLES = [
  "face_builder",
  "portrait_asset",
  "abstract",
] as const;

export type AssistantAvatarStyle = (typeof ASSISTANT_AVATAR_STYLES)[number];

export interface AssistantFaceBuilderConfig {
  skinTone: string;
  eyes: string;
  brows: string;
  eyewear: string;
  nose: string;
  mouth: string;
  hair: string;
  accessories: string;
  lineStyle: string;
  background: string;
}

export interface AssistantCharacterProfile {
  assistantName: string;
  characterPackId: AssistantCharacterPackId;
  characterId: string;
  avatarStyle?: AssistantAvatarStyle;
  faceBuilder?: AssistantFaceBuilderConfig;
  portraitAssetUrl?: string;
  portraitPrompt?: string;
  personalityPreset: AssistantPersonalityPreset | "custom";
  personalityText: string;
  role: AssistantRolePreset | string;
  tone: string;
  bio: string;
  animationEnabled: boolean;
  accentColor?: string;
  voicePlaceholder?: string;
  updatedAt: string;
}

function isPackId(value: unknown): value is AssistantCharacterPackId {
  return (
    typeof value === "string" &&
    ASSISTANT_CHARACTER_PACK_IDS.includes(
      value as AssistantCharacterPackId,
    )
  );
}

function isPersonalityPreset(
  value: unknown,
): value is AssistantCharacterProfile["personalityPreset"] {
  return (
    value === "custom" ||
    (typeof value === "string" &&
      ASSISTANT_PERSONALITY_PRESETS.includes(
        value as AssistantPersonalityPreset,
      ))
  );
}

function isAvatarStyle(value: unknown): value is AssistantAvatarStyle {
  return (
    typeof value === "string" &&
    ASSISTANT_AVATAR_STYLES.includes(value as AssistantAvatarStyle)
  );
}

export function isAssistantFaceBuilderConfig(
  value: unknown,
): value is AssistantFaceBuilderConfig {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.skinTone === "string" &&
    typeof obj.eyes === "string" &&
    typeof obj.brows === "string" &&
    typeof obj.eyewear === "string" &&
    typeof obj.nose === "string" &&
    typeof obj.mouth === "string" &&
    typeof obj.hair === "string" &&
    typeof obj.accessories === "string" &&
    typeof obj.lineStyle === "string" &&
    typeof obj.background === "string"
  );
}

export function isAssistantCharacterProfile(
  value: unknown,
): value is AssistantCharacterProfile {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.assistantName === "string" &&
    isPackId(obj.characterPackId) &&
    typeof obj.characterId === "string" &&
    (obj.avatarStyle === undefined || isAvatarStyle(obj.avatarStyle)) &&
    (obj.faceBuilder === undefined ||
      isAssistantFaceBuilderConfig(obj.faceBuilder)) &&
    (obj.portraitAssetUrl === undefined ||
      typeof obj.portraitAssetUrl === "string") &&
    (obj.portraitPrompt === undefined ||
      typeof obj.portraitPrompt === "string") &&
    isPersonalityPreset(obj.personalityPreset) &&
    typeof obj.personalityText === "string" &&
    typeof obj.role === "string" &&
    typeof obj.tone === "string" &&
    typeof obj.bio === "string" &&
    typeof obj.animationEnabled === "boolean" &&
    (obj.accentColor === undefined || typeof obj.accentColor === "string") &&
    (obj.voicePlaceholder === undefined ||
      typeof obj.voicePlaceholder === "string") &&
    typeof obj.updatedAt === "string"
  );
}
