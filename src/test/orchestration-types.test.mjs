import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
let ts;
try {
  ts = require("typescript");
  tscPath = require.resolve("typescript/bin/tsc");
} catch {
  const packageDir = fileURLToPath(new URL("node_modules/typescript/", root));
  ts = require(packageDir);
  tscPath = join(packageDir, "bin", "tsc");
}
const clientDir = fileURLToPath(new URL("client/", root));
const projectConfig = fileURLToPath(new URL("tsconfig.json", root));

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
  `const headline = runtimeHeadline({ ownership: "proven", pid: 5272, endpoint: "127.0.0.1:4096" });`,
  `const ownershipOnlyHeadline = runtimeHeadline({ ownership: "unassigned" });`,
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
  `  ownershipOnlyHeadline,`,
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
  `// @ts-expect-error runtimeHeadline input shares the closed ownership union, not an arbitrary string.`,
  `runtimeHeadline({ ownership: "definitely" });`,
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

// Rewrites each COMPLETE `from "../../client/<module>"` specifier into one
// absolute specifier built by suffix-joining the directory (which keeps its own
// trailing `/` or `\`) and encoding the whole path with JSON.stringify, which
// emits a valid double-quoted TS string literal. Raw prefix injection is not
// safe: a Windows `clientDir` such as `C:\repo\client\` would turn `\r`, `\n`
// or `\uXXXX` substrings into escape sequences and UNC paths lose their leading
// `\\`, while a POSIX path containing `"` or `\` would splice the generated
// source. file:// specifiers are not usable here because tsc module resolution
// does not support them, so the encoding is applied to the plain absolute path.
function fixtureSource(source, dir) {
  return source.replaceAll(/from "\.\.\/\.\.\/client\/([^"]*)"/g, (_match, relative) => {
    return `from ${JSON.stringify(dir + relative)}`;
  });
}

// The exact pre-fix transform, kept so the regressions below can prove that the
// raw prefix injection produced a different (or unparsable) module specifier.
function legacyFixtureSource(source, dir) {
  return source.replaceAll('from "../../client/', `from "${dir}`);
}

function importedSpecifierLiterals(source) {
  const sourceFile = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true);
  const texts = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      texts.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    texts,
    parseErrors: (sourceFile.parseDiagnostics ?? []).map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    ),
  };
}

const PATH_CASES = [
  { name: "windows-drive", dir: "C:\\paseo\\r\\n\\u-1\\client\\" },
  { name: "windows-unicode-escape", dir: "C:\\repo\\u0041x\\client\\" },
  { name: "windows-unc", dir: "\\\\nas\\share\\client\\" },
  { name: "posix-quotes-and-backslashes", dir: '/tmp/r"o\\ck&sp\\ace/client/' },
];

async function typecheck(label, source) {
  // The fixture compiles from a fresh OS temp directory, never inside the
  // repository: no ephemeral .ts/.tsconfig can survive in the checkout. Both
  // writes and the compile run inside the guarded region, and finally removes
  // the whole directory. Specifiers and `extends` are made absolute so module
  // resolution reaches the real repo declarations from outside the checkout;
  // each specifier is one fully escaped string literal (see fixtureSource).
  const dir = await mkdtemp(join(tmpdir(), `orchestration-types-${label}-${process.pid}-`));
  try {
    const fixtureName = `fixture.${label}.ts`;
    await writeFile(join(dir, fixtureName), fixtureSource(source, clientDir), "utf8");
    const config = {
      extends: projectConfig,
      compilerOptions: { noEmit: true, types: [] },
      files: [fixtureName],
    };
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify(config, null, 2), "utf8");
    try {
      execFileSync(process.execPath, [tscPath, "-p", join(dir, "tsconfig.json")], {
        cwd: dir,
        stdio: "pipe",
        encoding: "utf8",
      });
      return { status: 0, output: "" };
    } catch (error) {
      const stdout = typeof error.stdout === "string" ? error.stdout : "";
      const stderr = typeof error.stderr === "string" ? error.stderr : "";
      return { status: error.status ?? 1, output: `${stdout}${stderr}` };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("orchestration declaration contract compiles with minimal inputs and preserved returns", async () => {
  // The compiled fixture IS the contract guard: it calls every helper with the
  // minimal declared input shapes (id/lineage, ownership/pid/endpoint), reads
  // the preserved generic fields off the results, and each wrong-type rejection
  // carries a real `@ts-expect-error`. Brittle textual regexes over the .d.mts
  // sources were removed in favor of this end-to-end compiler check.
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
    (FIXTURE.match(/@ts-expect-error/g) ?? []).length === 9,
    "all nine wrong-type rejections stay guarded",
  );
});

test("generated specifiers encode hostile paths as exact TS string literals", () => {
  // Host-independent: these directories are synthetic, so the check runs the
  // same on POSIX and Windows hosts. The real fixture compile above covers the
  // plain-path case; this proves the encoding, via the TypeScript parser, not
  // by regex or JSON plausibility: the parsed StringLiteral.text must equal
  // the intended full absolute specifier, suffix-joined with no doubled or
  // lost directory separator. Windows execution is not available in CI, so
  // Windows behaviour is proven by simulation of the generated source only.
  for (const { name, dir } of [...PATH_CASES, { name: "host-directory", dir: clientDir }]) {
    const parsed = importedSpecifierLiterals(fixtureSource(FIXTURE, dir));
    assert.deepEqual(parsed.parseErrors, [], `${name}: generated source must parse`);
    assert.deepEqual(
      parsed.texts,
      [`${dir}orchestration-tree.mjs`, `${dir}runtime-layout.mjs`],
      `${name}: parsed literal text must equal the intended absolute specifier`,
    );
  }
});

test("the pre-fix raw prefix injection mangled hostile paths (regression control)", () => {
  // Keeps the confirmed bug visible in the suite: injecting the directory as a
  // partial raw string prefix made `\r`, `\n` and `\uXXXX` substrings into
  // escape sequences (sometimes silently, e.g. \u0041 -> A), collapsed UNC
  // leading backslashes, and let quotes in POSIX paths terminate the literal.
  for (const { name, dir } of PATH_CASES) {
    const parsed = importedSpecifierLiterals(legacyFixtureSource(FIXTURE, dir));
    const intended = [`${dir}orchestration-tree.mjs`, `${dir}runtime-layout.mjs`];
    const corrupted =
      parsed.parseErrors.length > 0 || !parsed.texts.every((text, i) => text === intended[i]);
    assert.ok(corrupted, `${name}: legacy raw injection must NOT reproduce the intended path`);
  }
});
