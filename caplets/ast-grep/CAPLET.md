---
$schema: https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplet.schema.json
name: ast-grep CLI
description: Search, scan, test, rewrite, and scaffold ast-grep rules through curated CLI tools.
tags:
  - cli
  - code
  - search
cliTools:
  timeoutMs: 120000
  maxOutputBytes: 1000000
  actions:
    version:
      description: Print the installed ast-grep version.
      command: ast-grep
      args:
        - --version
      annotations:
        readOnlyHint: true
    run_pattern_text:
      description: Search one path with one ast-grep pattern and return text output.
      command: ast-grep
      args:
        - run
        - --pattern
        - $input.pattern
        - --lang
        - $input.lang
        - --color
        - never
        - --heading
        - never
        - $input.path
      inputSchema:
        type: object
        properties:
          pattern:
            type: string
          lang:
            type: string
          path:
            type: string
        required:
          - pattern
          - lang
          - path
      annotations:
        readOnlyHint: true
    run_pattern_json:
      description: Search one path with one ast-grep pattern and return compact JSON output.
      command: ast-grep
      args:
        - run
        - --pattern
        - $input.pattern
        - --lang
        - $input.lang
        - --json=compact
        - --color
        - never
        - $input.path
      inputSchema:
        type: object
        properties:
          pattern:
            type: string
          lang:
            type: string
          path:
            type: string
        required:
          - pattern
          - lang
          - path
      output:
        type: json
      annotations:
        readOnlyHint: true
    run_pattern_debug_query:
      description: Print the parsed tree-sitter query AST for a pattern and language.
      command: ast-grep
      args:
        - run
        - --pattern
        - $input.pattern
        - --lang
        - $input.lang
        - --debug-query
        - ast
        - --color
        - never
        - $input.path
      inputSchema:
        type: object
        properties:
          pattern:
            type: string
          lang:
            type: string
          path:
            type: string
        required:
          - pattern
          - lang
          - path
      annotations:
        readOnlyHint: true
    run_pattern_with_context:
      description: Search one path with one pattern and include context lines around each match.
      command: ast-grep
      args:
        - run
        - --pattern
        - $input.pattern
        - --lang
        - $input.lang
        - --context
        - $input.context
        - --color
        - never
        - $input.path
      inputSchema:
        type: object
        properties:
          pattern:
            type: string
          lang:
            type: string
          context:
            type: integer
          path:
            type: string
        required:
          - pattern
          - lang
          - context
          - path
      annotations:
        readOnlyHint: true
    run_pattern_with_globs_json:
      description: Search one path with one pattern and one include or exclude glob, returning compact JSON output.
      command: ast-grep
      args:
        - run
        - --pattern
        - $input.pattern
        - --lang
        - $input.lang
        - --globs
        - $input.globs
        - --json=compact
        - --color
        - never
        - $input.path
      inputSchema:
        type: object
        properties:
          pattern:
            type: string
          lang:
            type: string
          globs:
            type: string
          path:
            type: string
        required:
          - pattern
          - lang
          - globs
          - path
      output:
        type: json
      annotations:
        readOnlyHint: true
    run_rewrite_apply_all:
      description: Apply one ast-grep rewrite to all matches without confirmation.
      command: ast-grep
      args:
        - run
        - --pattern
        - $input.pattern
        - --rewrite
        - $input.rewrite
        - --lang
        - $input.lang
        - --update-all
        - $input.path
      inputSchema:
        type: object
        properties:
          pattern:
            type: string
          rewrite:
            type: string
          lang:
            type: string
          path:
            type: string
        required:
          - pattern
          - rewrite
          - lang
          - path
      annotations:
        destructiveHint: true
    scan_project:
      description: Scan the current ast-grep project configuration and return text diagnostics.
      command: ast-grep
      args:
        - scan
        - --color
        - never
        - $input.path
      inputSchema:
        type: object
        properties:
          path:
            type: string
        required:
          - path
      annotations:
        readOnlyHint: true
    scan_project_json:
      description: Scan with the project configuration and return compact JSON output.
      command: ast-grep
      args:
        - scan
        - --json=compact
        - --color
        - never
        - $input.path
      inputSchema:
        type: object
        properties:
          path:
            type: string
        required:
          - path
      output:
        type: json
      annotations:
        readOnlyHint: true
    scan_project_sarif:
      description: Scan with the project configuration and output SARIF diagnostics.
      command: ast-grep
      args:
        - scan
        - --format
        - sarif
        - --color
        - never
        - $input.path
      inputSchema:
        type: object
        properties:
          path:
            type: string
        required:
          - path
      output:
        type: json
      annotations:
        readOnlyHint: true
    scan_project_github:
      description: Scan with the project configuration and output GitHub annotation format.
      command: ast-grep
      args:
        - scan
        - --format
        - github
        - --color
        - never
        - $input.path
      inputSchema:
        type: object
        properties:
          path:
            type: string
        required:
          - path
      annotations:
        readOnlyHint: true
        openWorldHint: true
    scan_with_config_json:
      description: Scan one path with an explicit sgconfig.yml path and return compact JSON output.
      command: ast-grep
      args:
        - scan
        - --config
        - $input.config
        - --json=compact
        - --color
        - never
        - $input.path
      inputSchema:
        type: object
        properties:
          config:
            type: string
          path:
            type: string
        required:
          - config
          - path
      output:
        type: json
      annotations:
        readOnlyHint: true
    scan_rule_json:
      description: Scan one path with one rule file and return compact JSON output.
      command: ast-grep
      args:
        - scan
        - --rule
        - $input.rule
        - --json=compact
        - --color
        - never
        - $input.path
      inputSchema:
        type: object
        properties:
          rule:
            type: string
          path:
            type: string
        required:
          - rule
          - path
      output:
        type: json
      annotations:
        readOnlyHint: true
    scan_inline_rules_json:
      description: Scan one path with inline rule YAML text and return compact JSON output.
      command: ast-grep
      args:
        - scan
        - --inline-rules
        - $input.rules
        - --json=compact
        - --color
        - never
        - $input.path
      inputSchema:
        type: object
        properties:
          rules:
            type: string
          path:
            type: string
        required:
          - rules
          - path
      output:
        type: json
      annotations:
        readOnlyHint: true
    scan_filter_json:
      description: Scan one path with project rules whose IDs match a regex and return compact JSON output.
      command: ast-grep
      args:
        - scan
        - --filter
        - $input.filter
        - --json=compact
        - --color
        - never
        - $input.path
      inputSchema:
        type: object
        properties:
          filter:
            type: string
          path:
            type: string
        required:
          - filter
          - path
      output:
        type: json
      annotations:
        readOnlyHint: true
    scan_inspect_summary:
      description: Scan one path and print ast-grep discovery summary inspection output on stderr.
      command: ast-grep
      args:
        - scan
        - --inspect
        - summary
        - --color
        - never
        - $input.path
      inputSchema:
        type: object
        properties:
          path:
            type: string
        required:
          - path
      annotations:
        readOnlyHint: true
    scan_rewrite_apply_all:
      description: Apply all configured ast-grep rewrites without confirmation.
      command: ast-grep
      args:
        - scan
        - --update-all
        - $input.path
      inputSchema:
        type: object
        properties:
          path:
            type: string
        required:
          - path
      annotations:
        destructiveHint: true
    test_rules:
      description: Run ast-grep rule tests with the default project configuration.
      command: ast-grep
      args:
        - test
        - --color
        - never
      annotations:
        readOnlyHint: true
    test_rules_with_config:
      description: Run ast-grep rule tests with an explicit project configuration.
      command: ast-grep
      args:
        - test
        - --config
        - $input.config
        - --color
        - never
      inputSchema:
        type: object
        properties:
          config:
            type: string
        required:
          - config
      annotations:
        readOnlyHint: true
    test_rules_filter:
      description: Run ast-grep rule tests filtered by a glob pattern.
      command: ast-grep
      args:
        - test
        - --filter
        - $input.filter
        - --color
        - never
      inputSchema:
        type: object
        properties:
          filter:
            type: string
        required:
          - filter
      annotations:
        readOnlyHint: true
    test_rules_skip_snapshots:
      description: Check ast-grep test code validity without checking snapshot output.
      command: ast-grep
      args:
        - test
        - --skip-snapshot-tests
        - --color
        - never
      annotations:
        readOnlyHint: true
    test_rules_update_snapshots:
      description: Update all changed ast-grep test snapshots.
      command: ast-grep
      args:
        - test
        - --update-all
        - --color
        - never
      annotations:
        destructiveHint: true
    new_project_yes:
      description: Scaffold a new ast-grep project with default answers.
      command: ast-grep
      cwd: $input.cwd
      args:
        - new
        - project
        - --yes
      inputSchema:
        type: object
        properties:
          cwd:
            type: string
        required:
          - cwd
      annotations:
        destructiveHint: true
    new_rule_yes:
      description: Scaffold a new ast-grep rule with default answers.
      command: ast-grep
      cwd: $input.cwd
      args:
        - new
        - rule
        - $input.name
        - --lang
        - $input.lang
        - --yes
      inputSchema:
        type: object
        properties:
          name:
            type: string
          lang:
            type: string
          cwd:
            type: string
        required:
          - name
          - lang
          - cwd
      annotations:
        destructiveHint: true
    new_test_yes:
      description: Scaffold a new ast-grep rule test with default answers.
      command: ast-grep
      cwd: $input.cwd
      args:
        - new
        - test
        - $input.name
        - --lang
        - $input.lang
        - --yes
      inputSchema:
        type: object
        properties:
          name:
            type: string
          lang:
            type: string
          cwd:
            type: string
        required:
          - name
          - lang
          - cwd
      annotations:
        destructiveHint: true
    new_util_yes:
      description: Scaffold a new ast-grep utility rule with default answers.
      command: ast-grep
      cwd: $input.cwd
      args:
        - new
        - util
        - $input.name
        - --lang
        - $input.lang
        - --yes
      inputSchema:
        type: object
        properties:
          name:
            type: string
          lang:
            type: string
          cwd:
            type: string
        required:
          - name
          - lang
          - cwd
      annotations:
        destructiveHint: true
---

# ast-grep CLI

Use this Caplet to expose ast-grep's structural search, scan, rule testing, rewrite, and scaffold workflows without giving an agent unrestricted shell access.

The manifest uses the full `ast-grep` executable instead of `sg` because `sg` can collide with the Linux `setgroups` command. Install ast-grep separately with npm, Cargo, Homebrew, or another supported package manager before using these tools.

## Coverage

- `run_*` actions cover one-off structural search, JSON output, query debugging, context output, glob-filtered search, and apply-all rewrites.
- `scan_*` actions cover project scans, explicit config scans, single-rule scans, inline-rule scans, filter scans, SARIF/GitHub output, discovery inspection, and apply-all rewrites.
- `test_*` actions cover rule tests, config-specific tests, filtered tests, snapshot-skipping tests, and snapshot updates.
- `new_*` actions scaffold projects, rules, tests, and utility rules with `--yes` defaults.

Path-oriented actions intentionally accept one `path` argument per call because the CLI backend interpolates primitive arguments, not path arrays.

The `ast-grep lsp` server is intentionally not exposed. The LSP command is a long-running server process, while the Caplets CLI backend is designed for bounded request/response tool calls.

Interactive ast-grep workflows are not exposed for the same reason; use non-interactive apply-all rewrite and snapshot-update actions when file changes are intended.

## Safety

Read-only search, scan, and normal test actions set `readOnlyHint: true`. Apply-all rewrite, snapshot-update, and scaffolding actions set `destructiveHint: true` because they can modify files.
