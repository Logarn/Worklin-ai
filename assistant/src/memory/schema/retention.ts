import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const retentionBrands = sqliteTable("retention_brands", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  source: text("source").notNull().default("worklin"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const retentionBrandBrains = sqliteTable(
  "retention_brand_brains",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id")
      .notNull()
      .references(() => retentionBrands.id, { onDelete: "cascade" }),
    brandName: text("brand_name").notNull(),
    websiteUrl: text("website_url"),
    schemaVersion: text("schema_version").notNull(),
    profileJson: text("profile_json").notNull(),
    source: text("source").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_retention_brand_brains_brand").on(table.brandId),
    index("idx_retention_brand_brains_name").on(table.brandName),
    index("idx_retention_brand_brains_website").on(table.websiteUrl),
    index("idx_retention_brand_brains_updated_at").on(table.updatedAt),
  ],
);

export const retentionConversationBrandScopes = sqliteTable(
  "retention_conversation_brand_scopes",
  {
    conversationId: text("conversation_id").primaryKey(),
    brandId: text("brand_id")
      .notNull()
      .references(() => retentionBrands.id, { onDelete: "cascade" }),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_retention_conversation_brand_scopes_brand").on(table.brandId),
  ],
);

export const retentionBrandBrainEvents = sqliteTable(
  "retention_brand_brain_events",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id")
      .notNull()
      .references(() => retentionBrands.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull(),
    conversationId: text("conversation_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_retention_brand_brain_events_brand_created").on(
      table.brandId,
      table.createdAt,
    ),
    index("idx_retention_brand_brain_events_conversation").on(
      table.conversationId,
    ),
  ],
);

export const retentionCustomers = sqliteTable(
  "retention_customers",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id").references(() => retentionBrands.id, {
      onDelete: "cascade",
    }),
    email: text("email"),
    shopifyCustomerId: text("shopify_customer_id"),
    klaviyoProfileId: text("klaviyo_profile_id"),
    totalOrders: integer("total_orders").notNull().default(0),
    totalSpent: real("total_spent").notNull().default(0),
    avgOrderValue: real("avg_order_value").notNull().default(0),
    acceptsMarketing: integer("accepts_marketing").notNull().default(0),
    metadataJson: text("metadata_json"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_retention_customers_brand").on(table.brandId),
    index("idx_retention_customers_email").on(table.email),
    index("idx_retention_customers_shopify").on(table.shopifyCustomerId),
    index("idx_retention_customers_klaviyo").on(table.klaviyoProfileId),
  ],
);

export const retentionSourceSnapshots = sqliteTable(
  "retention_source_snapshots",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id").references(() => retentionBrands.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    sourceFreshnessAt: integer("source_freshness_at"),
    snapshotJson: text("snapshot_json").notNull(),
    caveatsJson: text("caveats_json"),
    safetyJson: text("safety_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_retention_source_snapshots_brand_provider").on(
      table.brandId,
      table.provider,
    ),
    index("idx_retention_source_snapshots_created_at").on(table.createdAt),
  ],
);

export const retentionFeatureSnapshots = sqliteTable(
  "retention_feature_snapshots",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id").references(() => retentionBrands.id, {
      onDelete: "cascade",
    }),
    customerId: text("customer_id").references(() => retentionCustomers.id, {
      onDelete: "cascade",
    }),
    identityId: text("identity_id").notNull(),
    featureVersion: text("feature_version").notNull(),
    timeframeDays: integer("timeframe_days").notNull(),
    status: text("status").notNull(),
    featuresJson: text("features_json").notNull(),
    labelsJson: text("labels_json"),
    caveatsJson: text("caveats_json"),
    computedAt: integer("computed_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_retention_feature_snapshots_identity").on(table.identityId),
    index("idx_retention_feature_snapshots_brand").on(table.brandId),
    index("idx_retention_feature_snapshots_computed_at").on(table.computedAt),
  ],
);

export const retentionCustomerScores = sqliteTable(
  "retention_customer_scores",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id").references(() => retentionBrands.id, {
      onDelete: "cascade",
    }),
    customerId: text("customer_id").references(() => retentionCustomers.id, {
      onDelete: "cascade",
    }),
    identityId: text("identity_id").notNull(),
    scoringVersion: text("scoring_version").notNull(),
    status: text("status").notNull(),
    scoresJson: text("scores_json").notNull(),
    actionHintsJson: text("action_hints_json"),
    caveatsJson: text("caveats_json"),
    computedAt: integer("computed_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_retention_customer_scores_identity").on(table.identityId),
    index("idx_retention_customer_scores_brand").on(table.brandId),
    index("idx_retention_customer_scores_computed_at").on(table.computedAt),
  ],
);

export const retentionMicroSegmentDefinitions = sqliteTable(
  "retention_micro_segment_definitions",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id").references(() => retentionBrands.id, {
      onDelete: "cascade",
    }),
    definitionKey: text("definition_key").notNull(),
    definitionVersion: text("definition_version").notNull(),
    activationStatus: text("activation_status").notNull(),
    definitionJson: text("definition_json").notNull(),
    safetyJson: text("safety_json").notNull(),
    computedAt: integer("computed_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_retention_micro_segments_key").on(table.definitionKey),
    index("idx_retention_micro_segments_brand").on(table.brandId),
  ],
);

export const retentionCampaignOpportunities = sqliteTable(
  "retention_campaign_opportunities",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id").references(() => retentionBrands.id, {
      onDelete: "cascade",
    }),
    opportunityKey: text("opportunity_key").notNull(),
    opportunityVersion: text("opportunity_version").notNull(),
    status: text("status").notNull(),
    opportunityType: text("opportunity_type").notNull(),
    opportunityJson: text("opportunity_json").notNull(),
    safetyJson: text("safety_json").notNull(),
    computedAt: integer("computed_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_retention_campaign_opportunities_key").on(table.opportunityKey),
    index("idx_retention_campaign_opportunities_brand").on(table.brandId),
    index("idx_retention_campaign_opportunities_computed_at").on(
      table.computedAt,
    ),
  ],
);

export const retentionMicroCampaignPackages = sqliteTable(
  "retention_micro_campaign_packages",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id").references(() => retentionBrands.id, {
      onDelete: "cascade",
    }),
    opportunityId: text("opportunity_id").references(
      () => retentionCampaignOpportunities.id,
      { onDelete: "set null" },
    ),
    packageVersion: text("package_version").notNull(),
    activationStatus: text("activation_status").notNull(),
    status: text("status").notNull(),
    packageJson: text("package_json").notNull(),
    safetyJson: text("safety_json").notNull(),
    computedAt: integer("computed_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_retention_micro_packages_brand").on(table.brandId),
    index("idx_retention_micro_packages_opportunity").on(table.opportunityId),
  ],
);

export const retentionQaChecks = sqliteTable(
  "retention_qa_checks",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id").references(() => retentionBrands.id, {
      onDelete: "cascade",
    }),
    packageId: text("package_id").references(
      () => retentionMicroCampaignPackages.id,
      { onDelete: "cascade" },
    ),
    qaVersion: text("qa_version").notNull(),
    status: text("status").notNull(),
    checksJson: text("checks_json").notNull(),
    safetyJson: text("safety_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_retention_qa_checks_package").on(table.packageId),
    index("idx_retention_qa_checks_brand").on(table.brandId),
  ],
);

export const retentionActionLogs = sqliteTable(
  "retention_action_logs",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id").references(() => retentionBrands.id, {
      onDelete: "set null",
    }),
    event: text("event").notNull(),
    action: text("action").notNull(),
    status: text("status").notNull(),
    actor: text("actor").notNull().default("assistant"),
    targetJson: text("target_json"),
    risk: text("risk").notNull().default("low"),
    requiresApproval: integer("requires_approval").notNull().default(0),
    externalActionTaken: integer("external_action_taken").notNull().default(0),
    canGoLiveNow: integer("can_go_live_now").notNull().default(0),
    inputSummary: text("input_summary"),
    outputSummary: text("output_summary"),
    metadataJson: text("metadata_json"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_retention_action_logs_brand").on(table.brandId),
    index("idx_retention_action_logs_created_at").on(table.createdAt),
  ],
);

export const retentionExternalDrafts = sqliteTable(
  "retention_external_drafts",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id").references(() => retentionBrands.id, {
      onDelete: "cascade",
    }),
    packageId: text("package_id").references(
      () => retentionMicroCampaignPackages.id,
      { onDelete: "set null" },
    ),
    provider: text("provider").notNull(),
    providerDraftId: text("provider_draft_id"),
    status: text("status").notNull(),
    draftJson: text("draft_json").notNull(),
    safetyJson: text("safety_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_retention_external_drafts_brand").on(table.brandId),
    index("idx_retention_external_drafts_package").on(table.packageId),
  ],
);

export const retentionCopybooks = sqliteTable(
  "retention_copybooks",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id")
      .notNull()
      .references(() => retentionBrands.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_retention_copybooks_brand_year").on(
      table.brandId,
      table.year,
    ),
  ],
);

export const retentionCopybookMonths = sqliteTable(
  "retention_copybook_months",
  {
    id: text("id").primaryKey(),
    copybookId: text("copybook_id")
      .notNull()
      .references(() => retentionCopybooks.id, { onDelete: "cascade" }),
    month: integer("month").notNull(),
    documentSurfaceId: text("document_surface_id"),
    strategyStatus: text("strategy_status").notNull().default("draft"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_retention_copybook_months_copybook_month").on(
      table.copybookId,
      table.month,
    ),
    uniqueIndex("idx_retention_copybook_months_document").on(
      table.documentSurfaceId,
    ),
  ],
);

export const retentionCopybookCampaigns = sqliteTable(
  "retention_copybook_campaigns",
  {
    id: text("id").primaryKey(),
    monthId: text("month_id")
      .notNull()
      .references(() => retentionCopybookMonths.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    ordinal: integer("ordinal").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("brief_draft"),
    packageId: text("package_id").references(
      () => retentionMicroCampaignPackages.id,
      { onDelete: "set null" },
    ),
    metadataJson: text("metadata_json"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_retention_copybook_campaigns_position").on(
      table.monthId,
      table.channel,
      table.ordinal,
    ),
    index("idx_retention_copybook_campaigns_package").on(table.packageId),
  ],
);

export const retentionCopybookSnapshots = sqliteTable(
  "retention_copybook_snapshots",
  {
    id: text("id").primaryKey(),
    monthId: text("month_id")
      .notNull()
      .references(() => retentionCopybookMonths.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id").references(
      () => retentionCopybookCampaigns.id,
      { onDelete: "set null" },
    ),
    kind: text("kind").notNull(),
    revision: integer("revision").notNull(),
    documentContent: text("document_content").notNull(),
    documentUpdatedAt: integer("document_updated_at").notNull(),
    campaignStateJson: text("campaign_state_json").notNull(),
    actorPrincipalId: text("actor_principal_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_retention_copybook_snapshots_revision").on(
      table.monthId,
      table.kind,
      table.revision,
    ),
    index("idx_retention_copybook_snapshots_campaign").on(table.campaignId),
  ],
);
