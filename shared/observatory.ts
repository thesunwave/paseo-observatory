import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reportedCostUsd: z.number(),
});

const burnRateSchema = z.object({
  status: z.string(),
  reason: z.string().optional(),
  elapsedMs: z.number().optional(),
  modelTokensPerMinute: z.number().optional(),
  observedTokensPerMinute: z.number().optional(),
});

const backendCapabilitiesSchema = z.object({
  runtimeDiscovery: z.boolean(),
  nestedSessions: z.boolean(),
  liveEvents: z.boolean(),
  tokenUsage: z.boolean(),
  cacheUsage: z.boolean(),
  cacheReadUsage: z.boolean(),
  cacheWriteUsage: z.boolean(),
  reasoningUsage: z.boolean(),
  cost: z.boolean(),
  processLocalCorrelation: z.boolean(),
});

const backendSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  version: z.string().nullable(),
  capabilities: backendCapabilitiesSchema,
});

const runSummarySchema = z.object({
  id: z.string(),
  shortId: z.string(),
  title: z.string().nullable(),
  workspaceName: z.string().nullable(),
  projectName: z.string().nullable(),
  workspaceId: z.string().nullable(),
  provider: z.string(),
  model: z.string().nullable(),
  status: z.string(),
  lastActivityAt: z.string().nullable(),
  historical: z.boolean(),
});

const runDetailSchema = runSummarySchema.extend({
  rootSessionId: z.string().nullable(),
  sessionCount: z.number(),
  subagentCount: z.number(),
  runtimeCount: z.number(),
  activeRuntimeCount: z.number(),
  usage: usageSchema,
  usageScope: z.enum(["cumulative", "last_turn", "unavailable"]),
  burnRate: burnRateSchema,
});

const runtimeSchema = z.object({
  generationKey: z.string().nullable(),
  endpoint: z.string().nullable(),
  pid: z.number().nullable(),
  processStartedAt: z.string().nullable(),
  status: z.string(),
  backendId: z.string(),
  backendVersion: z.string().nullable(),
  ownedSessionCount: z.number(),
  activeModels: z.array(z.string()),
  lastActivityAt: z.string().nullable(),
});

const flowNodeSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  depth: z.number(),
  title: z.string().nullable(),
  role: z.string().nullable(),
  model: z.string().nullable(),
  status: z.string(),
  usage: usageSchema,
  modelTokens: z.number(),
  observedTokens: z.number(),
  modelTokenShare: z.number(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const agentFlowSchema = z.object({
  rootId: z.string().nullable(),
  totalModelTokens: z.number(),
  totalObservedTokens: z.number(),
  nodes: z.array(flowNodeSchema),
});

const eventSchema = z.object({
  id: z.number().optional(),
  source: z.string(),
  type: z.string(),
  observedAt: z.string(),
  runtimeGenerationKey: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  partType: z.string().nullable().optional(),
  statusType: z.string().nullable().optional(),
  turnId: z.string().nullable().optional(),
  outcomeKind: z.string().nullable().optional(),
});

const correlationSchema = z.object({
  status: z.string(),
  reason: z.string().nullable().optional(),
  rootRuntimeGenerationKey: z.string().optional(),
  ownershipEvidence: z.array(z.string()).optional(),
  unassignedSessionCount: z.number().optional(),
  ambiguousSessionCount: z.number().optional(),
});

const persistenceSchema = z.object({
  enabled: z.boolean(),
  databasePath: z.string(),
  eventCount: z.number(),
  usageSampleCount: z.number(),
  runtimeGenerationCount: z.number(),
});

const workspaceOverviewSchema = z.object({
  id: z.string(),
  name: z.string(),
  runCount: z.number(),
  activeRunCount: z.number(),
  usage: usageSchema,
  modelTokens: z.number(),
  observedTokens: z.number(),
  modelTokensPerMinute: z.number(),
  observedTokensPerMinute: z.number(),
  lastActivityAt: z.string().nullable(),
  runs: z.array(runSummarySchema),
});

const analyticsDaySchema = z.object({
  date: z.string(),
  modelTokens: z.number(),
  observedTokens: z.number(),
  cacheTokens: z.number(),
  turns: z.number(),
});

const analyticsModelSchema = z.object({
  model: z.string(),
  runCount: z.number(),
  usage: usageSchema,
  modelTokens: z.number(),
  observedTokens: z.number(),
  cacheTokens: z.number(),
  share: z.number(),
});

const analyticsBackendSchema = z.object({
  backend: z.string(),
  runCount: z.number(),
  usage: usageSchema,
  modelTokens: z.number(),
  observedTokens: z.number(),
  cacheTokens: z.number(),
  share: z.number(),
});

const analyticsInsightSchema = z.object({
  id: z.string(),
  severity: z.enum(["info", "warning"]),
  kind: z.string(),
  title: z.string(),
  detail: z.string(),
  metricLabel: z.string(),
  metricValue: z.number(),
});

const cacheAttributionSchema = z.object({
  projectName: z.string().optional(),
  workspaceName: z.string().nullable().optional(),
  runId: z.string().optional(),
  sessionId: z.string().optional(),
  parentId: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  entityType: z.enum(["root", "subagent"]).optional(),
  usage: usageSchema,
  modelTokens: z.number(),
  cacheTokens: z.number(),
  observedTokens: z.number(),
  cacheRatio: z.number().nullable(),
  cacheShare: z.number(),
});

const anomalySchema = z.object({
  id: z.string(),
  severity: z.enum(["info", "warning"]),
  entityType: z.enum(["run", "subagent"]),
  entityId: z.string(),
  runId: z.string().optional(),
  sessionId: z.string().optional(),
  parentId: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  projectName: z.string().nullable().optional(),
  workspaceName: z.string().nullable().optional(),
  metric: z.enum(["model_tokens", "cache_tokens"]),
  current: z.number(),
  baselineMedian: z.number(),
  multiplier: z.number(),
  baselineSamples: z.number(),
  bucketAt: z.string(),
  title: z.string(),
  detail: z.string(),
});

export const observatoryOverviewRpc = defineRpc({
  name: "observatory.overview",
  input: z.object({}),
  output: z.object({
    observedAt: z.string(),
    workspaceCount: z.number(),
    runCount: z.number(),
    activeRunCount: z.number(),
    usage: usageSchema,
    modelTokens: z.number(),
    observedTokens: z.number(),
    modelTokensPerMinute: z.number(),
    observedTokensPerMinute: z.number(),
    workspaces: z.array(workspaceOverviewSchema),
  }),
});

export const observatoryAnalyticsRpc = defineRpc({
  name: "observatory.analytics",
  input: z.object({
    range: z.enum(["7d", "30d", "all"]),
  }),
  output: z.object({
    observedAt: z.string(),
    range: z.enum(["7d", "30d", "all"]),
    capturedFrom: z.string().nullable(),
    summary: z.object({
      runCount: z.number(),
      turns: z.number(),
      activeDays: z.number(),
      peakHour: z.number().int().min(0).max(23).nullable(),
      favoriteModel: z.string().nullable(),
      usage: usageSchema,
      modelTokens: z.number(),
      cacheTokens: z.number(),
      observedTokens: z.number(),
      reportedCostUsd: z.number(),
    }),
    heatmap: z.array(analyticsDaySchema),
    backends: z.array(analyticsBackendSchema),
    models: z.array(analyticsModelSchema),
    cacheAttribution: z.object({
      projects: z.array(cacheAttributionSchema),
      runs: z.array(cacheAttributionSchema),
      sessions: z.array(cacheAttributionSchema),
    }),
    anomalies: z.array(anomalySchema),
    baseline: z.object({
      requiredActiveHours: z.number(),
      runs: z.object({ total: z.number(), evaluated: z.number(), insufficient: z.number() }),
      subagents: z.object({ total: z.number(), evaluated: z.number(), insufficient: z.number() }),
    }),
    insights: z.array(analyticsInsightSchema),
  }),
});

export const observatorySnapshotRpc = defineRpc({
  name: "observatory.snapshot",
  input: z.object({
    runId: z.string().optional(),
  }),
  output: z.object({
    observedAt: z.string(),
    status: z.string(),
    availableRuns: z.array(runSummarySchema),
    selectedRunId: z.string().nullable().optional(),
    backend: backendSchema.nullable(),
    run: runDetailSchema.nullable(),
    runtimes: z.array(runtimeSchema),
    flow: agentFlowSchema,
    correlation: correlationSchema,
    persistence: persistenceSchema,
    gaps: z.array(z.string()),
  }),
});

export const observatoryTimelineRpc = defineRpc({
  name: "observatory.timeline",
  input: z.object({
    runId: z.string(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.object({
    runId: z.string(),
    totalCount: z.number(),
    events: z.array(eventSchema),
  }),
});

export type ObservatorySnapshot = z.infer<typeof observatorySnapshotRpc.output>;
export type ObservatoryTimeline = z.infer<typeof observatoryTimelineRpc.output>;
export type ObservatoryOverview = z.infer<typeof observatoryOverviewRpc.output>;
export type ObservatoryAnalytics = z.infer<typeof observatoryAnalyticsRpc.output>;
