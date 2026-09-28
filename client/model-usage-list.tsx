import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { ObservatoryAnalytics } from "../shared/observatory";

type ModelUsage = ObservatoryAnalytics["models"][number];

function compactNumber(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function money(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function ModelUsageList({
  theme,
  layout,
  models,
  emptyText = "No model usage captured in this range.",
}: {
  theme: PluginSurfaceProps["theme"];
  layout: PluginSurfaceProps["layout"];
  models: ModelUsage[];
  emptyText?: string;
}) {
  const styles = useMemo(() => {
    const colors = theme.colors;
    return {
      wrap: { gap: layout.compact ? 8 : 10 },
      modelCard: {
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 12,
        padding: layout.compact ? 12 : 13,
        gap: 8,
      },
      modelTop: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      modelName: {
        color: colors.foreground,
        fontSize: 14,
        fontWeight: "700" as const,
        flex: 1,
      },
      share: {
        color: colors.accent,
        fontSize: 14,
        fontWeight: "800" as const,
      },
      track: {
        height: 5,
        backgroundColor: colors.surface2,
        borderRadius: 999,
        overflow: "hidden" as const,
      },
      fill: {
        height: 5,
        backgroundColor: colors.accent,
        borderRadius: 999,
      },
      statRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 16,
      },
      muted: { color: colors.foregroundMuted, fontSize: 12 },
    };
  }, [theme, layout.compact]);

  if (models.length === 0) return <Text style={styles.muted}>{emptyText}</Text>;

  return (
    <View style={styles.wrap}>
      {models.map((model) => (
        <View key={model.model} style={styles.modelCard}>
          <View style={styles.modelTop}>
            <Text style={styles.modelName}>{model.model}</Text>
            <Text style={styles.share}>{Math.round(model.share * 100)}%</Text>
          </View>
          <View style={styles.track}>
            <View
              style={[
                styles.fill,
                { width: `${Math.max(2, Math.round(model.share * 100))}%` as `${number}%` },
              ]}
            />
          </View>
          <View style={styles.statRow}>
            <Text style={styles.muted}>{model.runCount} runs</Text>
            <Text style={styles.muted}>{compactNumber(model.modelTokens)} model</Text>
            <Text style={styles.muted}>{compactNumber(model.cacheTokens)} cache</Text>
            <Text style={styles.muted}>{money(model.usage.reportedCostUsd)}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}
