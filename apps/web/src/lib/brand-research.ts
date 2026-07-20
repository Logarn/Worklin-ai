import { client } from "@/generated/api/client.gen";
import { assertHasResponse, extractErrorMessage } from "@/utils/api-errors";

export interface BrandResearchRun {
  id: string;
  assistant_id: string;
  brand_name: string;
  website_url: string | null;
  status:
    | "queued"
    | "running"
    | "partial"
    | "complete"
    | "failed"
    | "cancelled";
  tracks: string[];
  evidence_count: number;
  created_at: string;
  updated_at: string;
  error: string | null;
}

export async function listBrandResearchRuns(): Promise<BrandResearchRun[]> {
  const { data, error, response } = await client.get<
    BrandResearchRun[],
    unknown
  >({
    url: "/v1/brand-research/runs/",
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load brand research status.");
  if (!response.ok) {
    throw new Error(
      extractErrorMessage(
        error,
        response,
        "Failed to load brand research status.",
      ),
    );
  }
  return data ?? [];
}

export async function enqueueBrandResearchRun(input: {
  assistantId: string;
  brandName?: string;
  websiteUrl?: string;
}): Promise<BrandResearchRun | null> {
  const { data, error, response } = await client.post<
    BrandResearchRun,
    unknown
  >({
    url: "/v1/brand-research/runs/",
    body: {
      assistantId: input.assistantId,
      brandName: input.brandName,
      websiteUrl: input.websiteUrl,
    },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to queue brand research.");
  if (!response.ok) {
    throw new Error(
      extractErrorMessage(error, response, "Failed to queue brand research."),
    );
  }
  return data ?? null;
}
