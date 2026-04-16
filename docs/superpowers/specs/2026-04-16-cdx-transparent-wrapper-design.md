# CDX Transparent Wrapper Design

Date: 2026-04-16
Status: Proposed
Author: Codex

## Goal

Evolve `cdx` from an account-management entrypoint into the main transparent wrapper for `codex`, while moving the current account-management UI under `cdx manual`.

User-facing contract:

- Replace `codex` with `cdx`.
- Keep the same CLI shape and same command surface for wrapped Codex usage.
- Make `cdx` with no arguments behave like a wrapped `codex` interactive session.
- Preserve native Codex behavior by default.
- Add smart account-switching behavior only when `cdx` can wrap an interactive session safely.
- Move the current account manager UI to `cdx manual`.
- Refuse to start instead of launching a half-broken interactive wrapper.

The design prioritizes forward compatibility. If Codex adds commands or flags later, `cdx` should usually inherit them automatically without command-specific support.

## Non-Goals

- Reimplement Codex commands or TUI behavior inside `cdx`.
- Maintain feature-by-feature hardcoded support for every Codex subcommand.
- Keep the current `cdx` menu as the default command entrypoint.
- Depend on fragile TUI parsing as the primary source of truth.
- Silently fall back to a degraded interactive wrapper when safety is uncertain.

## Requirements

### Functional requirements

- `cdx` must accept the same argv shape as `codex` for wrapper-mode usage.
- `cdx` without arguments must open the wrapped interactive Codex session.
- `cdx manual` must open the current account-management UI.
- `cdx smart-switch --json` must remain available as the stable machine-readable switching operation.
- Non-interactive invocations must behave like transparent passthrough:
  - same stdout/stderr behavior
  - same exit code
  - no extra banners or styling
- Interactive TTY invocations that are safe to wrap must support:
  - normal Codex session startup
  - `resume`
  - `fork`
  - future interactive entrypoints when they are compatible with the same wrapping model
  - smart account switching on usage exhaustion
  - prompt restoration and optional autosubmit after switch
  - additive prompt highlighting and bounded wrapper status UI
- `ccx` may remain as a compatibility alias, but it must not become the canonical command.
- If `cdx` cannot prove a session is wrappable in a safe way, it must exit with a clear error and not start.

### Quality requirements

- Preserve native Codex controls such as arrows, escape handling, abort paths, and session navigation.
- Preserve native shortcut semantics exactly, including Codex-style double-`Ctrl+C` behavior.
- Keep the everyday wrapper visually close to Codex; branding and heavier presentation belong in `cdx manual`, not in the wrapped TUI.
- Avoid coupling core wrapper behavior to unstable internal Codex rendering details.
- Confine unstable integrations behind adapters that can be replaced independently.
- Ensure optional visual enhancements cannot break session correctness.

## Design Principles

### 1. Transparent by default

`cdx` should act like a thin shell around `codex`, not a second CLI with its own command semantics.

### 2. Administration is not the default path

Account management remains important, but it should live behind `cdx manual`, not behind the top-level everyday command.

### 3. Wrap only when safe

Interactive wrapping is opt-in at runtime, based on capability checks and execution mode. If the checks fail, `cdx` must not launch the interactive wrapper.

### 4. Additive, never substitutive

`cdx` may add behavior such as prompt highlighting, switch banners, and smart switching. It must not reinterpret or replace Codex output beyond those bounded additions.

### 5. Layered trust model

All logic must prefer stable public interfaces first and use fragile heuristics only as fallback.

## Architectural Options Considered

### Option A: Keep current `cdx` as menu, add a new wrapper command

Pros:

- Lowest migration cost
- Minimal disruption for current `cdx` users

Cons:

- Keeps the product split across multiple first-class commands
- Leaves `cdx` misaligned with the new intended daily workflow
- Makes long-term docs and discoverability worse

### Option B: Make `cdx` the wrapper, move the menu to `cdx manual`, keep `ccx` as compatibility alias

Pros:

- Clean everyday UX
- Best alignment with "replace `codex` with `cdx`"
- Smooth migration path for existing `ccx` users

Cons:

- Requires CLI dispatch restructuring
- Changes expectations for users who currently type `cdx` for the menu

### Option C: Remove `ccx` immediately and make `cdx` the only wrapper entrypoint

Pros:

- Cleanest command surface
- No dual entrypoint ambiguity

Cons:

- More abrupt migration
- Higher chance of breaking current habits and local scripts

### Recommendation

Choose Option B.

This gives `cdx` the right product shape without forcing an unnecessarily abrupt migration.

## Command Model

### Canonical command

`cdx` becomes the canonical wrapper command.

### Command mapping

- `cdx`
  - wrapped interactive Codex session
- `cdx [same args as codex]`
  - same invocation model as `codex [args]`
- `cdx resume ...`
  - wrapped interactive resume
- `cdx fork ...`
  - wrapped interactive fork
- `cdx exec ...`
  - transparent passthrough
- `cdx review ...`
  - transparent passthrough
- `cdx mcp ...`
  - transparent passthrough
- `cdx marketplace ...`
  - transparent passthrough
- `cdx manual`
  - current account-management UI
- `cdx smart-switch --json`
  - stable machine-readable switching API

### Alias strategy

- `ccx` should remain a compatibility alias during migration.
- `ccx` should delegate to the same `cdx` wrapper entrypoint rather than keep separate logic.
- `cxs` should not gain new hidden semantics; if kept, it should remain a simple alias to `cdx`.

## Proposed Architecture

### 1. Dispatcher

Purpose:

- Inspect argv and TTY state.
- Route to one of three destinations:
  - Codex wrapper shell
  - account manager UI
  - non-interactive smart-switch API

Rules:

- `manual` routes to the account manager UI.
- `smart-switch --json` routes to the machine-readable switching API.
- Everything else is treated as Codex-wrapper traffic and classified there as passthrough vs wrapped interactive.

This layer should remain small and deterministic. It must not contain PTY logic or account-ranking logic.

### 2. Codex Wrapper Shell

Purpose:

- Replace `codex` as the main command experience.
- Decide between transparent passthrough and wrapped interactive mode.
- Launch the real `codex`.

This layer absorbs the current `ccx` role and becomes the product core of the new `cdx`.

### 3. Transparent Codex Runner

Purpose:

- Execute the real `codex` unchanged.
- Preserve streams, exit code, and process semantics.

Scope:

- `exec`
- `review`
- `mcp`
- `marketplace`
- `completion`
- `features`
- `debug`
- future non-interactive commands

This is the compatibility backbone. If a Codex update adds a new non-interactive command, `cdx` should inherit support automatically through this lane.

### 4. Interactive Session Supervisor

Purpose:

- Run interactive Codex inside a PTY.
- Forward input and output.
- Track only the minimum session state needed for correctness.

State owned here:

- PTY process handle
- current `sessionId`
- current session file path, if available
- latest submitted prompt
- watch baseline for post-submit session inspection
- switch-in-progress state

This layer is transport and lifecycle infrastructure. It should not directly decide which account to pick.

### 5. Smart Actions Engine

Purpose:

- Orchestrate smart account behavior without owning the transport.
- Ask the switching API for recommendation or switching actions.
- Drive resume/autosubmit behavior after an exhaustion event.

Responsibilities:

- trigger switch flow on confirmed exhaustion
- call the internal smart-switch operation
- reopen or resume the session
- restore or autosubmit the pending prompt
- emit bounded wrapper status UI for state transitions

This isolates business logic from PTY mechanics.

### 6. Account Manager UI

Purpose:

- Preserve and evolve the current `cdx` menu-driven account-management experience.

Responsibilities:

- switch manually
- save/add/remove/rename/swap accounts
- pin/exclude accounts
- list accounts and live limits
- show richer UI and product identity than the transparent wrapper path

This subsystem should not own the wrapper transport logic.

## Capability and Trust Model

`cdx` should consume information in descending order of trust:

### Level 1: Public CLI contract

- argv
- flags
- documented subcommands
- exit codes
- stdio behavior
- TTY presence

This is the preferred source whenever possible.

### Level 2: Runtime capability discovery

- parse `codex --help`
- detect whether public commands like `resume` or `fork` exist
- detect whether the invocation is expected to open an interactive TUI

This avoids hardcoding a static picture of Codex features.

### Level 3: Semi-stable adapters

- session metadata and logs
- reusable session identifiers
- rate-limit-related state obtainable without TUI scraping

These are allowed, but only behind adapters with narrow interfaces.

Proposed adapters:

- `CodexCapabilityProbe`
- `SessionBackend`
- `RateLimitBackend`
- `PromptStateBackend`

### Level 4: TUI parsing fallback

- visible prompt text
- usage-limit messages rendered in the terminal
- redraw-sensitive prompt detection

This is the least trustworthy layer and must remain fallback-only. No core correctness property should depend solely on it.

## Operational Modes

### Mode A: Transparent Mode

Conditions:

- invocation is non-interactive
- or the command is classified as passthrough-only

Behavior:

- no smart features
- no additional colors
- no wrapper banners
- no wrapping-specific logging on user-facing streams

Success criterion:

- the user should not be able to tell they ran `cdx` instead of `codex`, except by inspecting the parent process.

### Mode B: Interactive Wrapped Mode

Conditions:

- invocation is interactive
- required capabilities are present
- wrapping safety checks pass

Behavior:

- run Codex in PTY
- keep native controls working
- add smart switching on usage exhaustion
- optionally resume and autosubmit pending prompt
- add additive prompt highlighting and minimal wrapper status UI only where needed

Core behaviors:

- session correctness
- input forwarding
- prompt continuity
- safe switching
- native signal behavior
- native shortcut semantics

Optional behaviors:

- prompt highlighting
- switch status lines
- local diagnostics

Optional behaviors must be individually disableable and must never jeopardize core correctness.

### Mode C: Manual Account Mode

Conditions:

- invocation is `cdx manual`

Behavior:

- open the current account-management UI
- allow richer presentation and stronger product identity than the transparent wrapper path

### Mode D: Refuse to Start

Conditions:

- invocation appears interactive
- but required wrapping capabilities are missing or uncertain

Behavior:

- print a clear error
- exit without launching Codex

This matches the product requirement that `cdx` must not start in a half-supported state.

## Failure Model

The system should degrade by feature tier, not collapse globally.

### Allowed localized failures

- prompt highlighting fails -> session continues without highlighting
- switch banner formatting fails -> session continues without banner
- non-essential diagnostics fail -> session continues silently

### Hard-stop failures

- invocation cannot be classified safely
- required capability for interactive wrapping is missing
- session supervision cannot preserve native controls reliably

In these cases, `cdx` must fail before starting the wrapped session.

### Interactive runtime failures

If a smart feature fails after a wrapped session has already started:

- preserve the Codex session if possible
- disable or skip only the failing smart feature
- never leave the terminal in a broken input mode

## Compatibility Strategy for Future Codex Updates

The design aims to make new Codex releases inexpensive to support.

Expected outcomes:

- New non-interactive command:
  - inherited automatically by transparent mode
- New flag on existing command:
  - forwarded automatically
- New interactive command using the same TTY/TUI execution model:
  - potentially inherited automatically if capability checks still pass
- Internal session-log change:
  - handled inside one adapter
- TUI rendering change:
  - may affect optional wrapper enhancements, but must not break core wrapper behavior

## Component Boundaries

### Stable core modules

- dispatcher
- codex process launching
- passthrough runner
- PTY supervision
- terminal state restore
- signal forwarding

### Smart modules

- account recommendation and switching
- exhaustion detection orchestration
- prompt persistence and autosubmit

### Administrative modules

- account manager UI
- account store and repair
- live-limit presentation

### Sacrificial modules

- prompt highlighting
- decorative status lines
- local diagnostics

Sacrificial modules may be disabled automatically if they threaten correctness.

## Testing Strategy

### Dispatcher tests

- `cdx manual` routes to the account manager UI
- `cdx smart-switch --json` routes to the machine-readable API
- wrapper invocations route into wrapper classification

### Contract tests

- `cdx` passthrough matches `codex` for representative non-interactive commands
- exit codes are preserved
- stdout/stderr behavior is preserved

### Classification tests

- interactive vs non-interactive classification
- ambiguous invocation refusal
- capability-driven decision making

### Interactive correctness tests

- normal startup
- `resume`
- `fork`
- session reuse after switch
- autosubmit after exhaustion
- prompt continuity
- signal and key behavior (`Esc`, arrows, `Ctrl+C`)
- Codex-identical double-`Ctrl+C` semantics

### Administrative UI tests

- `cdx manual` preserves current account-management behavior
- ranking and live-limit UI remain correct
- account repair and cleanup remain intact

### Resilience tests

- delayed session discovery
- delayed usage-limit signal
- stale session log data
- redraw-heavy prompt rendering

### Degradation tests

- loss of prompt-highlighting adapter does not break the session
- partial switch-feature failure does not break terminal input

## Rollout Strategy

### Phase 1: Command model migration

- make `cdx` the wrapper entrypoint
- move current menu UI to `cdx manual`
- keep `ccx` as a compatibility alias

### Phase 2: Formalize wrapper lanes

- separate passthrough and interactive wrapped mode explicitly
- isolate invocation classification
- define the refusal path clearly

### Phase 3: Capability registry and adapters

- add runtime capability probing
- move command assumptions out of ad-hoc branches
- move session and prompt dependencies behind interfaces

### Phase 4: Optional feature isolation

- separate additive visuals from core transport logic
- make optional features easy to disable automatically

## Explicit Defaults

- Interactive entrypoints considered required for wrapped launch in the first implementation are:
  - default TUI launch with no subcommand
  - `resume`
  - `fork`
- Additional interactive entrypoints may be admitted later only through capability-based classification, not by weakening the safety bar.
- Refusal errors should remain concise by default on user-facing stderr. Detailed diagnostics belong in debug logging, not in the normal launch path.
- Adapter-level observability should be minimal by default and expanded only in explicit debug mode or local diagnostic logs.
- The transparent wrapper path should stay visually close to Codex. Distinctive branding and richer graphics belong in `cdx manual`, not in the daily wrapped session.

## Decision Summary

Build `cdx` as the main transparent compatibility shell around `codex` with a multi-lane runtime model:

- transparent passthrough for non-interactive commands
- guarded interactive wrapping for safe TUI sessions
- `manual` mode for the current account-management UI

Keep `ccx` only as a compatibility alias during migration. Use capability discovery and adapter isolation to keep the design scalable as Codex evolves. Treat prompt styling and other wrapper enhancements as optional add-ons, not as foundations of correctness.
