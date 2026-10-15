import { z } from "zod";

const shortText = z.string().max(512);
const textList = z.array(z.string().max(160)).max(32);

export const ConcurrentOnboardingContextSchema = z
  .object({
    tools: textList,
    tasks: textList,
    tone: z.string().max(128),
    userName: shortText.optional(),
    occupation: shortText.optional(),
    assistantName: shortText.optional(),
    brandName: shortText.optional(),
    websiteUrl: z.string().max(2_048).optional(),
    contentSourceUrl: z.string().max(2_048).optional(),
    priorAssistants: textList.optional(),
    googleConnected: z.boolean().optional(),
    googleScopes: textList.optional(),
    cohort: z.string().max(160).optional(),
    initialMessage: z.string().max(16_000).optional(),
    bootstrapTemplate: z.string().max(256).optional(),
    skills: textList.optional(),
  })
  .strict();

export type ConcurrentOnboardingContext = z.infer<
  typeof ConcurrentOnboardingContextSchema
>;
