import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentFlow } from "../../server/agent-flow.mjs";

test("agent flow preserves parent topology and attributes cumulative usage per session", () => {
  const sessions = [
    {
      id: "root",
      parentId: null,
      role: "orchestrator",
      model: "provider/root-model",
      status: "busy",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 10,
        cacheReadTokens: 400,
        cacheWriteTokens: 20,
        reportedCostUsd: 0.1,
      },
      createdAt: "1970-01-01T00:00:01.000Z",
      updatedAt: "1970-01-01T00:00:04.000Z",
    },
    {
      id: "child",
      parentId: "root",
      title: "Investigate tests",
      role: "coder",
      model: "provider/child-model",
      status: "idle",
      usage: {
        inputTokens: 10,
        outputTokens: 30,
        reasoningTokens: 0,
        cacheReadTokens: 40,
        cacheWriteTokens: 5,
        reportedCostUsd: 0.02,
      },
      createdAt: "1970-01-01T00:00:02.000Z",
      updatedAt: "1970-01-01T00:00:03.000Z",
    },
    {
      id: "grandchild",
      parentId: "child",
      role: "researcher",
      status: "inactive",
      usage: {
        inputTokens: 5,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedCostUsd: 0,
      },
      createdAt: "1970-01-01T00:00:02.500Z",
      updatedAt: "1970-01-01T00:00:02.600Z",
    },
  ];

  const flow = buildAgentFlow(sessions, "root");

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
