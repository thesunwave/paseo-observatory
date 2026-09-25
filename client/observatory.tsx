import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  observatorySnapshotRpc,
  observatoryTimelineRpc,
  type ObservatorySnapshot,
  type ObservatoryTimeline,
} from "../shared/observatory";

const REFRESH_MS = 2500;

function compactNumber(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function money(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function relativeTime(value: string | null | undefined) {
  if (!value) return "-";
  const delta = Date.now() - Date.parse(value);
  if (!Number.isFinite(delta)) return "-";
  if (delta < 5000) return "now";
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  return `${Math.round(delta / 3_600_000)}h ago`;
}

function shortGeneration(value: string | null | undefined) {
  if (!value) return "unresolved";
  const [endpoint, ...rest] = value.split("|");
  return `${endpoint.replace("http://127.0.0.1:", ":")} | ${rest.join(" | ")}`;
}

export function ObservatorySurface({ theme, layout, navigation }: PluginSurfaceProps) {
  const getSnapshot = useRpc(observatorySnapshotRpc);
  const getTimeline = useRpc(observatoryTimelineRpc);
  const [snapshot, setSnapshot] = useState<ObservatorySnapshot | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [timeline, setTimeline] = useState<ObservatoryTimeline | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const refresh = async () => {
      try {
        setRefreshing(true);
        const next = await getSnapshot(selectedRunId ? { runId: selectedRunId } : {});
        if (!disposed) {
          setSnapshot(next);
          setError(null);
        }
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (!disposed) setRefreshing(false);
      }
    };

    void refresh();
    timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
    };
  }, [getSnapshot, selectedRunId]);

  useEffect(() => {
    setTimeline(null);
  }, [snapshot?.selectedRunId]);

  const styles = useMemo(() => {
    const colors = theme.colors;
    const gap = layout.compact ? 10 : 14;
    return {
      screen: {
        flex: 1,
        backgroundColor: colors.surface0,
      },
      content: {
        padding: layout.compact ? 12 : 18,
        gap,
      },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 12,
      },
      eyebrow: {
        color: colors.accent,
        fontSize: 11,
        fontWeight: "700" as const,
        letterSpacing: 1.4,
      },
      title: {
        color: colors.foreground,
        fontSize: layout.compact ? 22 : 28,
        fontWeight: "800" as const,
      },
      muted: {
        color: colors.foregroundMuted,
        fontSize: 12,
      },
      card: {
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 12,
        padding: layout.compact ? 12 : 14,
        gap: 10,
      },
      raised: {
        backgroundColor: colors.surface2,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 10,
        gap: 4,
      },
      sectionTitle: {
        color: colors.foreground,
        fontSize: 13,
        fontWeight: "700" as const,
        letterSpacing: 0.4,
      },
      row: {
        flexDirection: "row" as const,
        gap: 8,
        flexWrap: "wrap" as const,
      },
      metric: {
        minWidth: layout.compact ? 120 : 150,
        flexGrow: 1,
        flexBasis: 0,
      },
      metricValue: {
        color: colors.foreground,
        fontSize: 20,
        fontWeight: "800" as const,
      },
      label: {
        color: colors.foregroundMuted,
        fontSize: 10,
        fontWeight: "600" as const,
        letterSpacing: 0.8,
        textTransform: "uppercase" as const,
      },
      pill: {
        borderRadius: 999,
        borderWidth: 1,
        borderColor: colors.border,
        paddingHorizontal: 9,
        paddingVertical: 5,
      },
      pillText: {
        color: colors.foreground,
        fontSize: 11,
        fontWeight: "700" as const,
      },
      runButton: {
        borderRadius: 10,
        borderWidth: 1,
        borderColor: colors.border,
        paddingHorizontal: 10,
        paddingVertical: 9,
        width: layout.compact ? 190 : 230,
        minHeight: 48,
      },
      runButtonActive: {
        borderColor: colors.accent,
        backgroundColor: colors.surface2,
      },
      runTitle: {
        color: colors.foreground,
        fontSize: 12,
        fontWeight: "700" as const,
      },
      projectGroup: {
        gap: 7,
      },
      projectHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
      },
      projectTitle: {
        color: colors.foreground,
        fontSize: 12,
        fontWeight: "700" as const,
      },
      chatLink: {
        flex: 1,
        minHeight: 48,
        justifyContent: "center" as const,
      },
      openHint: {
        color: colors.accent,
        fontSize: 11,
        fontWeight: "700" as const,
        marginTop: 3,
      },
      event: {
        borderTopWidth: 1,
        borderTopColor: colors.border,
        paddingTop: 8,
        gap: 2,
      },
      timelineToggle: {
        minHeight: 44,
        minWidth: 72,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: colors.border,
        paddingHorizontal: 12,
      },
      flowCanvas: {
        flexDirection: layout.compact ? ("column" as const) : ("row" as const),
        alignItems: layout.compact ? ("stretch" as const) : ("flex-start" as const),
        gap: layout.compact ? 12 : 18,
      },
      flowRootColumn: {
        width: layout.compact ? ("100%" as const) : 250,
        flexShrink: 0,
      },
      flowRootCard: {
        backgroundColor: colors.surface2,
        borderColor: colors.accent,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 7,
      },
      flowRootLabel: {
        color: colors.accent,
        fontSize: 10,
        fontWeight: "800" as const,
        letterSpacing: 1,
        textTransform: "uppercase" as const,
      },
      flowRootValue: {
        color: colors.foreground,
        fontSize: 24,
        fontWeight: "800" as const,
      },
      flowChildrenColumn: {
        flex: 1,
        minWidth: 0,
        gap: 8,
      },
      flowBranch: {
        borderLeftWidth: 1,
        borderLeftColor: colors.border,
        gap: 8,
      },
      flowChildRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        minWidth: 0,
      },
      flowConnector: {
        width: 44,
        height: 20,
        flexShrink: 0,
        justifyContent: "center" as const,
      },
      flowLine: {
        width: 36,
        borderRadius: 999,
      },
      flowDot: {
        position: "absolute" as const,
        right: 2,
        width: 8,
        height: 8,
        borderRadius: 999,
        backgroundColor: colors.accent,
      },
      flowNode: {
        flex: 1,
        minWidth: 0,
        backgroundColor: colors.surface2,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 5,
      },
      flowNodeBusy: {
        borderColor: colors.accent,
      },
      flowNodeTop: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      flowNodeTitle: {
        color: colors.foreground,
        fontSize: 12,
        fontWeight: "700" as const,
        flex: 1,
      },
      flowShare: {
        color: colors.accent,
        fontSize: 11,
        fontWeight: "800" as const,
      },
      flowTokenRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 8,
      },
      flowToken: {
        color: colors.foregroundMuted,
        fontSize: 11,
      },
      flowHint: {
        color: colors.foregroundMuted,
        fontSize: 11,
      },
      error: {
        color: colors.statusDanger,
        fontSize: 12,
      },
      success: {
        color: colors.statusSuccess,
      },
      warning: {
        color: colors.statusWarning,
      },
    };
  }, [theme, layout.compact]);

  const run = snapshot?.run ?? null;
  const usage = run?.usage;
  const burn = run?.burnRate;
  const flow = snapshot?.flow;
  const projectGroups = useMemo(() => {
    const groups = new Map<string, ObservatorySnapshot["availableRuns"]>();
    for (const item of snapshot?.availableRuns ?? []) {
      const projectName = item.projectName ?? "Other";
      const runs = groups.get(projectName) ?? [];
      runs.push(item);
      groups.set(projectName, runs);
    }
    return [...groups.entries()].map(([projectName, runs]) => ({ projectName, runs }));
  }, [snapshot?.availableRuns]);
  const canOpenChat = Boolean(run && !run.historical && navigation?.openAgent);
  const openSelectedRun = () => {
    if (!run || !canOpenChat) return;
    navigation?.openAgent({ agentId: run.id });
  };
  const flowNodesByParent = useMemo(() => {
    const byParent = new Map<string, ObservatorySnapshot["flow"]["nodes"]>();
    for (const node of flow?.nodes ?? []) {
      if (!node.parentId) continue;
      const children = byParent.get(node.parentId) ?? [];
      children.push(node);
      byParent.set(node.parentId, children);
    }
    for (const children of byParent.values()) {
      children.sort((left, right) => right.modelTokens - left.modelTokens);
    }
    return byParent;
  }, [flow?.nodes]);
  const rootFlowNode = flow?.nodes.find((node) => node.id === flow.rootId) ?? null;

  const renderFlowChildren = (parentId: string, depth = 0): React.ReactNode => {
    const children = flowNodesByParent.get(parentId) ?? [];
    if (children.length === 0) return null;
    return (
      <View style={[styles.flowBranch, depth > 0 ? { marginLeft: 26 } : null]}>
        {children.map((node) => {
          const active = node.status === "busy" || node.status === "retry";
          const lineHeight = Math.max(2, Math.min(8, 2 + node.modelTokenShare * 14));
          return (
            <View key={node.id}>
              <View style={styles.flowChildRow}>
                <View style={styles.flowConnector}>
                  <View
                    style={[
                      styles.flowLine,
                      {
                        height: lineHeight,
                        backgroundColor: active ? theme.colors.accent : theme.colors.border,
                      },
                    ]}
                  />
                  <View
                    style={[
                      styles.flowDot,
                      { backgroundColor: active ? theme.colors.accent : theme.colors.foregroundMuted },
                    ]}
                  />
                </View>
                <View style={[styles.flowNode, active ? styles.flowNodeBusy : null]}>
                  <View style={styles.flowNodeTop}>
                    <Text style={styles.flowNodeTitle} numberOfLines={1}>
                      {node.title || node.role || `Subagent ${node.id.slice(0, 7)}`}
                    </Text>
                    <Text style={styles.flowShare}>{Math.round(node.modelTokenShare * 100)}%</Text>
                  </View>
                  <Text style={styles.muted} numberOfLines={1}>
                    {node.role ?? "subagent"} · {node.model ?? "unknown model"} · {node.status}
                  </Text>
                  <View style={styles.flowTokenRow}>
                    <Text style={styles.flowToken}>in {compactNumber(node.usage.inputTokens)}</Text>
                    <Text style={styles.flowToken}>out {compactNumber(node.usage.outputTokens)}</Text>
                    <Text style={styles.flowToken}>reason {compactNumber(node.usage.reasoningTokens)}</Text>
                    <Text style={styles.flowToken}>cache {compactNumber(node.usage.cacheReadTokens + node.usage.cacheWriteTokens)}</Text>
                    <Text style={styles.flowToken}>{money(node.usage.reportedCostUsd)}</Text>
                  </View>
                </View>
              </View>
              {renderFlowChildren(node.id, depth + 1)}
            </View>
          );
        })}
      </View>
    );
  };

  const toggleTimeline = async () => {
    if (timeline) {
      setTimeline(null);
      return;
    }
    if (!run || timelineLoading) return;
    setTimelineLoading(true);
    try {
      const loaded = await getTimeline({ runId: run.id, limit: 40 });
      setTimeline(loaded);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setTimelineLoading(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>PASEO / OBSERVATORY</Text>
          <Text style={styles.title}>Agent operations</Text>
        </View>
        <View style={styles.pill}>
          <Text style={styles.pillText}>{refreshing ? "SYNC" : "LIVE"}</Text>
        </View>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Runs by project</Text>
        {projectGroups.map(({ projectName, runs }) => (
          <View key={projectName} style={styles.projectGroup}>
            <View style={styles.projectHeader}>
              <Text style={styles.projectTitle}>{projectName}</Text>
              <Text style={styles.muted}>{runs.length}</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.row}>
                {runs.slice(0, 24).map((item) => {
                  const active = (selectedRunId ?? snapshot?.selectedRunId) === item.id;
                  return (
                    <Pressable
                      key={item.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Inspect run ${item.title || item.shortId}`}
                      onPress={() => setSelectedRunId(item.id)}
                      style={[styles.runButton, active ? styles.runButtonActive : null]}
                    >
                      <Text style={styles.runTitle} numberOfLines={2}>
                        {item.title || item.shortId}
                      </Text>
                      <Text style={styles.muted}>
                        {item.status} · {relativeTime(item.lastActivityAt)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        ))}
      </View>

      {run ? (
        <>
          <View style={styles.card}>
            <View style={styles.header}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open chat ${run.title || run.shortId}`}
                disabled={!canOpenChat}
                onPress={openSelectedRun}
                style={styles.chatLink}
              >
                <Text style={styles.label}>Selected run</Text>
                <Text style={styles.sectionTitle}>{run.title || run.shortId}</Text>
                <Text style={styles.muted}>
                  {run.projectName ? `${run.projectName} · ` : ""}
                  {run.shortId} · {run.model ?? run.provider} · {relativeTime(run.lastActivityAt)}
                </Text>
                {canOpenChat ? <Text style={styles.openHint}>Open chat</Text> : null}
              </Pressable>
              <Text
                style={[
                  styles.pillText,
                  run.status === "active"
                    ? styles.success
                    : run.status === "waiting" || run.status === "idle"
                      ? styles.warning
                      : null,
                ]}
              >
                {run.status.toUpperCase()}
              </Text>
            </View>

            <View style={styles.row}>
              <View style={[styles.raised, styles.metric]}>
                <Text style={styles.label}>Model burn / min</Text>
                <Text style={styles.metricValue}>{compactNumber(burn?.modelTokensPerMinute)}</Text>
                <Text style={styles.muted}>{burn?.status ?? "warming"}</Text>
              </View>
              <View style={[styles.raised, styles.metric]}>
                <Text style={styles.label}>Observed tokens / min</Text>
                <Text style={styles.metricValue}>{compactNumber(burn?.observedTokensPerMinute)}</Text>
                <Text style={styles.muted}>includes cache traffic</Text>
              </View>
              <View style={[styles.raised, styles.metric]}>
                <Text style={styles.label}>Runtimes</Text>
                <Text style={styles.metricValue}>{run.runtimeCount}</Text>
                <Text style={styles.muted}>{run.activeRuntimeCount} active</Text>
              </View>
              <View style={[styles.raised, styles.metric]}>
                <Text style={styles.label}>Sessions</Text>
                <Text style={styles.metricValue}>{run.sessionCount}</Text>
                <Text style={styles.muted}>{run.subagentCount} children</Text>
              </View>
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Usage</Text>
            <View style={styles.row}>
              {[
                ["Input", compactNumber(usage?.inputTokens)],
                ["Output", compactNumber(usage?.outputTokens)],
                ["Reasoning", compactNumber(usage?.reasoningTokens)],
                ["Cache read", compactNumber(usage?.cacheReadTokens)],
                ["Cache write", compactNumber(usage?.cacheWriteTokens)],
                ["Reported cost", money(usage?.reportedCostUsd)],
              ].map(([label, value]) => (
                <View key={label} style={[styles.raised, styles.metric]}>
                  <Text style={styles.label}>{label}</Text>
                  <Text style={styles.metricValue}>{value}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.card}>
            <View style={styles.header}>
              <View>
                <Text style={styles.sectionTitle}>Agent flow</Text>
                <Text style={styles.muted}>
                  {compactNumber(flow?.totalModelTokens)} model tokens · {compactNumber(flow?.totalObservedTokens)} observed
                </Text>
              </View>
              <Text style={styles.flowHint}>line width = cumulative model tokens</Text>
            </View>
            {rootFlowNode ? (
              <View style={styles.flowCanvas}>
                <View style={styles.flowRootColumn}>
                  <View style={styles.flowRootCard}>
                    <Text style={styles.flowRootLabel}>Main chat</Text>
                    <Text style={styles.runTitle} numberOfLines={2}>
                      {run.title || rootFlowNode.title || run.shortId}
                    </Text>
                    <Text style={styles.flowRootValue}>{compactNumber(rootFlowNode.modelTokens)}</Text>
                    <Text style={styles.muted}>model tokens · {Math.round(rootFlowNode.modelTokenShare * 100)}% of run</Text>
                    <View style={styles.flowTokenRow}>
                      <Text style={styles.flowToken}>in {compactNumber(rootFlowNode.usage.inputTokens)}</Text>
                      <Text style={styles.flowToken}>out {compactNumber(rootFlowNode.usage.outputTokens)}</Text>
                      <Text style={styles.flowToken}>reason {compactNumber(rootFlowNode.usage.reasoningTokens)}</Text>
                    </View>
                    <Text style={styles.muted} numberOfLines={1}>
                      {rootFlowNode.role ?? "orchestrator"} · {rootFlowNode.model ?? run.model ?? "unknown model"}
                    </Text>
                  </View>
                </View>
                <View style={styles.flowChildrenColumn}>{renderFlowChildren(rootFlowNode.id)}</View>
              </View>
            ) : (
              <Text style={styles.muted}>Session topology is not available for this run yet.</Text>
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Runtime generations</Text>
            {(snapshot?.runtimes ?? []).map((runtime) => (
              <View key={runtime.generationKey ?? `${runtime.endpoint}-${runtime.pid}`} style={styles.raised}>
                <View style={styles.header}>
                  <Text style={styles.runTitle}>{shortGeneration(runtime.generationKey)}</Text>
                  <Text style={styles.muted}>{runtime.status}</Text>
                </View>
                <Text style={styles.muted}>
                  PID {runtime.pid} · OpenCode {runtime.openCodeVersion ?? "?"} · {runtime.processLocalSessionCount} local sessions
                </Text>
                <Text style={styles.muted}>
                  {runtime.activeModels.join(", ") || "no active model"} · last {relativeTime(runtime.lastActivityAt)}
                </Text>
              </View>
            ))}
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Persistent telemetry</Text>
            <View style={styles.row}>
              <View style={[styles.raised, styles.metric]}>
                <Text style={styles.label}>Events</Text>
                <Text style={styles.metricValue}>{snapshot?.persistence.eventCount ?? 0}</Text>
              </View>
              <View style={[styles.raised, styles.metric]}>
                <Text style={styles.label}>Usage samples</Text>
                <Text style={styles.metricValue}>{snapshot?.persistence.usageSampleCount ?? 0}</Text>
              </View>
              <View style={[styles.raised, styles.metric]}>
                <Text style={styles.label}>Runtime generations</Text>
                <Text style={styles.metricValue}>{snapshot?.persistence.runtimeGenerationCount ?? 0}</Text>
              </View>
            </View>
            <Text style={styles.muted}>
              SQLite · correlation {snapshot?.correlation.status ?? "unknown"}
              {snapshot?.correlation.reason ? ` · ${snapshot.correlation.reason}` : ""}
            </Text>
            <Text style={styles.muted} numberOfLines={2}>
              {snapshot?.persistence.databasePath}
            </Text>
          </View>

          <View style={styles.card}>
            <View style={styles.header}>
              <View>
                <Text style={styles.sectionTitle}>Execution timeline</Text>
                <Text style={styles.muted}>
                  {timeline ? `${timeline.totalCount} persisted events · latest ${timeline.events.length} loaded` : `${snapshot?.persistence.eventCount ?? 0} persisted events · not loaded`}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={timeline ? "Unload execution timeline" : "Load execution timeline"}
                disabled={timelineLoading}
                onPress={() => void toggleTimeline()}
                style={styles.timelineToggle}
              >
                <Text style={styles.pillText}>{timelineLoading ? "Loading" : timeline ? "Hide" : "Show"}</Text>
              </Pressable>
            </View>
            {timeline
              ? timeline.events.slice().reverse().map((event) => (
                  <View key={`${event.id ?? "live"}-${event.source}-${event.observedAt}-${event.type}`} style={styles.event}>
                    <View style={styles.header}>
                      <Text style={styles.runTitle}>{event.type}</Text>
                      <Text style={styles.muted}>{relativeTime(event.observedAt)}</Text>
                    </View>
                    <Text style={styles.muted}>
                      {event.source}
                      {event.sessionId ? ` · ${event.sessionId.slice(0, 12)}` : ""}
                      {event.partType ? ` · ${event.partType}` : ""}
                      {event.outcomeKind ? ` · ${event.outcomeKind}` : ""}
                    </Text>
                  </View>
                ))
              : null}
          </View>

          {(snapshot?.gaps ?? []).length ? (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Known gaps</Text>
              {snapshot!.gaps.map((gap) => (
                <Text key={gap} style={styles.muted}>• {gap}</Text>
              ))}
            </View>
          ) : null}
        </>
      ) : (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>No run selected</Text>
          <Text style={styles.muted}>Start or select an OpenCode-backed Paseo agent.</Text>
        </View>
      )}
    </ScrollView>
  );
}
