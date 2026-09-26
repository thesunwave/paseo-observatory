import { backendCapabilities } from "../contract.mjs";
import { PaseoProviderBackendAdapter, normalizePaseoTurnUsage } from "../paseo/adapter.mjs";

export { normalizePaseoTurnUsage } from "../paseo/adapter.mjs";

export class ClaudeBackendAdapter extends PaseoProviderBackendAdapter {
  constructor() {
    super({
      providerId: "claude",
      displayName: "Claude Code",
      capabilities: backendCapabilities({
        tokenUsage: true,
        cacheUsage: true,
        cacheReadUsage: true,
        cacheWriteUsage: false,
        cost: true,
      }),
    });
  }

  async observe({ agent }) {
    const observation = await super.observe({ agent });
    return {
      ...observation,
      gaps: [
        "Claude Code runtime/process telemetry is not exposed through this adapter.",
        "Nested Claude provider sessions are not yet projected into the Observatory flow.",
        "Usage is reported per completed Paseo turn; reasoning and cache-write tokens are unavailable.",
      ],
    };
  }
}
