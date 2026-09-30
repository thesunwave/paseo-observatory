import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Compiler fixture for the declaration-only contract on the orchestration-tree
// and runtime-layout helpers. The .mjs implementations accept a minimal
// id/lineage/project or ownership-only object and preserve the caller's richer
// type on return; these type-level properties cannot be exercised at runtime,
// so we run the real `tsc` over a generated snippet and require exit 0. Every
// "reject wrong type" line is guarded by `@ts-expect-error`, which fails the
// compile if the bad call were ever accepted. No `any`, no `@ts-ignore`.

const root = new URL("../../", import.meta.url);
const require = createRequire(import.meta.url);
let tscPath;
try {
  tscPath = require.resolve("typescript/bin/tsc");
} catch {
  tscPath = fileURLToPath(new URL("node_modules/typescript/bin/tsc", root));
}

const FIXTURE = [
  `import {`,
  `  directChildRuns,`,
  `  planInspectNavigation,`,
  `  resolveRunGroup,`,
  `  runtimeOwnershipLabel,`,
  `  summarizeRunLineage,`,
  `} from "../../client/orchestration-tree.mjs";`,
  `import { runtimeHeadline } from "../../client/runtime-layout.mjs";`,
  ``,
  `// --- Minimal valid INPUTS are accepted (the JS only reads these fields). ---`,
  `const minimalRun = { id: "run-a" };`,
  `const lineage = summarizeRunLineage(`,
  `  { id: "run-a", parentRunId: null, parentProvenance: "hook" },`,
  `  [{ id: "run-b" }, { id: "run-a" }],`,
  `);`,
  `const navigation = planInspectNavigation(minimalRun, { group: { id: "group-1" } });`,
  `const ownership = runtimeOwnershipLabel({});`,
  `const headline = runtimeHeadline({ pid: 5272 });`,
  ``,
  `// --- Generic RETURN preservation: full summaries keep every rendered field. ---`,
  `const richParent = { id: "run-b", title: "Beta", historical: false, lastActivityAt: null };`,
  `const preservedParent = summarizeRunLineage(`,
  `  { id: "run-a", parentRunId: "run-b", parentProvenance: "hook" },`,
  `  [richParent],`,
  `).parent;`,
  `const parentTitle: string | null = preservedParent?.title ?? null;`,
  `const parentHistorical: boolean = preservedParent?.historical === true;`,
  `const childTitle: string | null = directChildRuns({ id: "run-a" }, [richParent])[0]?.title ?? null;`,
  `const richGroup = { id: "g", name: "g", runCount: 3, runs: [{ id: "run-a" }] };`,
  `const groupRunCount: number =`,
  `  resolveRunGroup({ id: "run-a", projectName: "p" }, [richGroup]).group?.runCount ?? 0;`,
  `const navigationBail: boolean = planInspectNavigation(minimalRun, { group: null }).runId === undefined;`,
  ``,
  `export const evidence = {`,
  `  state: lineage.state,`,
  `  mode: navigation.mode,`,
  `  workspace: navigation.workspaceId,`,
  `  label: ownership.label,`,
  `  headline,`,
  `  parentTitle,`,
  `  parentHistorical,`,
  `  childTitle,`,
  `  groupRunCount,`,
  `  navigationBail,`,
  `};`,
  ``,
  `// --- Wrong types are REJECTED; an accepted bad call turns the directive into an error. ---`,
  `// @ts-expect-error RunLineage requires a string id.`,
  `summarizeRunLineage({}, []);`,
  `// @ts-expect-error parentProvenance is a closed union, not an arbitrary string.`,
  `summarizeRunLineage({ id: "run-a", parentProvenance: "guessed" }, []);`,
  `// @ts-expect-error a bare string is not a run.`,
  `directChildRuns("run-a", [{ id: "run-b" }]);`,
  `// @ts-expect-error availableRuns elements require an id.`,
  `directChildRuns({ id: "run-a" }, [{ lastActivityAt: null }]);`,
  `// @ts-expect-error resolveRunGroup target requires an id.`,
  `resolveRunGroup({ projectName: "p" }, []);`,
  `// @ts-expect-error an overview group requires an id.`,
  `resolveRunGroup({ id: "run-a" }, [{ name: "g" }]);`,
  `// @ts-expect-error a runtime pid cannot be a string.`,
  `runtimeHeadline({ pid: "5272" });`,
  `// @ts-expect-error ownership is a closed union, not an arbitrary string.`,
  `runtimeOwnershipLabel({ ownership: "definitely" });`,
  ``,
].join("\n");

// A deliberately weakened copy: one guard now precedes a VALID call, so its
// `@ts-expect-error` becomes unused. The harness must fail on this, proving the
// rejection assertions are real and not a vacuous always-green compile.
const BROKEN = FIXTURE.replace(
  `// @ts-expect-error a runtime pid cannot be a string.\nruntimeHeadline({ pid: "5272" });`,
  `// @ts-expect-error a runtime pid cannot be a string.\nruntimeHeadline({ pid: 5272 });`,
);

async function typecheck(t, source) {
  const base = `.orchestration-types.${process.pid}.${t}`;
  const fixturePath = new URL(`src/test/${base}.ts`, root);
  const projectPath = new URL(`src/test/${base}.tsconfig.json`, root);
  const config = {
    extends: "../../tsconfig.json",
    compilerOptions: { noEmit: true, types: [] },
    files: [`${base}.ts`],
  };
  await writeFile(fixturePath, source, "utf8");
  await writeFile(projectPath, JSON.stringify(config, null, 2), "utf8");
  try {
    execFileSync(process.execPath, [tscPath, "-p", fileURLToPath(projectPath)], {
      cwd: fileURLToPath(new URL("src/test/", root)),
      stdio: "pipe",
      encoding: "utf8",
    });
    return { status: 0, output: "" };
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    return { status: error.status ?? 1, output: `${stdout}${stderr}` };
  } finally {
    await rm(fixturePath, { force: true });
    await rm(projectPath, { force: true });
  }
}

test("orchestration declaration contract compiles with minimal inputs and preserved returns", async () => {
  const fixture = await readFile(new URL("client/orchestration-tree.d.mts", root), "utf8");
  const layout = await readFile(new URL("client/runtime-layout.d.mts", root), "utf8");
  const declarations = `${fixture}\n${layout}`;

  // Guard the contract the fixture encodes: minimal structural inputs, generic
  // preservation, and the new planner are all declared.
  assert.match(declarations, /RunLineage\s*=\s*\{/, "minimal RunLineage input type is exposed");
  assert.match(declarations, /readonly\s+Run\[\]/, "read-only element input drives return preservation");
  assert.match(declarations, /parent:\s*Run\s*\|\s*null/, "lineage parent preserves the caller type");
  assert.match(declarations, /function\s+planInspectNavigation/, "navigation planner is declared");

  const result = await typecheck("valid", FIXTURE);
  assert.equal(result.status, 0, `tsc must accept minimal valid calls:\n${result.output}`);
});

test("type-rejection guards are enforced: an accepted bad call fails the compile", async () => {
  assert.notEqual(BROKEN, FIXTURE, "the broken variant must differ from the valid fixture");
  const result = await typecheck("broken", BROKEN);
  assert.notEqual(result.status, 0, "tsc must reject the weakened guard (unused @ts-expect-error)");
  assert.match(result.output, /@ts-expect-error/, "failure is attributed to the unused directive");
});

test("the compiler fixture contains no any or @ts-ignore escape hatches", () => {
  assert.doesNotMatch(FIXTURE, /\bany\b/, "no any");
  assert.doesNotMatch(FIXTURE, /@ts-ignore/, "no @ts-ignore");
  assert.ok(
    (FIXTURE.match(/@ts-expect-error/g) ?? []).length === 8,
    "all eight wrong-type rejections stay guarded",
  );
});
