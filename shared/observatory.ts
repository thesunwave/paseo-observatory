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
  burnRate: burnRateSchema,
});

const runtimeSchema = z.object({
  generationKey: z.string().nullable(),
  endpoint: z.string(),
  pid: z.number(),
  processStartedAt: z.string(),
  status: z.string(),
  openCodeVersion: z.string().nullable(),
  processLocalSessionCount: z.number(),
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
