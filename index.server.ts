import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  observatoryAnalyticsRpc,
  observatoryOverviewRpc,
  observatorySnapshotRpc,
  observatoryTimelineRpc,
} from "./shared/observatory";
// The collector is shared with the standalone Observatory and intentionally remains plain ESM.
// @ts-expect-error TypeScript has no declaration file for the shared .mjs service.
import { ObservatoryPluginService } from "./server/observatory-service.mjs";

export default function contribute(server: PluginServerContext) {
  const service = new ObservatoryPluginService();
  const cleanups: Array<() => void> = [];

  server.handle(observatoryAnalyticsRpc, (input) => service.analytics(input.range));
  server.handle(observatoryOverviewRpc, (_input, { paseo }) => service.overview(paseo));
  server.handle(observatorySnapshotRpc, (input, { paseo }) => service.collect(paseo, input.runId));
  server.handle(observatoryTimelineRpc, (input) => service.timeline(input.runId, input.limit));

  for (const name of [
    "agent.created",
    "agent.turn_started",
    "agent.turn_ended",
    "agent.permission_requested",
    "agent.permission_resolved",
    "agent.archived",
  ] as const) {
    cleanups.push(
      server.on(name, (event, { paseo, signal }) => {
        return service.onLifecycle(name, event, paseo, signal);
      }),
    );
  }

  cleanups.push(
    server.before("agent.session_open", ({ request }, { paseo }) => {
      service.onSessionOpen(request, paseo);
    }),
  );

  return async () => {
    for (const cleanup of cleanups) cleanup();
    await service.close();
  };
}
