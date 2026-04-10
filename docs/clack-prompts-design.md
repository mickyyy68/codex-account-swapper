# Design Doc: Interactive UX with `@clack/prompts`

## Status
- Proposed
- Date: 2026-04-10
- Author: Codex + Mike

## Product Decisions (2026-04-10)
1. Cancellation exit code: use `1` for consistency with existing error behavior.
2. `switch` behavior: interactive account picker (not next-in-order only).
3. Entry model: bare `cdx` only; legacy subcommand UX is removed.
4. No persistent `withGuide` preference for now.

## Summary
`cdx` moves to an interactive-only UX powered by `@clack/prompts`.
The old subcommand-first CLI is intentionally replaced by a single interactive entrypoint (`cdx`).

## Background
Current implementation:
- Core CLI entrypoint is [`bin/cdx.js`](/Users/mike/Documents/coding/test/codex-account-swapper/bin/cdx.js) (CommonJS, Node `>=18`).
- Commands are argument-driven (`add`, `save`, `use`, `rename`, `switch`, `swap`, `remove`, etc.).
- No interactive picker/confirm flow exists.

Problem:
- Common tasks (switching, removing, renaming, swapping) require remembering names or indices.
- Errors are recoverable but user journey is linear and text-heavy.
- New users are not guided through setup path.

## Goals
1. Improve interactive UX for human-operated runs of `cdx`.
2. Standardize around one interaction model (`cdx` menu-driven flow).
3. Keep account data model and command semantics unchanged.
4. Handle cancellation safely and predictably.

## Non-Goals
1. Replacing core account storage logic.
2. Building a full-screen TUI.
3. Providing backward compatibility for the old subcommand UX.
4. Introducing remote/network dependencies at runtime.

## Research Notes
Primary findings from official Clack sources:
- `@clack/prompts` latest release is `1.2.0` (released 2026-03-31).  
  Source: https://github.com/bombshell-dev/clack/releases/tag/%40clack%2Fprompts%401.2.0
- Since `1.0.0`, the package is ESM-only (no CJS build).  
  Source: https://raw.githubusercontent.com/bombshell-dev/clack/%40clack/prompts%401.2.0/packages/prompts/CHANGELOG.md
- Prompts include `select`, `autocomplete`, `path`, `confirm`, `text`, `group`, plus helpers (`intro`, `outro`, `spinner`, `note`, `log`) and `isCancel`.  
  Source: https://bomb.sh/docs/clack/packages/prompts/
- Prompts support shared options including `withGuide`, `signal` (AbortController), and custom input/output streams.  
  Source: https://bomb.sh/docs/clack/packages/prompts/
- Recommended usage patterns include explicit cancellation/error handling and progressive disclosure.  
  Source: https://bomb.sh/docs/clack/guides/best-practices/

## Requirements

### Functional
1. `cdx` launches an interactive home menu as the primary and only user-facing interface.
2. Menu-driven actions collect all needed input via prompts (no positional command args expected).
3. Destructive actions require confirmation in interactive mode (`remove`, optionally `swap`).
4. Cancellation (`Esc`, `Ctrl+C`) exits cleanly with clear status and no partial writes.
5. If interactive I/O is unavailable (non-TTY), print a clear error and exit `1`.

### Non-Functional
1. Startup overhead for interactive startup stays low.
2. Implementation remains maintainable (separate UI adapter from business logic).

## UX Design

### Entry Behavior
- `cdx` in TTY: show interactive action picker.
- `cdx` in non-TTY: print that interactive terminal is required and exit `1`.

### Home Menu (Initial)
Options:
1. `Use account`
2. `Switch account`
3. `Save current auth as account`
4. `Add account from auth file`
5. `Rename account`
6. `Swap account order`
7. `Remove account`
8. `List accounts`
9. `Exit`

### Prompt Patterns by Command
- `use`:
  - `select` for account name (active account labeled/hinted).
  - Confirm only if target equals current active (optional).
- `switch`:
  - Use `select` picker to choose target account directly.
  - Apply selected account and confirm via `outro`.
- `add`:
  - `text` for name.
  - `path` for `auth.json` file.
  - Validate file exists and is readable.
- `save`:
  - `text` for new name.
  - If duplicate name: confirm overwrite.
- `rename`:
  - `select` existing account.
  - `text` new name with uniqueness validation.
- `swap`:
  - First `select` account A.
  - Second `select` account B (A disabled).
- `remove`:
  - `select` account.
  - `confirm` before deletion.

### Cancellation UX
- On canceled prompt: call `cancel("Operation cancelled")`, exit code `1` for consistency with existing CLI error semantics.
- Do not mutate files when canceled.

## Technical Design

### Key Constraint: ESM-only Dependency in CommonJS CLI
Current CLI is CommonJS. `@clack/prompts` v1+ is ESM-only.

Two options:
1. Convert project to ESM.
2. Keep CJS and use dynamic `import("@clack/prompts")` only where needed.

Decision:
- Use option 2 for minimal migration risk.

Why:
- Preserves existing runtime and packaging behavior.
- Avoids touching all module syntax at once.
- Keeps migration scope small while introducing the new UI.

### Module Structure
Proposed split:
- `bin/cdx.js`:
  - argument parsing + command dispatch.
  - existing command handlers remain source of truth.
- `bin/ui.mjs` (new):
  - clack prompt orchestration.
  - helper wrappers for cancellation and messaging.

Alternative:
- Keep single file and lazy `await import("@clack/prompts")` in place.
- Faster to implement, but lower readability at scale.

Recommendation:
- Start with in-file integration for phase 1, extract to `bin/ui.mjs` in phase 2 if command flow grows.

### Runtime Flow
1. Parse args.
2. Determine interactive intent:
   - `isTTY = process.stdin.isTTY && process.stdout.isTTY`
   - if `isTTY`: interactive menu.
3. On interactive path:
   - lazy-load clack via dynamic import.
   - run menu and call existing account operation functions.
4. On non-interactive path:
   - print "interactive terminal required" and exit `1`.

### Data/State
No schema changes:
- Accounts stay in `~/.cdx/accounts.json`
- Active account stays in `~/.cdx/active`
- Snapshots stay in `~/.cdx/auth/*.auth.json`

## Error Handling
1. Validation errors stay command-specific and human readable.
2. Prompt cancellation is not treated as stack error.
3. Partial writes prevented by reusing existing atomic-ish write points (`writeAccounts`, `setActive`, etc.).
4. For interactive operations, errors are rendered with clack `log.error` then exit non-zero.

## Testing Plan

### Existing
- Replace smoke test with a deterministic non-TTY check (expects interactive-terminal-required error and exit `1`).

### New
1. Unit-ish tests for mode behavior:
   - TTY launches interactive mode.
   - Non-TTY exits `1` with a clear message.
2. Integration test around core account operations remains unchanged.
3. Manual QA matrix in real TTY:
   - cancel at every prompt
   - remove active vs non-active account
   - swap with same account
   - invalid auth path in add

Optional advanced test:
- Use clack custom streams to test prompt flows deterministically.

## Rollout Plan
1. Phase 1:
   - Add dependency.
   - Add `cdx` interactive home menu.
2. Phase 2:
   - Complete all actions in menu (`use`, `switch`, `save`, `add`, `rename`, `swap`, `remove`, `list`).
3. Phase 3:
   - UX polish (`spinner`, `note`, compact copy tuning).
4. Phase 4:
   - Remove old subcommand documentation and publish migration notes.

## Risks and Mitigations
1. ESM/CJS interop issues.
   - Mitigation: dynamic import, isolate in interactive path.
2. Unexpected behavior in CI or piped output.
   - Mitigation: strict TTY gating and explicit non-TTY error messaging.
3. Prompt regressions on Windows terminals.
   - Mitigation: robust cancel/error handling and targeted terminal QA.
4. Overly noisy output for script users.
   - Mitigation: out of scope; this is an intentional product tradeoff.

## Open Questions
1. How should migration/versioning be communicated for removing legacy subcommands (major bump + changelog wording)?

## Acceptance Criteria
1. Running `cdx` in an interactive terminal opens a menu and can complete at least `use`, `save`, `remove`.
2. `switch` is account-picker based in interactive flow.
3. Non-TTY invocation exits `1` with a clear interactive-terminal-required message.
4. Canceling any prompt leaves account files untouched.
5. README documents menu-first usage and no longer presents legacy subcommands.
