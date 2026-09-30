import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  observatoryAnalyticsRpc,
  type ObservatoryAnalytics,
} from "../shared/observatory";
import { ModelUsageList } from "./model-usage-list";

export type AnalyticsSection = "usage" | "models" | "insights";
type AnalyticsRange = "7d" | "30d" | "all";

const REFRESH_MS = 10_000;

function compactNumber(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function money(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function formatHour(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  const suffix = value >= 12 ? "PM" : "AM";
  const hour = value % 12 || 12;
  return `${hour} ${suffix}`;
}

function ratioLabel(value: number | null | undefined) {
  if (value === null) return "cache only";
  if (value === undefined || !Number.isFinite(value)) return "-";
  return `${value.toFixed(value >= 10 ? 0 : 1)}x`;
}

function backendLabel(value: string) {
  return ({
    opencode: "OpenCode",
    claude: "Claude Code",
    codex: "Codex",
    copilot: "GitHub Copilot",
    pi: "Pi",
    omp: "Oh My Pi",
  } as Record<string, string>)[value] ?? value;
}

function calendarWeeks(days: ObservatoryAnalytics["heatmap"]) {
  if (days.length === 0) return [];
  const first = new Date(`${days[0].date}T12:00:00`);
  const mondayOffset = (first.getDay() + 6) % 7;
  const padded: Array<ObservatoryAnalytics["heatmap"][number] | null> = [
    ...Array.from({ length: mondayOffset }, () => null),
    ...days,
  ];
  while (padded.length % 7 !== 0) padded.push(null);
  const weeks = [];
  for (let index = 0; index < padded.length; index += 7) weeks.push(padded.slice(index, index + 7));
  return weeks;
}

export function ObservatoryAnalyticsPanel({
  theme,
  layout,
  section,
}: {
  theme: PluginSurfaceProps["theme"];
  layout: PluginSurfaceProps["layout"];
  section: AnalyticsSection;
}) {
  const getAnalytics = useRpc(observatoryAnalyticsRpc);
  const [range, setRange] = useState<AnalyticsRange>("all");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(new Set());
  const analyticsQuery = useQuery({
    queryKey: ["observatory", "analytics", range],
    queryFn: () => getAnalytics({ range }),
    refetchInterval: REFRESH_MS,
  });
  const analytics: ObservatoryAnalytics | null = analyticsQuery.data ?? null;
  const loading = analyticsQuery.isFetching;
  const error =
    analyticsQuery.error instanceof Error
      ? analyticsQuery.error.message
      : analyticsQuery.error
        ? String(analyticsQuery.error)
        : null;

  useEffect(() => setSelectedDate(null), [range]);

  const toggleCacheGroup = (key: string) =>
    setExpandedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const styles = useMemo(() => {
    const colors = theme.colors;
    const gap = layout.compact ? 8 : 12;
    return {
      wrap: { gap },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 10,
        flexWrap: "wrap" as const,
      },
      responsiveHeader: {
        flexDirection: layout.compact ? ("column" as const) : ("row" as const),
        alignItems: layout.compact ? ("stretch" as const) : ("center" as const),
        justifyContent: "space-between" as const,
        gap: layout.compact ? 8 : 10,
      },
      headerCopy: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
      },
      rangeRow: { flexDirection: "row" as const, gap: 4 },
      horizontalStrip: {
        flexGrow: 0,
        flexShrink: 1,
      },
      rangeButton: {
        minHeight: 44,
        minWidth: 48,
        paddingHorizontal: 10,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        borderRadius: 9,
      },
      rangeButtonActive: { backgroundColor: colors.surface2 },
      rangeText: { color: colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
      rangeTextActive: { color: colors.foreground },
      card: {
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 12,
        padding: layout.compact ? 12 : 14,
        gap: 10,
      },
      metricGrid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      metric: {
        minWidth: layout.compact ? 135 : 190,
        flexGrow: 1,
        flexBasis: 0,
        backgroundColor: colors.surface2,
        borderRadius: 10,
        padding: 11,
        gap: 4,
      },
      metricLabel: { color: colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const },
      metricValue: { color: colors.foreground, fontSize: 22, fontWeight: "700" as const },
      title: { color: colors.foreground, fontSize: 14, fontWeight: "700" as const },
      muted: { color: colors.foregroundMuted, fontSize: 12 },
      error: { color: colors.statusDanger, fontSize: 12 },
      heatmapRow: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 4 },
      week: { gap: 4 },
      cell: { width: 22, height: 22, borderRadius: 4, borderWidth: 1, borderColor: "transparent" },
      cellSelected: { borderColor: colors.foreground },
      dayDetail: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 12,
        paddingTop: 2,
      },
      modelCard: {
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 12,
        padding: 13,
        gap: 8,
      },
      modelTop: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      modelName: { color: colors.foreground, fontSize: 14, fontWeight: "700" as const, flex: 1 },
      share: { color: colors.accent, fontSize: 14, fontWeight: "800" as const },
      track: { height: 5, backgroundColor: colors.surface2, borderRadius: 999, overflow: "hidden" as const },
      fill: { height: 5, backgroundColor: colors.accent, borderRadius: 999 },
      statRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 16 },
      insight: {
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 12,
        padding: 14,
        gap: 5,
      },
      insightWarning: { borderColor: colors.statusWarning },
      insightKind: {
        color: colors.accent,
        fontSize: 10,
        fontWeight: "800" as const,
        textTransform: "uppercase" as const,
        letterSpacing: 1,
      },
      attributionList: { gap: 7 },
      attributionRow: {
        backgroundColor: colors.surface2,
        borderRadius: 9,
        padding: 10,
        gap: 6,
      },
      attributionTop: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      attributionName: { color: colors.foreground, fontSize: 12, fontWeight: "700" as const, flex: 1 },
      attributionChild: { marginLeft: layout.compact ? 8 : 14 },
      baseline: {
        color: colors.foregroundMuted,
        fontSize: 11,
        lineHeight: 16,
      },
    };
  }, [theme, layout.compact]);

  const heatmapWeeks = useMemo(() => calendarWeeks(analytics?.heatmap ?? []), [analytics?.heatmap]);
  const maxDayTokens = Math.max(0, ...(analytics?.heatmap ?? []).map((day) => day.modelTokens));
  const selectedDay =
    analytics?.heatmap.find((day) => day.date === selectedDate) ??
    [...(analytics?.heatmap ?? [])].reverse().find((day) => day.modelTokens > 0 || day.turns > 0) ??
    null;

  const rangeControl = (
    <View style={styles.rangeRow}>
      {(["7d", "30d", "all"] as const).map((value) => {
        const active = range === value;
        return (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityLabel={`Show ${value === "all" ? "all captured" : value} analytics`}
            onPress={() => setRange(value)}
            style={[styles.rangeButton, active ? styles.rangeButtonActive : null]}
          >
            <Text style={[styles.rangeText, active ? styles.rangeTextActive : null]}>
              {value === "all" ? "All" : value}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  if (!analytics) {
    return (
      <View style={styles.wrap}>
        <View style={styles.header}>{rangeControl}</View>
        <View style={styles.card}>
          <Text style={styles.title}>{loading ? "Loading captured telemetry…" : "No analytics yet"}</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      </View>
    );
  }

  if (section === "usage") {
    const summary = analytics.summary;
    return (
      <View style={styles.wrap}>
        <View style={styles.responsiveHeader}>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>Usage overview</Text>
            <Text style={styles.muted}>
              {analytics.capturedFrom ? `Captured since ${new Date(analytics.capturedFrom).toLocaleString()}` : "No captured usage yet"}
            </Text>
          </View>
          {rangeControl}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.metricGrid}>
          {[
            ["Runs", compactNumber(summary.runCount)],
            ["Agent turns", compactNumber(summary.turns)],
            ["Model tokens", compactNumber(summary.modelTokens)],
            ["Active days", compactNumber(summary.activeDays)],
            ["Peak hour", formatHour(summary.peakHour)],
            ["Top model", summary.favoriteModel ?? "-"],
          ].map(([label, value]) => (
            <View key={label} style={styles.metric}>
              <Text style={styles.metricLabel}>{label}</Text>
              <Text style={styles.metricValue} numberOfLines={1}>{value}</Text>
            </View>
          ))}
        </View>

        <View style={styles.card}>
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>Token activity</Text>
              <Text style={styles.muted}>Each cell is one local calendar day · intensity = model tokens</Text>
            </View>
            <Text style={styles.muted}>{loading ? "SYNC" : `${compactNumber(summary.cacheTokens)} cache`}</Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.horizontalStrip}>
            <View style={styles.heatmapRow}>
              {heatmapWeeks.map((week, weekIndex) => (
                <View key={weekIndex} style={styles.week}>
                  {week.map((day, dayIndex) => {
                    if (!day) return <View key={`empty-${dayIndex}`} style={styles.cell} />;
                    const intensity = maxDayTokens > 0 ? day.modelTokens / maxDayTokens : 0;
                    return (
                      <Pressable
                        key={day.date}
                        accessibilityRole="button"
                        accessibilityLabel={`${day.date}: ${day.modelTokens} model tokens, ${day.turns} turns`}
                        onPress={() => setSelectedDate(day.date)}
                        style={[
                          styles.cell,
                          {
                            backgroundColor: intensity > 0 ? theme.colors.accent : theme.colors.surface2,
                            opacity: intensity > 0 ? 0.25 + intensity * 0.75 : 1,
                          },
                          selectedDay?.date === day.date ? styles.cellSelected : null,
                        ]}
                      />
                    );
                  })}
                </View>
              ))}
            </View>
          </ScrollView>
          {selectedDay ? (
            <View style={styles.dayDetail}>
              <Text style={styles.title}>{selectedDay.date}</Text>
              <Text style={styles.muted}>{compactNumber(selectedDay.modelTokens)} model</Text>
              <Text style={styles.muted}>{compactNumber(selectedDay.cacheTokens)} cache</Text>
              <Text style={styles.muted}>{selectedDay.turns} turns</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.title}>Token mix</Text>
          <Text style={styles.muted}>Captured token classes only; unsupported backend dimensions are not reconstructed.</Text>
          <View style={styles.statRow}>
            <Text style={styles.muted}>Input {compactNumber(summary.usage.inputTokens)}</Text>
            <Text style={styles.muted}>Output {compactNumber(summary.usage.outputTokens)}</Text>
            <Text style={styles.muted}>Reasoning {compactNumber(summary.usage.reasoningTokens)}</Text>
            <Text style={styles.muted}>Cache {compactNumber(summary.cacheTokens)}</Text>
            <Text style={styles.muted}>Cost {money(summary.reportedCostUsd)}</Text>
          </View>
        </View>
      </View>
    );
  }

  if (section === "models") {
    return (
      <View style={styles.wrap}>
        <View style={styles.responsiveHeader}>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>Backends & models</Text>
            <Text style={styles.muted}>Captured usage grouped first by Paseo backend, then by model.</Text>
          </View>
          {rangeControl}
        </View>

        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Backends</Text>
            <Text style={styles.muted}>{analytics.backends.length} captured</Text>
          </View>
          {(analytics.backends ?? []).map((backend) => (
            <View key={backend.backend} style={styles.attributionRow}>
              <View style={styles.modelTop}>
                <Text style={styles.modelName}>{backendLabel(backend.backend)}</Text>
                <Text style={styles.share}>{Math.round(backend.share * 100)}%</Text>
              </View>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${Math.max(2, Math.round(backend.share * 100))}%` as `${number}%` }]} />
              </View>
              <View style={styles.statRow}>
                <Text style={styles.muted}>{backend.runCount} runs</Text>
                <Text style={styles.muted}>{compactNumber(backend.modelTokens)} model</Text>
                <Text style={styles.muted}>{compactNumber(backend.cacheTokens)} cache</Text>
                <Text style={styles.muted}>{money(backend.usage.reportedCostUsd)}</Text>
              </View>
            </View>
          ))}
          {analytics.backends.length === 0 ? <Text style={styles.muted}>No backend usage captured in this range.</Text> : null}
        </View>

        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Models</Text>
            <Text style={styles.muted}>Attribution is by Paseo run model for captured usage.</Text>
          </View>
        </View>
        <ModelUsageList theme={theme} layout={layout} models={analytics.models ?? []} />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.responsiveHeader}>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Insights</Text>
          <Text style={styles.muted}>Deterministic signals from aggregate telemetry; no prompt or response content is read.</Text>
        </View>
        {rangeControl}
      </View>

      <View style={styles.card}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Cache attribution</Text>
            <Text style={styles.muted}>Top captured cache sources; session data stores counters and topology only.</Text>
          </View>
          <Text style={styles.muted}>{compactNumber(analytics.summary.cacheTokens)} total cache</Text>
        </View>

        <View style={styles.statRow}>
          {analytics.cacheAttribution.projects[0] ? (
            <Text style={styles.muted}>
              Top project {analytics.cacheAttribution.projects[0].projectName} · {Math.round(analytics.cacheAttribution.projects[0].cacheShare * 100)}%
            </Text>
          ) : null}
          {analytics.cacheAttribution.runs[0] ? (
            <Text style={styles.muted}>
              Top run {analytics.cacheAttribution.runs[0].workspaceName ?? analytics.cacheAttribution.runs[0].runId?.slice(0, 7)} · {Math.round(analytics.cacheAttribution.runs[0].cacheShare * 100)}%
            </Text>
          ) : null}
        </View>

        <View style={styles.attributionList}>
          {analytics.cacheAttribution.groups.map((group) => {
            const expanded = expandedGroupKeys.has(group.key);
            const name = group.entityType === "subagent"
              ? `subagent · ${group.role ?? "session"}`
              : group.role ?? "root";
            const width = `${Math.max(2, Math.round(group.cacheShare * 100))}%` as `${number}%`;
            return (
              <View key={group.key}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  accessibilityLabel={`${name}, ${group.sessionCount} sessions. ${expanded ? "Hide" : "Show"} session details`}
                  onPress={() => toggleCacheGroup(group.key)}
                  style={styles.attributionRow}
                >
                  <View style={styles.attributionTop}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.attributionName} numberOfLines={1}>{name}</Text>
                      <Text style={styles.muted} numberOfLines={1}>
                        {group.projectName} · {group.model ?? "unknown model"} · {group.sessionCount} sessions
                      </Text>
                    </View>
                    <Text style={styles.share}>{Math.round(group.cacheShare * 100)}%</Text>
                  </View>
                  <View style={styles.track}><View style={[styles.fill, { width }]} /></View>
                  <View style={styles.statRow}>
                    <Text style={styles.muted}>{compactNumber(group.cacheTokens)} cache</Text>
                    <Text style={styles.muted}>{compactNumber(group.modelTokens)} model</Text>
                    <Text style={styles.muted}>{ratioLabel(group.cacheRatio)} cache/model</Text>
                  </View>
                </Pressable>
                {expanded && group.sessionCount > group.sessions.length ? (
                  <Text style={styles.muted}>
                    Showing top {group.sessions.length} of {group.sessionCount} sessions by cache usage
                  </Text>
                ) : null}
                {expanded
                  ? group.sessions.map((session) => {
                      const childName = `${session.runId?.slice(0, 7) ?? "unknown"} · ${session.sessionId?.slice(0, 7) ?? "unknown"}`;
                      const childWidth = `${Math.max(2, Math.round(session.cacheShare * 100))}%` as `${number}%`;
                      return (
                        <View key={`${session.runId}:${session.sessionId}`} style={[styles.attributionRow, styles.attributionChild]}>
                          <View style={styles.attributionTop}>
                            <Text style={styles.attributionName} numberOfLines={1}>{childName}</Text>
                            <Text style={styles.share}>{Math.round(session.cacheShare * 100)}%</Text>
                          </View>
                          <View style={styles.track}><View style={[styles.fill, { width: childWidth }]} /></View>
                          <View style={styles.statRow}>
                            <Text style={styles.muted}>{compactNumber(session.cacheTokens)} cache</Text>
                            <Text style={styles.muted}>{compactNumber(session.modelTokens)} model</Text>
                            <Text style={styles.muted}>{ratioLabel(session.cacheRatio)} cache/model</Text>
                          </View>
                        </View>
                      );
                    })
                  : null}
              </View>
            );
          })}
          {analytics.cacheAttribution.groups.length === 0 ? (
            <Text style={styles.muted}>Session-level attribution starts after Observatory captures two usage states for the same runtime generation.</Text>
          ) : null}
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Run & subagent anomalies</Text>
            <Text style={styles.muted}>Hourly spikes are compared only with the entity's own prior active-hour baseline.</Text>
          </View>
          <Text style={styles.muted}>{analytics.anomalies.length} detected</Text>
        </View>
        <Text style={styles.baseline}>
          Baseline requires {analytics.baseline.requiredActiveHours} prior active hours · runs: {analytics.baseline.runs.evaluated} ready / {analytics.baseline.runs.insufficient} warming · subagents: {analytics.baseline.subagents.evaluated} ready / {analytics.baseline.subagents.insufficient} warming
        </Text>
        {analytics.anomalies.map((anomaly) => (
          <View key={anomaly.id} style={[styles.insight, anomaly.severity === "warning" ? styles.insightWarning : null]}>
            <Text style={styles.insightKind}>{anomaly.entityType} · {anomaly.metric.replace("_", " ")}</Text>
            <Text style={styles.title}>{anomaly.title}</Text>
            <Text style={styles.muted}>{anomaly.detail}</Text>
            <Text style={styles.muted}>
              {anomaly.projectName ? `${anomaly.projectName} · ` : ""}
              current {compactNumber(anomaly.current)} · baseline {compactNumber(anomaly.baselineMedian)}
            </Text>
          </View>
        ))}
        {analytics.anomalies.length === 0 ? (
          <Text style={styles.muted}>No baseline-qualified spikes detected in this range.</Text>
        ) : null}
      </View>

      {analytics.insights.map((insight) => (
        <View key={insight.id} style={[styles.insight, insight.severity === "warning" ? styles.insightWarning : null]}>
          <Text style={styles.insightKind}>{insight.kind}</Text>
          <Text style={styles.title}>{insight.title}</Text>
          <Text style={styles.muted}>{insight.detail}</Text>
        </View>
      ))}
      {analytics.insights.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.title}>No material aggregate signals</Text>
          <Text style={styles.muted}>Observatory has not detected a deterministic cache, output, reasoning, cost, or model-concentration signal in this range.</Text>
        </View>
      ) : null}
    </View>
  );
}
