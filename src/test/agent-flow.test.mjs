import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentFlow } from "../../server/agent-flow.mjs";

test("agent flow preserves parent topology and attributes cumulative usage per session", () => {
  const sessions = [
    {
      id: "root",
      parentID: null,
      agent: "orchestrator",
      model: { providerID: "provider", id: "root-model" },
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 400, write: 20 } },
      cost: 0.1,
      time: { created: 1000, updated: 4000 },
    },
    {
      id: "child",
      parentID: "root",
      title: "Investigate tests",
      agent: "coder",
      model: { providerID: "provider", id: "child-model" },
      tokens: { input: 10, output: 30, reasoning: 0, cache: { read: 40, write: 5 } },
      cost: 0.02,
      time: { created: 2000, updated: 3000 },
    },
    {
      id: "grandchild",
      parentID: "child",
      agent: "researcher",
      tokens: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      time: { created: 2500, updated: 2600 },
    },
  ];
  const runtimes = [{ statuses: { root: { type: "busy" }, child: { type: "idle" } } }];

  const flow = buildAgentFlow(sessions, "root", runtimes);

  assert.equal(flow.rootId, "root");
  assert.equal(flow.nodes.length, 3);
  assert.equal(flow.totalModelTokens, 210);
  assert.equal(flow.totalObservedTokens, 675);

  const root = flow.nodes.find((node) => node.id === "root");
  const child = flow.nodes.find((node) => node.id === "child");
  const grandchild = flow.nodes.find((node) => node.id === "grandchild");

  assert.equal(root.depth, 0);
  assert.equal(root.status, "busy");
  assert.equal(root.model, "provider/root-model");
  assert.equal(root.modelTokens, 160);
  assert.equal(child.parentId, "root");
  assert.equal(child.depth, 1);
  assert.equal(child.title, "Investigate tests");
  assert.equal(child.status, "idle");
  assert.equal(child.modelTokens, 40);
  assert.equal(grandchild.depth, 2);
  assert.equal(grandchild.status, "inactive");
  assert.equal(grandchild.modelTokens, 10);
  assert.equal(child.modelTokenShare, 40 / 210);
});
