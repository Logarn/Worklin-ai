import type {
  AgentToolCategory,
  AgentToolDefinition,
  AgentToolFilters,
  AgentToolPermissionLevel,
} from "@/lib/agent/tools/types";

export const AGENT_TOOL_CATEGORIES: AgentToolCategory[] = [
  "workflow",
  "flows",
  "klaviyo",
  "playbooks",
  "memory",
  "brain",
];

export const AGENT_TOOL_PERMISSION_LEVELS: AgentToolPermissionLevel[] = [
  "read",
  "generate",
  "external_draft",
  "external_live_action",
];

export const agentToolRegistry: AgentToolDefinition[] = [
  {
    name: "workflow.retentionAudit",
    description:
      "Run Worklin's read-only Retention Audit Workflow and persist a WorkflowRun for the audit canvas.",
    category: "workflow",
    inputSchema: {
      type: "object",
      description: "Optional retention audit controls.",
      properties: {
        timeframe: {
          type: "string",
          description: "Optional audit timeframe such as last_365_days.",
        },
      },
    },
    outputDescription:
      "A persisted retention-audit WorkflowRun with summary, scorecards, insights, actions, caveats, and canvas-ready output.",
    permissionLevel: "read",
    requiresApproval: false,
    riskLevel: "low",
    currentStatus: "available",
    backingRoute: "POST /api/audits/retention",
    handlerReference: "app/api/audits/retention/route.ts",
    notes: [
      "Read-only. Does not create drafts, send, schedule, sync, or mutate Klaviyo.",
      "Agent should offer to prepare safe fixes after the audit, but must not run fix-run automatically.",
    ],
  },
  {
    name: "workflow.auditFixRun",
    description:
      "Prepare a safe fix package from a persisted retention-audit WorkflowRun and persist an audit-fix-run WorkflowRun.",
    category: "workflow",
    inputSchema: {
      type: "object",
      description: "Retention audit WorkflowRun id and optional safe preparation scope.",
      required: ["workflowId"],
      properties: {
        workflowId: {
          type: "string",
          description: "Persisted retention-audit WorkflowRun id.",
          required: true,
        },
        scope: {
          type: "string",
          description: "Optional scope: all, fix_first, campaigns, flows, audiences, or performance.",
        },
      },
    },
    outputDescription:
      "A persisted audit-fix-run WorkflowRun containing prepared fixes, blocked live actions, approval package, caveats, and metadata.",
    permissionLevel: "generate",
    requiresApproval: true,
    riskLevel: "medium",
    currentStatus: "available",
    backingRoute: "POST /api/audits/fix-run",
    handlerReference: "app/api/audits/fix-run/route.ts",
    notes: [
      "Prepare-only. Does not create drafts, create flows, sync segments, send, schedule, or change external systems.",
      "Requires explicit user confirmation after a retention audit.",
    ],
  },
  {
    name: "workflow.planBriefQa",
    description:
      "Generate a campaign plan, create briefs for the plan items, run QA for each brief, and persist the workflow run.",
    category: "workflow",
    inputSchema: {
      type: "object",
      description: "Natural-language workflow request with optional planning constraints.",
      required: ["prompt"],
      properties: {
        prompt: {
          type: "string",
          description: "User request describing the campaign workflow to generate.",
          required: true,
        },
        startDate: {
          type: "string",
          description: "Optional ISO-style date string for the plan start date.",
        },
        endDate: {
          type: "string",
          description: "Optional ISO-style date string for the plan end date.",
        },
        campaignCount: {
          type: "number",
          description: "Optional positive whole number of campaigns to recommend.",
        },
        focus: {
          type: "string",
          description: "Optional planning focus such as repeat purchase or winback.",
        },
        constraints: {
          type: "array",
          description: "Optional planning constraints.",
          items: "string",
        },
      },
    },
    outputDescription:
      "A saved workflow run containing one plan, generated briefs, QA results, summary, and recommended next action.",
    permissionLevel: "generate",
    requiresApproval: false,
    riskLevel: "medium",
    currentStatus: "available",
    backingRoute: "POST /api/agent/workflows/plan-brief-qa",
    handlerReference: "app/api/agent/workflows/plan-brief-qa/route.ts",
    notes: ["Creates local database records only. Does not call Klaviyo."],
  },
  {
    name: "workflow.approveAndCreateDrafts",
    description:
      "Interpret workflow approval intent and create Klaviyo drafts for eligible QA-passed briefs in that workflow.",
    category: "workflow",
    inputSchema: {
      type: "object",
      description: "Approval command with an optional workflow id.",
      required: ["message"],
      properties: {
        message: {
          type: "string",
          description: "Approval phrase such as approved, looks good, go ahead, or ship the drafts.",
          required: true,
        },
        workflowId: {
          type: "string",
          description: "WorkflowRun id. Required when approval context is otherwise ambiguous.",
        },
      },
    },
    outputDescription:
      "Draft creation summary with draftsCreated, held, skipped, workflowId, and a safe user-facing message.",
    permissionLevel: "external_draft",
    requiresApproval: true,
    riskLevel: "high",
    currentStatus: "available",
    backingRoute: "POST /api/agent/commands/approve-workflow",
    handlerReference: "app/api/agent/commands/approve-workflow/route.ts",
    notes: ["Draft-only. Refuses send or schedule intent."],
  },
  {
    name: "flows.recommend",
    description:
      "Read existing Klaviyo flows, detect coverage against Worklin flow playbooks, and recommend which lifecycle flows to build, finish, audit, classify, consolidate, or clean up.",
    category: "flows",
    inputSchema: {
      type: "object",
      description: "Optional flow planning context and recommendation limit.",
      properties: {
        message: {
          type: "string",
          description: "Optional natural-language request or context for the flow recommendation.",
        },
        goal: {
          type: "string",
          description: "Optional business goal such as recovering abandoned checkouts or increasing repeat purchase.",
        },
        constraints: {
          type: "array",
          description: "Optional flow planning constraints.",
          items: "string",
        },
        limit: {
          type: "number",
          description: "Optional maximum number of recommendations to return.",
        },
      },
    },
    outputDescription:
      "Read-only flow recommendation plan with recommendations, covered flows, missing core flows, draft/inactive flows, unknown flows, summary, and optional WorkflowRun id.",
    permissionLevel: "read",
    requiresApproval: false,
    riskLevel: "low",
    currentStatus: "available",
    backingRoute: "POST /api/flows/recommend",
    handlerReference: "app/api/flows/recommend/route.ts",
    notes: [
      "Reads Klaviyo flows only.",
      "Does not create, update, delete, schedule, or send Klaviyo flows.",
    ],
  },
  {
    name: "klaviyo.createDraftFromBrief",
    description: "Create a real Klaviyo HTML template and draft campaign from one Worklin CampaignBrief.",
    category: "klaviyo",
    inputSchema: {
      type: "object",
      description: "Brief id plus optional audience and content overrides.",
      required: ["briefId"],
      properties: {
        briefId: {
          type: "string",
          description: "CampaignBrief id to render into Klaviyo draft objects.",
          required: true,
        },
        audienceId: {
          type: "string",
          description: "Optional Klaviyo audience override. Defaults to configured test audience.",
        },
        overrideSubject: {
          type: "string",
          description: "Optional subject line override.",
        },
        overridePreviewText: {
          type: "string",
          description: "Optional preview text override.",
        },
        overrideFailedQa: {
          type: "boolean",
          description: "Explicitly override failed QA block when allowed by caller policy.",
        },
      },
    },
    outputDescription:
      "Klaviyo draft identifiers, local KlaviyoDraft id, campaign name, and draft_created status.",
    permissionLevel: "external_draft",
    requiresApproval: true,
    riskLevel: "high",
    currentStatus: "available",
    backingRoute: "POST /api/klaviyo/drafts/from-brief",
    handlerReference: "app/api/klaviyo/drafts/from-brief/route.ts",
    notes: ["Never schedules or sends. Requires server-side Klaviyo configuration."],
  },
  {
    name: "playbooks.list",
    description: "List registered Worklin campaign and lifecycle flow playbooks.",
    category: "playbooks",
    inputSchema: {
      type: "object",
      description: "Optional playbook type filter.",
      properties: {
        type: {
          type: "string",
          description: "Optional playbook type filter: flow or campaign.",
        },
      },
    },
    outputDescription: "Array of playbooks, optionally filtered by type.",
    permissionLevel: "read",
    requiresApproval: false,
    riskLevel: "low",
    currentStatus: "available",
    backingRoute: "GET /api/playbooks",
    handlerReference: "app/api/playbooks/route.ts",
  },
  {
    name: "playbooks.get",
    description: "Read one registered Worklin playbook by id.",
    category: "playbooks",
    inputSchema: {
      type: "object",
      description: "Playbook lookup by id.",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          description: "Playbook id, such as welcome_series or vip_early_access.",
          required: true,
        },
      },
    },
    outputDescription: "One playbook definition or not-found result.",
    permissionLevel: "read",
    requiresApproval: false,
    riskLevel: "low",
    currentStatus: "available",
    backingRoute: "GET /api/playbooks/[id]",
    handlerReference: "app/api/playbooks/[id]/route.ts",
  },
  {
    name: "memory.getCampaignInsights",
    description: "Read aggregate insights from stored Campaign Memory records.",
    category: "memory",
    inputSchema: {
      type: "object",
      description: "No input required.",
      properties: {},
    },
    outputDescription:
      "Campaign memory summary including top segments, top campaign types, revenue, averages, and recent lessons.",
    permissionLevel: "read",
    requiresApproval: false,
    riskLevel: "low",
    currentStatus: "available",
    backingRoute: "GET /api/memory/insights",
    handlerReference: "app/api/memory/insights/route.ts",
  },
  {
    name: "memory.getUnifiedCustomerIdentity",
    description:
      "Read Worklin's derived Unified Customer Identity v0 snapshot from local customer, order, event, and campaign receipt rows.",
    category: "memory",
    inputSchema: {
      type: "object",
      description: "Optional identity lookup filters and response controls.",
      properties: {
        customerId: {
          type: "string",
          description: "Optional local Customer id.",
        },
        email: {
          type: "string",
          description: "Optional customer email lookup; raw email is not returned.",
        },
        externalId: {
          type: "string",
          description: "Optional Shopify/local external customer id.",
        },
        depth: {
          type: "string",
          description: "Optional depth: compact, standard, or full.",
        },
        limit: {
          type: "number",
          description: "Optional positive whole number of identity profiles to return.",
        },
        includeMergeCandidates: {
          type: "boolean",
          description: "Whether to include review-only merge candidate hints from shared phone hashes.",
        },
      },
    },
    outputDescription:
      "Read-only identity graph summary and pseudonymous customer identity profiles. No profile merge, sync, or external action.",
    permissionLevel: "read",
    requiresApproval: false,
    riskLevel: "low",
    currentStatus: "available",
    backingRoute: "GET /api/customers/identity",
    handlerReference: "app/api/customers/identity/route.ts",
    notes: [
      "Derived from local data only.",
      "Does not return raw email or phone values.",
      "Does not merge profiles, sync profiles, create segments, send, or schedule.",
      "Tool Runtime treats this as a pure read and does not write an ActionLog entry for successful reads.",
    ],
  },
  {
    name: "memory.getCustomerFeatureStore",
    description:
      "Read persisted Customer Feature Store v0 records with local customer-level retention facts, signals, labels, and caveats.",
    category: "memory",
    inputSchema: {
      type: "object",
      description: "Optional persisted feature-store filters.",
      properties: {
        identityId: {
          type: "string",
          description: "Optional unified customer identity id.",
        },
        timeframeDays: {
          type: "number",
          description: "Optional feature timeframe to read.",
        },
        status: {
          type: "string",
          description: "Optional feature status: available, partial, or unavailable.",
        },
        limit: {
          type: "number",
          description: "Optional positive whole number of feature records to return.",
        },
      },
    },
    outputDescription:
      "Read-only compact customer feature summaries from local persisted records. No scoring, segment sync, profile sync, or external action.",
    permissionLevel: "read",
    requiresApproval: false,
    riskLevel: "low",
    currentStatus: "available",
    backingRoute: "GET /api/customers/features",
    handlerReference: "app/api/customers/features/route.ts",
    notes: [
      "Reads local CustomerFeatureStore records only.",
      "Does not compute predictive scores or final segments.",
      "Does not return raw emails, phones, addresses, raw orders, raw profiles, or source payloads.",
      "Does not write Shopify, Klaviyo, drafts, sends, schedules, segments, or profile syncs.",
    ],
  },
  {
    name: "memory.getCustomerScores",
    description:
      "Read persisted Rule-Based Customer Scoring v0 records with lifecycle and retention scores derived from Customer Feature Store facts.",
    category: "memory",
    inputSchema: {
      type: "object",
      description: "Optional persisted score-store filters.",
      properties: {
        identityId: {
          type: "string",
          description: "Optional unified customer identity id.",
        },
        timeframeDays: {
          type: "number",
          description: "Optional scoring timeframe to read.",
        },
        status: {
          type: "string",
          description: "Optional score status: available, partial, or unavailable.",
        },
        limit: {
          type: "number",
          description: "Optional positive whole number of score records to return.",
        },
      },
    },
    outputDescription:
      "Read-only compact customer score summaries from local persisted records. No segment, campaign, profile sync, or external action.",
    permissionLevel: "read",
    requiresApproval: false,
    riskLevel: "low",
    currentStatus: "available",
    backingRoute: "GET /api/customers/scores",
    handlerReference: "app/api/customers/scores/route.ts",
    notes: [
      "Reads local CustomerScoreStore records only.",
      "Scores are deterministic 0-1000 rule signals with tiers, confidence, reasons, source features, and caveats.",
      "Does not assign final segments or create campaigns, flows, drafts, sends, schedules, or profile syncs.",
      "Does not return raw emails, phones, addresses, raw orders, raw profiles, or source payloads.",
      "Does not write Shopify or Klaviyo.",
    ],
  },
  {
    name: "workflow.list",
    description: "List saved Worklin agent workflow runs.",
    category: "workflow",
    inputSchema: {
      type: "object",
      description: "Optional workflow filters.",
      properties: {
        type: {
          type: "string",
          description: "Optional workflow type filter.",
        },
        status: {
          type: "string",
          description: "Optional workflow status filter.",
        },
        limit: {
          type: "number",
          description: "Optional positive whole number result limit.",
        },
      },
    },
    outputDescription: "Array of saved workflow run summaries.",
    permissionLevel: "read",
    requiresApproval: false,
    riskLevel: "low",
    currentStatus: "available",
    backingRoute: "GET /api/agent/workflows",
    handlerReference: "app/api/agent/workflows/route.ts",
  },
  {
    name: "workflow.get",
    description: "Read one saved Worklin agent workflow run by id.",
    category: "workflow",
    inputSchema: {
      type: "object",
      description: "Workflow lookup by id.",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          description: "WorkflowRun id.",
          required: true,
        },
      },
    },
    outputDescription: "One saved workflow run including stored input, output, and error information.",
    permissionLevel: "read",
    requiresApproval: false,
    riskLevel: "low",
    currentStatus: "available",
    backingRoute: "GET /api/agent/workflows/[id]",
    handlerReference: "app/api/agent/workflows/[id]/route.ts",
  },
  {
    name: "brain.readBrandContext",
    description: "Read Worklin Brain brand profile, voice, rules, CTAs, phrases, and related brand context.",
    category: "brain",
    inputSchema: {
      type: "object",
      description: "No input required for the default store brand context.",
      properties: {},
    },
    outputDescription: "Brand profile and associated Brain guidance used for planning, brief generation, and QA.",
    permissionLevel: "read",
    requiresApproval: false,
    riskLevel: "low",
    currentStatus: "available",
    backingRoute: "GET /api/brain/profile",
    handlerReference: "app/api/brain/profile/route.ts",
  },
];

export function isAgentToolCategory(value: string): value is AgentToolCategory {
  return AGENT_TOOL_CATEGORIES.includes(value as AgentToolCategory);
}

export function isAgentToolPermissionLevel(value: string): value is AgentToolPermissionLevel {
  return AGENT_TOOL_PERMISSION_LEVELS.includes(value as AgentToolPermissionLevel);
}

export function getAgentToolByName(name: string) {
  return agentToolRegistry.find((tool) => tool.name === name) ?? null;
}

export function listAgentTools(filters: AgentToolFilters = {}) {
  return agentToolRegistry.filter((tool) => {
    if (filters.category && tool.category !== filters.category) return false;
    if (filters.permissionLevel && tool.permissionLevel !== filters.permissionLevel) return false;
    if (
      typeof filters.requiresApproval === "boolean" &&
      tool.requiresApproval !== filters.requiresApproval
    ) {
      return false;
    }
    return true;
  });
}
