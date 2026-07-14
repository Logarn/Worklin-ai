import {
  approveCopybookCampaign,
  type CampaignChannel,
  type CampaignStatus,
  createCopybook,
  createCopybookCampaign,
  createCopybookMonth,
  getCopybookDetail,
  listCopybooks,
  markCopybookCampaignReadyForDesign,
  type StrategyStatus,
  updateCopybookCampaign,
  updateCopybookMonth,
} from "../../memory/copybook-store.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

function jsonResult(value: unknown, isError = false): ToolExecutionResult {
  return { content: JSON.stringify(value, null, 2), isError };
}

function errorResult(error: unknown): ToolExecutionResult {
  return jsonResult(
    { error: error instanceof Error ? error.message : String(error) },
    true,
  );
}

function stringInput(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integerInput(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function objectInput(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null | undefined {
  const value = input[key];
  if (value === null) return null;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function executeCopybookList(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const copybookId = stringInput(input, "copybook_id");
    if (copybookId) return jsonResult(getCopybookDetail(copybookId));

    const year = integerInput(input, "year");
    if (input.year !== undefined && year === undefined) {
      return jsonResult({ error: "Year must be an integer." }, true);
    }
    return jsonResult({
      copybooks: listCopybooks({
        brandId: stringInput(input, "brand_id"),
        year,
      }),
    });
  } catch (error) {
    return errorResult(error);
  }
}

export async function executeCopybookCreate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const brandId = stringInput(input, "brand_id");
    const year = integerInput(input, "year");
    if (!brandId) return jsonResult({ error: "Brand ID is required." }, true);
    if (year === undefined || year < 2000 || year > 2200) {
      return jsonResult(
        { error: "Year must be an integer between 2000 and 2200." },
        true,
      );
    }
    return jsonResult({
      copybook: createCopybook({
        brandId,
        year,
        title: stringInput(input, "title"),
      }),
    });
  } catch (error) {
    return errorResult(error);
  }
}

export async function executeCopybookMonthCreate(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const copybookId = stringInput(input, "copybook_id");
    const month = integerInput(input, "month");
    if (!copybookId) {
      return jsonResult({ error: "Copybook ID is required." }, true);
    }
    if (month === undefined || month < 1 || month > 12) {
      return jsonResult(
        { error: "Month must be an integer between 1 and 12." },
        true,
      );
    }
    return jsonResult({
      month: createCopybookMonth({
        copybookId,
        month,
        conversationId: context.conversationId,
        title: stringInput(input, "title"),
      }),
    });
  } catch (error) {
    return errorResult(error);
  }
}

export async function executeCopybookMonthUpdate(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const monthId = stringInput(input, "month_id");
    const strategyStatus = stringInput(input, "strategy_status");
    if (!monthId) return jsonResult({ error: "Month ID is required." }, true);
    if (
      !strategyStatus ||
      !["draft", "in_review", "approved"].includes(strategyStatus)
    ) {
      return jsonResult({ error: "Unsupported strategy status." }, true);
    }
    if (strategyStatus === "approved" && input.explicitly_approved !== true) {
      return jsonResult(
        {
          error:
            "Monthly strategy approval requires explicitly_approved=true after direct human approval.",
        },
        true,
      );
    }
    return jsonResult({
      month: updateCopybookMonth(
        monthId,
        strategyStatus as StrategyStatus,
        context.sourceActorPrincipalId,
      ),
    });
  } catch (error) {
    return errorResult(error);
  }
}

export async function executeCopybookCampaignCreate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const monthId = stringInput(input, "month_id");
    const channel = stringInput(input, "channel");
    const ordinal = integerInput(input, "ordinal");
    const title = stringInput(input, "title");
    if (!monthId) return jsonResult({ error: "Month ID is required." }, true);
    if (channel !== "email" && channel !== "sms") {
      return jsonResult({ error: "Channel must be email or sms." }, true);
    }
    if (ordinal === undefined || ordinal < 1) {
      return jsonResult({ error: "Ordinal must be a positive integer." }, true);
    }
    if (!title)
      return jsonResult({ error: "Campaign title is required." }, true);
    return jsonResult({
      campaign: createCopybookCampaign({
        monthId,
        channel: channel as CampaignChannel,
        ordinal,
        title,
        packageId: stringInput(input, "package_id"),
        metadata: objectInput(input, "metadata") ?? undefined,
      }),
    });
  } catch (error) {
    return errorResult(error);
  }
}

export async function executeCopybookCampaignUpdate(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const campaignId = stringInput(input, "campaign_id");
    const action = stringInput(input, "action");
    if (!campaignId) {
      return jsonResult({ error: "Campaign ID is required." }, true);
    }
    if (action) {
      if (action !== "approve" && action !== "ready_for_design") {
        return jsonResult({ error: "Unsupported campaign action." }, true);
      }
      if (input.explicitly_approved !== true) {
        return jsonResult(
          {
            error:
              "Approval and design handoff actions require explicitly_approved=true after direct human approval.",
          },
          true,
        );
      }
      const campaign =
        action === "approve"
          ? approveCopybookCampaign(campaignId, context.sourceActorPrincipalId)
          : markCopybookCampaignReadyForDesign(
              campaignId,
              context.sourceActorPrincipalId,
            );
      return jsonResult({ campaign });
    }

    const status = stringInput(input, "status");
    const allowedStatuses = [
      "brief_draft",
      "brief_review",
      "brief_approved",
      "copy_draft",
      "copy_review",
    ];
    if (status && !allowedStatuses.includes(status)) {
      return jsonResult(
        { error: "Use action for approval or ready-for-design transitions." },
        true,
      );
    }
    if (status === "brief_approved" && input.explicitly_approved !== true) {
      return jsonResult(
        {
          error:
            "Campaign brief approval requires explicitly_approved=true after direct human approval.",
        },
        true,
      );
    }
    const metadata = objectInput(input, "metadata");
    if (input.metadata !== undefined && metadata === undefined) {
      return jsonResult({ error: "Metadata must be an object or null." }, true);
    }
    const title = stringInput(input, "title");
    if (input.title !== undefined && !title) {
      return jsonResult({ error: "Campaign title cannot be empty." }, true);
    }
    const packageId =
      input.package_id === null ? null : stringInput(input, "package_id");
    if (
      !status &&
      title === undefined &&
      input.package_id === undefined &&
      input.metadata === undefined
    ) {
      return jsonResult({ error: "No campaign updates were provided." }, true);
    }
    return jsonResult({
      campaign: updateCopybookCampaign(
        campaignId,
        {
          ...(title !== undefined ? { title } : {}),
          ...(status !== undefined
            ? {
                status: status as Exclude<
                  CampaignStatus,
                  "approved" | "ready_for_design"
                >,
              }
            : {}),
          ...(input.package_id !== undefined
            ? { packageId: packageId ?? null }
            : {}),
          ...(input.metadata !== undefined
            ? { metadata: metadata ?? null }
            : {}),
        },
        context.sourceActorPrincipalId,
      ),
    });
  } catch (error) {
    return errorResult(error);
  }
}
