# Dependency Upgrade Notes

The workspace uses TypeScript with NodeNext modules. Before changing import or compiler behavior, check current TypeScript documentation and compare it with local `tsconfig.json`.

The release checklist is sensitive to:

- NodeNext module resolution.
- Strict type checking.
- Browser smoke verification for the static checkout status page.
- Public GitHub repository context when an upstream package or issue is mentioned.

Local files that usually need review before a module-resolution recommendation:

- `package.json`
- `tsconfig.json`
- `src/release-risk.ts`
- `src/release/checklist.ts`
- `docs/adr/0001-module-resolution.md`
