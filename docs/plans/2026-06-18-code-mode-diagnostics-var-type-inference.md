# Code Mode Diagnostics Var Type Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve inferred TypeScript types for successful Code Mode REPL `var` bindings so later cells can typecheck reused mutable state without `unknown` warnings.

**Architecture:** `CodeModeDiagnosticsSession` already stores ambient declarations for successful prior cells and feeds them into `diagnoseCodeModeTypeScript()`. Extend that session recorder so it builds a TypeScript program for the successful cell, asks the checker for each persisted function-scoped `var` binding type, and emits bounded ambient `declare var` declarations. Keep runtime behavior unchanged.

**Tech Stack:** TypeScript compiler API, Vitest, pnpm, existing QuickJS Code Mode runtime.

## Global Constraints

- Use `pnpm` only.
- Keep changes scoped to Code Mode diagnostics; do not change QuickJS runtime persistence semantics.
- Only function-scoped `var` bindings persist across cells today; do not start recording `let` or `const`.
- Only successful cells update diagnostics session state.
- If inference is unavailable, too broad, too complex, or unsafe to serialize, fall back to `unknown`.
- Generated Code Mode API files must remain unchanged unless public runtime declarations change; this task should not require that.

---

## File Structure

- Modify: `packages/core/src/code-mode/diagnostics.ts`
  - Add typed var declaration collection using TypeScript checker.
  - Keep existing function declaration recording behavior.
  - Replace `collectFunctionScopedVarNames()` / `collectVarDeclarationListNames()` with a typed binding collector.
- Modify: `packages/core/test/code-mode-session.test.ts`
  - Add focused `CodeModeDiagnosticsSession` tests for inferred mutable `var` state.
- No docs required unless implementation exposes user-visible behavior beyond removing diagnostics warnings.

---

### Task 1: Add Failing Diagnostics Tests For Persisted Var Types

**Files:**

- Modify: `packages/core/test/code-mode-session.test.ts`

**Interfaces:**

- Consumes: `CodeModeDiagnosticsSession.recordSuccessfulCell(code: string): void`
- Consumes: `diagnoseCodeModeTypeScript({ declaration, code, session })`
- Produces: Failing tests that define expected ambient type behavior for later implementation tasks.

- [ ] **Step 1: Add primitive and mutation tests**

Append these tests inside the existing `describe("CodeModeDiagnosticsSession", () => { ... })` block in `packages/core/test/code-mode-session.test.ts`:

```ts
it("preserves inferred primitive var types for later session diagnostics", () => {
  const session = new CodeModeDiagnosticsSession();
  const declaration = "declare const caplets: {};";

  session.recordSuccessfulCell("var workflowRuns = 1;\nreturn workflowRuns;");
  const diagnostics = diagnoseCodeModeTypeScript({
    declaration,
    code: "workflowRuns += 1;\nreturn workflowRuns;",
    session,
  });

  expect(diagnostics).toEqual([]);
});

it("preserves explicit var annotations for later session diagnostics", () => {
  const session = new CodeModeDiagnosticsSession();
  const declaration = "declare const caplets: {};";

  session.recordSuccessfulCell('var items: string[] = [];\nitems.push("a");\nreturn items;');
  const diagnostics = diagnoseCodeModeTypeScript({
    declaration,
    code: 'items.push("b");\nreturn items.join(",");',
    session,
  });

  expect(diagnostics).toEqual([]);
});
```

- [ ] **Step 2: Add object, array, destructuring, and redeclaration tests**

Append these tests in the same describe block:

```ts
it("preserves inferred object and array var types for later session diagnostics", () => {
  const session = new CodeModeDiagnosticsSession();
  const declaration = "declare const caplets: {};";

  session.recordSuccessfulCell(
    'var summary = { count: 1, label: "one" };\nvar numbers = [1, 2, 3];',
  );
  const diagnostics = diagnoseCodeModeTypeScript({
    declaration,
    code: "summary.count += numbers[0] ?? 0;\nreturn `${summary.label}:${summary.count}`;",
    session,
  });

  expect(diagnostics).toEqual([]);
});

it("preserves checker-inferred destructured var binding types when available", () => {
  const session = new CodeModeDiagnosticsSession();
  const declaration = "declare const caplets: {};";

  session.recordSuccessfulCell(
    'var { count, label } = { count: 1, label: "ready" };\nreturn label;',
  );
  const diagnostics = diagnoseCodeModeTypeScript({
    declaration,
    code: "count += 1;\nreturn label.toUpperCase();",
    session,
  });

  expect(diagnostics).toEqual([]);
});

it("updates var ambient types when successful cells redeclare a binding", () => {
  const session = new CodeModeDiagnosticsSession();
  const declaration = "declare const caplets: {};";

  session.recordSuccessfulCell("var mutable = 1;\nreturn mutable;");
  session.recordSuccessfulCell('var mutable = "ready";\nreturn mutable;');
  const diagnostics = diagnoseCodeModeTypeScript({
    declaration,
    code: "const numeric: number = mutable;\nreturn numeric;",
    session,
  });

  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "2322",
        message: expect.stringContaining("not assignable to type 'number'"),
      }),
    ]),
  );
});
```

- [ ] **Step 3: Add failed-cell poisoning regression at runner level**

Append this test in `packages/core/test/code-mode-sessions.test.ts` inside `describe("CodeModeSessionManager", () => { ... })`:

```ts
it("does not record failed diagnostic cells into inferred session var types", async () => {
  const manager = new CodeModeSessionManager({ idGenerator: () => "session-var-diagnostics" });
  try {
    const first = await runCodeMode({
      code: "var counter = 1;\nreturn counter;",
      service: service(),
      sessionManager: manager,
      runtimeScope: "test",
    });
    const rejected = await runCodeMode({
      code: 'await caplets.github.call("listIssues", {});\nvar counter = "bad";',
      service: service(),
      sessionManager: manager,
      sessionId: "session-var-diagnostics",
      runtimeScope: "test",
    });
    const reused = await runCodeMode({
      code: "counter += 1;\nreturn counter;",
      service: service(),
      sessionManager: manager,
      sessionId: "session-var-diagnostics",
      runtimeScope: "test",
    });

    expect(first).toMatchObject({ ok: true, value: 1 });
    expect(rejected).toMatchObject({ ok: false, error: { code: "diagnostic_blocked" } });
    expect(reused).toMatchObject({ ok: true, value: 2 });
    expect(reused.diagnostics).toEqual([]);
  } finally {
    manager.close();
  }
});
```

- [ ] **Step 4: Run tests and verify failure**

Run:

```sh
pnpm --filter @caplets/core test -- test/code-mode-session.test.ts test/code-mode-sessions.test.ts
```

Expected before implementation:

- The primitive/object/array/destructuring tests fail because `declare var <name>: unknown` still causes strict diagnostics such as `'workflowRuns' is of type 'unknown'`.
- Existing tests continue to pass or fail only where they rely on the old unknown behavior.

- [ ] **Step 5: Commit failing tests only**

```sh
git add packages/core/test/code-mode-session.test.ts packages/core/test/code-mode-sessions.test.ts
git commit -m "test(code-mode): cover inferred session var diagnostics"
```

---

### Task 2: Infer Ambient Var Types With The TypeScript Checker

**Files:**

- Modify: `packages/core/src/code-mode/diagnostics.ts`

**Interfaces:**

- Produces: `collectFunctionScopedVarBindings(source, checker): Array<{ name: string; type: string }>`
- Produces: `safeAmbientType(type, checker): string`
- Preserves: `CodeModeDiagnosticsSession.recordSuccessfulCell(code: string): void`

- [ ] **Step 1: Add a reusable compiler option helper**

In `packages/core/src/code-mode/diagnostics.ts`, extract the compiler options currently built inline in `diagnoseCodeModeTypeScript()`:

```ts
function codeModeCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts"],
    types: [],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    noErrorTruncation: true,
    allowJs: false,
  };
}
```

Then replace the existing inline object in `diagnoseCodeModeTypeScript()` with:

```ts
const compilerOptions = codeModeCompilerOptions();
```

- [ ] **Step 2: Build a checker for successful cells**

Inside `CodeModeDiagnosticsSession.recordSuccessfulCell()`, after creating `source`, create a program that includes the successful cell and current session declarations:

```ts
const compilerOptions = codeModeCompilerOptions();
const host = createVirtualCompilerHost(compilerOptions, {
  [CODE_FILE]: code,
  [AMBIENT_FILE]: [CODE_MODE_DIAGNOSTICS_BUILTINS_DECLARATION, this.declaration()].join("\n"),
});
const program = ts.createProgram([CODE_FILE, AMBIENT_FILE], compilerOptions, host);
const checker = program.getTypeChecker();
const programSource = program.getSourceFile(CODE_FILE) ?? source;
```

Use `programSource` for all binding/type collection so nodes belong to the program used by the checker.

- [ ] **Step 3: Replace name-only var collection with typed binding collection**

Replace the current loop:

```ts
for (const name of collectFunctionScopedVarNames(source)) {
  this.#declarations.set(name, `declare var ${name}: unknown;`);
}
```

with:

```ts
for (const binding of collectFunctionScopedVarBindings(programSource, checker)) {
  this.#declarations.set(binding.name, `declare var ${binding.name}: ${binding.type};`);
}
```

Then replace `collectFunctionScopedVarNames()` and `collectVarDeclarationListNames()` with:

```ts
type AmbientVarBinding = {
  name: string;
  type: string;
};

function collectFunctionScopedVarBindings(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): AmbientVarBinding[] {
  const bindings = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (node !== source && (ts.isFunctionLike(node) || ts.isClassLike(node))) {
      return;
    }
    if (ts.isVariableStatement(node)) {
      collectVarDeclarationListBindings(node.declarationList, checker, bindings);
    }
    if (
      (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.initializer)
    ) {
      collectVarDeclarationListBindings(node.initializer, checker, bindings);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...bindings.entries()].map(([name, type]) => ({ name, type }));
}

function collectVarDeclarationListBindings(
  declarationList: ts.VariableDeclarationList,
  checker: ts.TypeChecker,
  bindings: Map<string, string>,
): void {
  const isVar = (ts.getCombinedNodeFlags(declarationList) & ts.NodeFlags.BlockScoped) === 0;
  if (!isVar) return;
  for (const declaration of declarationList.declarations) {
    for (const name of bindingNames(declaration.name)) {
      const type = ambientTypeForBindingName(name, checker);
      bindings.set(name.text, type);
    }
  }
}
```

- [ ] **Step 4: Add binding-name and type serialization helpers**

Add these helpers near `bindingNames()`:

```ts
function bindingNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) {
    return [name];
  }
  return name.elements.flatMap((element) => {
    if (ts.isOmittedExpression(element)) {
      return [];
    }
    return bindingNames(element.name);
  });
}

function ambientTypeForBindingName(name: ts.Identifier, checker: ts.TypeChecker): string {
  const type = checker.getTypeAtLocation(name);
  return safeAmbientType(type, checker);
}

function safeAmbientType(type: ts.Type, checker: ts.TypeChecker): string {
  if (isUnsafeAmbientType(type)) return "unknown";
  const text = checker.typeToString(
    type,
    undefined,
    ts.TypeFormatFlags.NoTruncation |
      ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
      ts.TypeFormatFlags.WriteArrayAsGenericType,
  );
  if (!text || text === "any" || text === "{}" || text === "never") return "unknown";
  if (text.length > 500) return "unknown";
  if (/\bimport\(/u.test(text)) return "unknown";
  return text;
}

function isUnsafeAmbientType(type: ts.Type): boolean {
  return Boolean(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never));
}
```

If TypeScript rejects `UseAliasDefinedOutsideCurrentScope` in this repo version, drop that flag and keep `NoTruncation | WriteArrayAsGenericType`.

- [ ] **Step 5: Run focused tests**

Run:

```sh
pnpm --filter @caplets/core test -- test/code-mode-session.test.ts test/code-mode-sessions.test.ts
```

Expected:

- New tests pass.
- Existing helper/var diagnostics tests still pass.

- [ ] **Step 6: Commit implementation**

```sh
git add packages/core/src/code-mode/diagnostics.ts
git commit -m "fix(code-mode): infer reused var diagnostics types"
```

---

### Task 3: Harden Type Output Against Noisy Or Invalid Ambient Declarations

**Files:**

- Modify: `packages/core/src/code-mode/diagnostics.ts`
- Modify: `packages/core/test/code-mode-session.test.ts`

**Interfaces:**

- Consumes: `safeAmbientType(type, checker): string`
- Produces: Stable bounded ambient declarations that do not leak huge anonymous types into every later diagnostics pass.

- [ ] **Step 1: Add fallback tests for complex or unresolved types**

Append these tests inside `describe("CodeModeDiagnosticsSession", () => { ... })`:

```ts
it("falls back to unknown for unresolved or excessively complex var types", () => {
  const session = new CodeModeDiagnosticsSession();
  const declaration = "declare const caplets: {};";

  session.recordSuccessfulCell("var unresolved = JSON.parse('{\"value\":1}');\nreturn unresolved;");
  const diagnostics = diagnoseCodeModeTypeScript({
    declaration,
    code: "return unresolved.value;",
    session,
  });

  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "18046",
        message: expect.stringContaining("'unresolved' is of type 'unknown'"),
      }),
    ]),
  );
});

it("does not emit block-scoped let or const bindings into session diagnostics", () => {
  const session = new CodeModeDiagnosticsSession();
  const declaration = "declare const caplets: {};";

  session.recordSuccessfulCell(
    "let localLet = 1;\nconst localConst = 2;\nreturn localLet + localConst;",
  );
  const diagnostics = diagnoseCodeModeTypeScript({
    declaration,
    code: "return localLet + localConst;",
    session,
  });

  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "2304", message: expect.stringContaining("localLet") }),
      expect.objectContaining({ code: "2304", message: expect.stringContaining("localConst") }),
    ]),
  );
});
```

- [ ] **Step 2: Adjust `safeAmbientType()` for stable output**

If tests expose noisy types, update `safeAmbientType()` with these exact guards:

```ts
if (text.includes("__capletsCodeModeMain")) return "unknown";
if (text.includes("/caplets-code-mode/")) return "unknown";
if (/[{}]/u.test(text) && text.length > 200) return "unknown";
```

Do not reject small object literals such as `{ count: number; label: string; }` because those are useful and expected by Task 1 tests.

- [ ] **Step 3: Run focused diagnostics tests**

Run:

```sh
pnpm --filter @caplets/core test -- test/code-mode-session.test.ts
```

Expected:

- All `CodeModeDiagnosticsSession` tests pass.

- [ ] **Step 4: Commit hardening**

```sh
git add packages/core/src/code-mode/diagnostics.ts packages/core/test/code-mode-session.test.ts
git commit -m "test(code-mode): harden inferred var diagnostics"
```

---

### Task 4: Run Cross-Surface Verification And Final Cleanup

**Files:**

- Modify only if verification exposes a bug:
  - `packages/core/src/code-mode/diagnostics.ts`
  - `packages/core/test/code-mode-session.test.ts`
  - `packages/core/test/code-mode-sessions.test.ts`

**Interfaces:**

- Consumes: All prior task commits.
- Produces: Verified branch with no tracked dirty changes except intentional commits.

- [ ] **Step 1: Run the focused Code Mode surface suite**

Run:

```sh
pnpm --filter @caplets/core test -- test/code-mode-session.test.ts test/code-mode-sessions.test.ts test/code-mode-runner.test.ts test/code-mode-mcp.test.ts test/native.test.ts test/native-remote.test.ts
```

Expected:

- All selected tests pass.

- [ ] **Step 2: Run static checks**

Run:

```sh
pnpm format:check
pnpm typecheck
pnpm code-mode:check-api
```

Expected:

- `format:check` reports all matched files use correct format.
- `typecheck` succeeds for all packages.
- `code-mode:check-api` succeeds without generated API drift.

- [ ] **Step 3: Run full verification**

Run:

```sh
pnpm verify
```

Expected:

- Full verify passes: format, lint, Code Mode API check, schema check, docs check, typecheck, tests, benchmark check, and build.

- [ ] **Step 4: Inspect final diff**

Run:

```sh
git status --short
git diff --stat HEAD~3..HEAD
git log --oneline -5
```

Expected:

- Only intended diagnostics/test commits are present.
- No generated files changed unexpectedly.
- No unrelated untracked files are staged.

- [ ] **Step 5: Final review**

Ask a reviewer to focus on:

- whether inferred ambient types match persisted runtime `var` semantics,
- whether `let`/`const` remain excluded,
- whether complex types are bounded/fallback-safe,
- whether failed cells still do not update diagnostics state.

Expected:

- No blocker or important findings remain.

---

## Self-Review

- Spec coverage: The plan covers checker-based inference, persisted `var` state, explicit annotations, primitives, objects, arrays, destructuring, redeclaration, failed-cell non-poisoning, and verification.
- Placeholder scan: No `TBD`/`TODO` placeholders remain.
- Type consistency: Proposed helper signatures are defined before use and align with existing `CodeModeDiagnosticsSession.recordSuccessfulCell(code: string): void`.
- Scope check: This is a single subsystem change in diagnostics only; no runtime/session/journal behavior changes are planned.
