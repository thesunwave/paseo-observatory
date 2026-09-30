import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  directChildRuns,
  planInspectNavigation,
  resolveRunGroup,
  runtimeOwnershipLabel,
  summarizeRunLineage,
} from "../../client/orchestration-tree.mjs";

const root = new URL("../../", import.meta.url);

function run(id, extra = {}) {
  return {
    id,
    shortId: id.slice(0, 7),
    title: null,
    workspaceName: "ws",
    projectName: null,
    workspaceId: "ws-1",
    provider: "opencode",
    model: null,
    status: "running",
    lastActivityAt: "2026-09-30T10:00:00.000Z",
    historical: false,
    ...extra,
  };
}

test("run lineage without captured provenance stays unavailable and never infers a parent", () => {
  const absent = summarizeRunLineage(run("run-a"), []);
  assert.equal(absent.state, "unavailable");
  assert.equal(absent.reason, "relationship_unproven");

  const unknown = summarizeRunLineage(
    run("run-a", { parentRunId: "run-b", parentProvenance: "unknown" }),
    [run("run-b")],
  );
  assert.equal(unknown.state, "unavailable");
  assert.equal(unknown.parent, null);
});

test("hook provenance with a null parent is an evidenced top-level run", () => {
  const result = summarizeRunLineage(run("run-a", { parentRunId: null, parentProvenance: "hook" }), []);
  assert.equal(result.state, "top-level");
  assert.equal(result.parent, null);
  assert.equal(result.unresolvedParentId, null);
});

test("hook provenance without a parentRunId value is unavailable, not attested top level", () => {
  const omitted = summarizeRunLineage(run("run-a", { parentProvenance: "hook" }), []);
  assert.equal(omitted.state, "unavailable");
  assert.equal(omitted.reason, "parent_id_missing");

  const explicitUndefined = summarizeRunLineage(
    run("run-a", { parentRunId: undefined, parentProvenance: "hook" }),
    [],
  );
  assert.equal(explicitUndefined.state, "unavailable");
  assert.equal(explicitUndefined.reason, "parent_id_missing");

  const nullResult = summarizeRunLineage(run("run-a", { parentRunId: null, parentProvenance: "hook" }), []);
  assert.equal(nullResult.state, "top-level");
});

test("hook provenance resolves an evidenced parent only from available runs", () => {
  const parent = run("run-parent", { title: "Parent run" });
  const child = run("run-child", { parentRunId: "run-parent", parentProvenance: "hook" });

  const found = summarizeRunLineage(child, [child, parent]);
  assert.equal(found.state, "parent");
  assert.equal(found.parent?.id, "run-parent");
  assert.equal(found.unresolvedParentId, null);

  const missing = summarizeRunLineage(child, [child]);
  assert.equal(missing.state, "parent");
  assert.equal(missing.parent, null);
  assert.equal(missing.unresolvedParentId, "run-parent");
});

test("self-parent evidence is rejected instead of rendered as a relationship", () => {
  const result = summarizeRunLineage(
    run("run-a", { parentRunId: "run-a", parentProvenance: "hook" }),
    [run("run-a")],
  );
  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "self_parent_rejected");
});

test("direct children require hook provenance and are cycle and duplicate safe", () => {
  const parent = run("run-parent", { parentProvenance: "hook", parentRunId: "run-child" });
  const child = run("run-child", { parentRunId: "run-parent", parentProvenance: "hook" });
  const guessed = run("run-guessed", { parentRunId: "run-parent", parentProvenance: "unknown" });
  const crossWorkspace = run("run-cross", {
    parentRunId: "run-parent",
    parentProvenance: "hook",
    workspaceId: "ws-2",
    workspaceName: "other",
    lastActivityAt: "2026-09-30T12:00:00.000Z",
  });
  const runs = [parent, child, guessed, crossWorkspace, crossWorkspace];

  assert.deepEqual(
    directChildRuns(parent, runs).map((entry) => entry.id),
    ["run-cross", "run-child"],
  );
  assert.deepEqual(directChildRuns(child, runs).map((entry) => entry.id), ["run-parent"]);
  assert.deepEqual(directChildRuns(null, runs), []);
});

test("runtime ownership labels are explicit, and unassigned stays distinct from absent", () => {
  assert.deepEqual(runtimeOwnershipLabel({ ownership: "proven" }), {
    label: "associated",
    tone: "proven",
  });
  assert.deepEqual(runtimeOwnershipLabel({ ownership: "candidate" }), {
    label: "ownership unproven",
    tone: "unproven",
  });
  assert.deepEqual(runtimeOwnershipLabel({ ownership: "unassigned" }), {
    label: "unassigned",
    tone: "unassigned",
  });
  assert.deepEqual(runtimeOwnershipLabel({}), {
    label: "ownership unavailable",
    tone: "unavailable",
  });
  assert.deepEqual(runtimeOwnershipLabel(null), {
    label: "ownership unavailable",
    tone: "unavailable",
  });
});

test("resolveRunGroup matches overview groups by membership or projectName, never raw workspaceId", () => {
  const rawIdCollision = { id: "ws-raw-9", name: "ws-raw-9", runs: [{ id: "other-run" }] };
  const target = run("run-child", {
    projectName: "observatory",
    workspaceId: "ws-raw-9",
  });
  const memberGroup = { id: "observatory", name: "observatory", runs: [{ id: "run-child" }] };
  const namedOnlyGroup = { id: "observatory", name: "observatory", runs: [{ id: "run-sibling" }] };
  const otherGroup = { id: "other", name: "other", runs: [{ id: "run-x" }] };

  const byMember = resolveRunGroup(target, [rawIdCollision, otherGroup, memberGroup]);
  assert.equal(byMember.group?.id, "observatory");
  assert.equal(byMember.basis, "run_membership");

  const byName = resolveRunGroup(target, [rawIdCollision, otherGroup, namedOnlyGroup]);
  assert.equal(byName.group?.id, "observatory");
  assert.equal(byName.basis, "project_name_match");

  const unresolved = resolveRunGroup(target, [otherGroup]);
  assert.equal(unresolved.group, null);
  assert.equal(unresolved.basis, "unmatched");

  assert.equal(resolveRunGroup(null, [memberGroup]).basis, "no_target");
});


test("observatory keeps Paseo orchestration distinct from the backend agent flow", async () => {
  const live = await readFile(new URL("client/observatory.tsx", root), "utf8");

  const orchestrationAt = live.indexOf("Paseo orchestration");
  assert.ok(orchestrationAt > -1, "Paseo orchestration section exists");

  // The orchestration card prose says "...stay in Agent flow below." well above
  // the real heading, so existence must be anchored to the sectionTitle heading
  // itself. A naive live.indexOf("Agent flow") matches that prose and keeps
  // passing even after the section is deleted (a false positive).
  const agentFlowHeading = /<Text style=\{styles\.sectionTitle\}>Agent flow<\/Text>/;
  const headingAt = live.search(agentFlowHeading);
  assert.ok(headingAt > -1, "backend Agent flow section heading is preserved");
  assert.ok(headingAt > orchestrationAt, "Agent flow heading renders below the orchestration card");
  const proseAt = live.indexOf("Agent flow below");
  assert.ok(proseAt > -1, "orchestration card still points to Agent flow below");
  assert.ok(proseAt < headingAt, "heading anchor is distinct from the earlier prose mention");

  const card = live.slice(orchestrationAt, live.indexOf("Backend coverage", orchestrationAt));
  const helperAt = live.indexOf("const renderRunSummary");
  const helper = live.slice(helperAt, live.indexOf("return (\n    <ScrollView"));
  assert.ok(helperAt > -1 && helper.length > 0, "lineage renderers exist");
  assert.match(helper, /Inspect parent run/);
  assert.match(card, /renderParentLineage\(\)/);
  assert.match(card, /Inspect child run/);
  assert.doesNotMatch(helper + card, /compactNumber|money\(|\.usage|runtime\.pid/);

  assert.match(live, /resolveRunGroup\(target, overview\?\.workspaces \?\? \[\]\)/);
  assert.match(live, /planInspectNavigation\(target, resolution\)/);
  assert.match(live, /if \(plan\.mode === "bail"\)\s*\{\s*returnToOverview\(\);/);
  assert.doesNotMatch(
    live,
    /if \(resolution\.group\) setSelectedWorkspaceId\(resolution\.group\.id\)/,
    "no stale workspace breadcrumb is kept when the target group is unresolved",
  );
  assert.doesNotMatch(live, /workspace\.id === target\.workspaceId/);
});

test("inspecting an ungrouped run bails to the overview instead of keeping a stale breadcrumb", () => {
  const target = run("run-orphan", { projectName: "gone" });

  // Unmatched group: the previously selected workspace must not survive and the
  // target must not be selected under the wrong context.
  const unmatched = planInspectNavigation(target, { group: null });
  assert.equal(unmatched.mode, "bail");
  assert.equal(unmatched.workspaceId, null, "stale workspace breadcrumb is cleared");
  assert.equal(unmatched.runId, undefined, "target is not opened under an unresolved workspace");
  assert.equal(unmatched.timelineVisible, false);

  // Resolved group: open the target inside its own workspace.
  const matched = planInspectNavigation(target, { group: { id: "observatory" } });
  assert.equal(matched.mode, "open");
  assert.equal(matched.workspaceId, "observatory");
  assert.equal(matched.runId, "run-orphan");
  assert.equal(matched.timelineVisible, false);
});

test("historical parent and child summaries are listed without promising live navigation", async () => {
  const live = await readFile(new URL("client/observatory.tsx", root), "utf8");
  const helper = live.slice(live.indexOf("const renderRunSummary"), live.indexOf("return (\n    <ScrollView"));
  const card = live.slice(live.indexOf("Paseo orchestration"), live.indexOf("Backend coverage"));

  assert.match(helper, /parent\.historical/);
  assert.match(helper, /historical parent summary/);
  assert.match(card, /child\.historical/);
  assert.match(card, /historical child summary/);
});

test("child evidence is labeled as observation, not a total, and workspace scope is announced", async () => {
  const live = await readFile(new URL("client/observatory.tsx", root), "utf8");
  const card = live.slice(live.indexOf("Paseo orchestration"), live.indexOf("Backend coverage"));

  assert.match(card, /OBSERVED CHILDREN/);
  assert.doesNotMatch(card, /DIRECT CHILDREN/);
  assert.match(card, /No hook-evidenced child runs currently available/);
  assert.doesNotMatch(card, /lineage\.state === "unavailable"/);
  assert.match(card, /resolveRunGroup\(child, overview\?\.workspaces \?\? \[\]\)/);
  assert.match(card, /childGroup\.group\.id !== selectedWorkspaceId/);
  assert.match(card, /Inspect child run \$\{childLabel\} in workspace \$\{groupName\}/);
  assert.match(card, /workspace group unresolved/);
  assert.doesNotMatch(card, /child\.workspaceId === selectedWorkspaceId|workspaceId !== selectedWorkspaceId/);
});

test("runtime instances keep generation identity and label run association neutrally", async () => {
  const live = await readFile(new URL("client/observatory.tsx", root), "utf8");
  const card = live.slice(live.indexOf("Runtime instances"), live.indexOf("Persistent telemetry"));

  assert.match(card, /Discovered candidates and proven run associations/);
  assert.match(card, /shortGeneration\(runtime\.generationKey\)/);
  assert.match(card, /styles\.ownershipLabel\}>\{ownership\.label\}/);
  assert.doesNotMatch(card, /ownership\.tone[\s\S]{0,160}styles\.(success|warning)/);
  assert.match(
    card,
    /ownership\.tone === "proven"\s+\?\s+`\$\{runtime\.ownedSessionCount\} backend sessions`/,
  );
  assert.match(card, /sessions unattributed · \$\{ownership\.label\}/);
  assert.match(card, /model attribution unavailable/);
});

test("runtime ownership keeps distinct unassigned and absent labels", async () => {
  const live = await readFile(new URL("client/orchestration-tree.mjs", root), "utf8");

  assert.match(live, /case "unassigned":\s+return \{ label: "unassigned", tone: "unassigned" \}/);
  assert.match(live, /return \{ label: "ownership unavailable", tone: "unavailable" \}/);
  assert.match(live, /return \{ label: "ownership unproven", tone: "unproven" \}/);
});

test("hook parent without an id never renders as attested top level", async () => {
  const live = await readFile(new URL("client/observatory.tsx", root), "utf8");

  assert.match(live, /parent_id_missing/);
  assert.match(live, /Hook provenance arrived without a parent run id/);
});


