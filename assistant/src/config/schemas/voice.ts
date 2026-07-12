import { z } from "zod";

export const VoiceEngineIdSchema = z.enum(["native", "hume", "elevenlabs"]);

export type VoiceEngineId = z.infer<typeof VoiceEngineIdSchema>;

const HumeVoiceProviderSchema = z.object({
  configId: z.string().default(""),
  voiceId: z.string().default(""),
});

const ElevenLabsVoiceProviderSchema = z.object({
  agentId: z.string().default(""),
  voiceId: z.string().default(""),
});

export const VoiceServiceSchema = z.object({
  engine: VoiceEngineIdSchema.default("native"),
  pilotAllowlist: z.array(z.string()).default([]),
  providers: z
    .object({
      hume: HumeVoiceProviderSchema.default(HumeVoiceProviderSchema.parse({})),
      elevenlabs: ElevenLabsVoiceProviderSchema.default(
        ElevenLabsVoiceProviderSchema.parse({}),
      ),
    })
    .default({
      hume: HumeVoiceProviderSchema.parse({}),
      elevenlabs: ElevenLabsVoiceProviderSchema.parse({}),
    }),
});

export type VoiceServiceConfig = z.infer<typeof VoiceServiceSchema>;
