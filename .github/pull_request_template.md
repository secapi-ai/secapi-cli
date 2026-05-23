## Summary

<!-- What changed and why. One paragraph max. Link issues with "Closes #". -->

Closes #

## Scope

<!-- Check ALL areas this PR touches. Reviewers and CI use this to gauge blast radius. -->

- [ ] `src/` — CLI source (commands, formatters, client wiring)
- [ ] Command definitions (filings, statements, entity, etc.)
- [ ] Output formatters (JSON, table, etc.)
- [ ] `package.json` / dependencies / `bin` mappings
- [ ] `tsconfig.json` — TS config
- [ ] README / `--help` output
- [ ] `.github/` — CI/CD workflows
- [ ] Tests (`src/*.test.ts`)

## Changes

<!-- Bullet points grouped by area. Be specific — diffs are for code, this is for intent. -->

-
-

## Verification

<!-- What you ran locally. Paste actual commands and their outcomes. -->

```bash
bun install         # ✅ / ❌
bun run typecheck   # ✅ / ❌
bun run test        # ✅ / ❌
bun run build       # ✅ / ❌
```

<details>
<summary>Additional verification (expand if applicable)</summary>

```bash
# Live CLI smoke
SECAPI_API_KEY=... ./dist/index.js --help
SECAPI_API_KEY=... ./dist/index.js <command> <args>

# Both bin aliases
./dist/index.js --version    # `secapi` alias
./dist/index.js --version    # `omni-sec` alias

# Package size / contents
npm pack --dry-run
```

</details>

## Deployment Impact

<!-- Skip this section entirely for code-only changes with no release impact. -->

- [ ] New version bump in `package.json`
- [ ] Breaking CLI change (flags, command names, output format)
- [ ] npm publish required
- [ ] Homebrew formula needs bump (secapi-ai/homebrew-tap)
- [ ] Docs (README / `--help`) updated to match

## Completion Attestation

<!-- You MUST select one. This is a binding statement of delivery status. -->

- [ ] **100% complete, 100% functional.** All code is written, tested, typechecks, builds cleanly, and the CLI works end-to-end against live SEC API. No outstanding work remains.
- [ ] **Not fully complete or functional.** Deltas listed below.

### Deltas (only if attesting incomplete)

<!-- Short bullets. Items intentionally deferred from this PR's stated scope. -->

-

## Screenshots / Demo

<!-- Terminal output, command invocations, or before/after snippets. Delete section if not applicable. -->

---

<details>
<summary>Agent Context</summary>

<!-- This section is for AI coding agents that may continue or review this work.
     Fill in what's relevant; delete what isn't. -->

**Key files to read first:**
<!-- List the 3-5 most important files for understanding this PR's changes. -->
- `src/index.ts`
-

**Decisions made:**
<!-- Non-obvious choices and why. Agents should not re-litigate these. -->
-

**Relevant docs:**
- https://docs.secapi.ai
- https://secapi.ai/developers

**Conventions applied:**
<!-- Command structure, flag naming, output format defaults, exit codes. -->
-

</details>
