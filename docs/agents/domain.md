# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout

This is a single-context repo.

- Read root `CONTEXT.md` for Caplets product vocabulary and domain language.
- Read relevant ADRs in `docs/adr/` before changing areas covered by an architectural decision.
- If a future `CONTEXT-MAP.md` appears, treat that as a signal that the repo has moved to a multi-context layout and update this file.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`** entries that touch the area you're about to work in.
- **`STRATEGY.md`** when deciding whether proposed work fits the current product direction.
- **`CONCEPTS.md`** when orienting to shared project vocabulary.
- **`docs/solutions/`** when implementing, debugging, or making decisions in an area with documented prior solutions.

If any optional file does not exist in a checkout, proceed silently. Do not suggest creating it upfront; producer workflows create or update these docs when terms, strategy, or decisions are actually resolved.

## Use the glossary's vocabulary

When your output names a domain concept in an issue title, refactor proposal, hypothesis, test name, or implementation plan, use the terms defined in `CONTEXT.md` and `CONCEPTS.md`. Do not drift to synonyms those docs explicitly avoid.

If the concept you need is not in the glossary yet, either reconsider whether you are inventing language the project does not use, or note the gap for a vocabulary/documentation pass.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (Code Mode default exposure), but worth reopening because..._
