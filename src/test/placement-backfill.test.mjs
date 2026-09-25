import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ObservatoryPluginService } from "../../server/observatory-service.mjs";
import { ObservatoryStorage } from "../../server/storage/sqlite.mjs";

function emptyPage(entries) {
  return { entries, pageInfo: { nextCursor: null } };
}

test("overview bootstraps archived Paseo agents with project placement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-placement-"));
  const storage = new ObservatoryStorage({ databasePath: join(directory, "observatory.sqlite") });
  const service = new ObservatoryPluginService({ storage });
  const agentRequests = [];

  const paseo = {
    agents: {
      list: async (options) => {
        agentRequests.push(options);
        return emptyPage([
          {
            agent: {
              id: "run_archived",
              workspaceId: "wks_archived",
              provider: "opencode",
              status: "closed",
              archivedAt: "2026-09-01T12:00:00.000Z",
              updatedAt: "2026-09-01T12:00:00.000Z",
              persistence: { provider: "opencode" },
            },
            project: {
              projectName: "poly_rich",
              workspaceName: "Old experiment",
            },
          },
        ]);
      },
    },
    workspaces: {
      list: async () => emptyPage([]),
    },
  };

  try {
    const overview = await service.overview(paseo);
    assert.equal(agentRequests[0]?.filter?.includeArchived, true);
    assert.equal(overview.workspaceCount, 1);
    assert.equal(overview.workspaces[0]?.name, "poly_rich");
    assert.equal(overview.workspaces[0]?.runs[0]?.workspaceName, "Old experiment");
    assert.equal(storage.listRuns()[0]?.projectName, "poly_rich");
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("overview backfills stored runs by workspace id when the agent is no longer listed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-placement-"));
  const storage = new ObservatoryStorage({ databasePath: join(directory, "observatory.sqlite") });
  storage.upsertRun(
    {
      id: "run_legacy",
      workspaceId: "wks_legacy",
      provider: "opencode",
      model: "qwen3.8-flash",
      status: "historical",
      rootSessionId: null,
    },
    "2026-09-01T12:00:00.000Z",
  );
  const service = new ObservatoryPluginService({ storage });

  const paseo = {
    agents: {
      list: async () => emptyPage([]),
    },
    workspaces: {
      list: async () =>
        emptyPage([
          {
            id: "wks_legacy",
            title: "Legacy workspace",
            projectDisplayName: "receipt-scanner",
            project: {
              projectName: "receipt-scanner",
              workspaceName: "Legacy workspace",
            },
          },
        ]),
    },
  };

  try {
    const overview = await service.overview(paseo);
    assert.equal(overview.workspaces[0]?.name, "receipt-scanner");
    assert.equal(overview.workspaces[0]?.runs[0]?.workspaceName, "Legacy workspace");
    const stored = storage.listRuns()[0];
    assert.equal(stored.projectName, "receipt-scanner");
    assert.equal(stored.workspaceName, "Legacy workspace");
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("overview prunes transient session-open rows that never became Paseo agents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-placement-"));
  const storage = new ObservatoryStorage({ databasePath: join(directory, "observatory.sqlite") });
  const service = new ObservatoryPluginService({ storage });
  const paseo = {
    agents: { list: async () => emptyPage([]) },
    workspaces: { list: async () => emptyPage([]) },
  };

  try {
    service.onSessionOpen(
      { agentId: "transient", workspaceId: null, provider: "opencode", reason: "resume" },
      paseo,
    );
    assert.equal(storage.hasRun("transient"), false);

    storage.upsertRun(
      {
        id: "old_transient",
        workspaceId: null,
        provider: "opencode",
        model: null,
        status: "session_open",
        rootSessionId: null,
      },
      "2026-09-01T12:00:00.000Z",
    );
    storage.recordEvents("old_transient", [
      {
        source: "paseo",
        type: "agent.session_open",
        observedAt: "2026-09-01T12:00:00.000Z",
      },
    ]);

    const overview = await service.overview(paseo);
    assert.equal(overview.runCount, 0);
    assert.equal(storage.hasRun("old_transient"), false);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
