import type { PluginServerContext } from "@getpaseo/plugin/server";
import { observatorySnapshotRpc, observatoryTimelineRpc } from "./shared/observatory";
// The collector is shared with the standalone Observatory and intentionally remains plain ESM.
// @ts-expect-error TypeScript has no declaration file for the shared .mjs service.
import { ObservatoryPluginService } from "./server/observatory-service.mjs";

export default function contribute(server: PluginServerContext) {
  const service = new ObservatoryPluginService();
  const cleanups: Array<() => void> = [];

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
      server.on(name, (event, { paseo }) => {
        service.onLifecycle(name, event, paseo);
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
