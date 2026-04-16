# CCX Transparent Wrapper Design

Date: 2026-04-16
Status: Proposed
Author: Codex

## Goal

Evolve `ccx` from a purpose-built smart-switch wrapper into a transparent compatibility shell for `codex`.

User-facing contract:

- Replace `codex` with `ccx`.
- Keep the same CLI shape and the same command surface.
- Preserve native Codex behavior by default.
- Add smart account-switching behavior only when `ccx` can wrap an interactive session safely.
- Refuse to start instead of launching a half-broken wrapper.
- Make it visually clear that the user is inside `CCX`, using restrained green accents and `CCX` ASCII branding without breaking terminal coherence.

The design prioritizes forward compatibility. If Codex adds commands or flags later, `ccx` should usually inherit them automatically without needing command-specific support.

## Non-Goals

- Reimplement Codex commands or TUI behavior inside `ccx`.
- Maintain feature-by-feature hardcoded support for every Codex subcommand.
- Depend on fragile TUI parsing as the primary source of truth.
- Silently fall back to a degraded interactive wrapper when safety is uncertain.

## Requirements

### Functional requirements

- `ccx` must accept the same argv shape as `codex`.
- Non-interactive invocations must behave like transparent passthrough:
  - same stdout/stderr behavior
  - same exit code
  - no extra banners or styling
- Interactive TTY invocations that are safe to wrap must support:
  - normal Codex session startup
  - `resume`
  - future interactive entrypoints when they are compatible with the same wrapping model
  - smart account switching on usage exhaustion
  - prompt restoration and optional autosubmit after switch
  - additive prompt highlighting and switch banners
  - `CCX` branding that is visible but stylistically consistent with the surrounding terminal and Codex UI
- If `ccx` cannot prove a session is wrappable in a safe way, it must exit with a clear error and not start.

### Quality requirements

- Preserve native Codex controls such as arrows, escape handling, abort paths, and session navigation.
- Preserve native shortcut semantics exactly, including the Codex-style double-`Ctrl+C` behavior where the first press interrupts the current interaction and only a subsequent press exits the wrapper.
- Avoid coupling core wrapper behavior to unstable internal Codex rendering details.
- Confine unstable integrations behind adapters that can be replaced independently.
- Ensure optional visual enhancements cannot break session correctness.

## Design Principles

### 1. Transparent by default

`ccx` should act like a thin shell around `codex`, not a second CLI with its own command semantics.

### 2. Wrap only when safe

Interactive wrapping is opt-in at runtime, based on capability checks and execution mode. If the checks fail, `ccx` must not launch.

### 3. Additive, never substitutive

`ccx` may add behavior such as banners, prompt highlighting, and smart switching. It must not reinterpret or replace Codex output beyond those bounded additions.

Branding is allowed only as an additive layer. `CCX` identity should be recognizable, but never at the cost of native Codex affordances or terminal coherence.

### 4. Layered trust model

All logic must prefer stable public interfaces first and use fragile heuristics only as fallback.

## Architectural Options Considered

### Option A: Hardcode support per Codex subcommand

`ccx` would explicitly know commands like `resume`, `fork`, and the default interactive mode, and special-case each one.

Pros:

- Easy to start with
- Straightforward control flow

Cons:

- Poor forward compatibility
- High maintenance cost as Codex grows
- Easy to miss new interactive entrypoints

### Option B: Infer behavior from argv patterns only

`ccx` would classify commands by parsing argv and hand-maintained rules.

Pros:

- Better than per-command branching
- Moderate implementation complexity

Cons:

- Still tied to the current Codex CLI shape
- Brittle when Codex changes semantics without changing syntax

### Option C: Classify execution mode, then wrap by capability

`ccx` decides between transparent passthrough and interactive wrapping based on execution mode, TTY context, and runtime-discovered capabilities. Interactive behavior depends on capabilities, not on a fixed list of known commands.

Pros:

- Best forward compatibility
- Natural fit for "replace `codex` with `ccx`"
- Clear separation between safe passthrough and smart wrapping

Cons:

- Requires more careful architecture
- Needs explicit capability probing and stronger boundaries

### Recommendation

Choose Option C.

This is the only option that scales with Codex updates without turning `ccx` into a permanent compatibility chase.

## Proposed Architecture

### 1. Invocation Classifier

Purpose:

- Inspect argv, TTY state, and discovered Codex capabilities.
- Decide one of three outcomes:
  - transparent passthrough
  - interactive wrapped session
  - explicit refusal to start

Rules:

- Non-TTY or clearly non-interactive commands go to passthrough.
- Interactive invocations go to wrapped mode only if required capabilities are present.
- Ambiguous invocations that cannot be classified safely fail fast with a clear error.

This layer should remain small and deterministic. It must not contain account-switching logic.

### 2. Transparent Codex Runner

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

This is the compatibility backbone. If a Codex update adds a new non-interactive command, `ccx` should inherit support automatically through this lane.

### 3. Interactive Session Supervisor

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

### 4. Smart Actions Engine

Purpose:

- Orchestrate smart account behavior without owning the transport.
- Ask `cdx` for recommendation or switching actions.
- Drive resume/autosubmit behavior after an exhaustion event.

Responsibilities:

- trigger switch flow on confirmed exhaustion
- call the internal `cdx` smart-switch operation
- reopen or resume the session
- restore or autosubmit the pending prompt
- emit additive banners for state transitions

This isolates business logic from PTY mechanics.

## Capability and Trust Model

`ccx` should consume information in descending order of trust:

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
- no banners
- no wrapping-specific logging on user-facing streams

Success criterion:

- the user should not be able to tell they ran `ccx` instead of `codex`, except by inspecting the parent process.

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
- add visual enhancements such as prompt highlighting, restrained green `CCX` branding, and switch banners

Core behaviors:

- session correctness
- input forwarding
- prompt continuity
- safe switching
- native signal behavior
- native shortcut semantics

Optional behaviors:

- prompt highlighting
- startup `CCX` banner
- restrained green `CCX` accenting on wrapper-originated UI
- decorative switch status UI
- local diagnostics

Optional behaviors must be individually disableable and must never jeopardize core correctness.

### Mode C: Refuse to Start

Conditions:

- invocation appears interactive
- but required wrapping capabilities are missing or uncertain

Behavior:

- print a clear error
- exit without launching Codex

This matches the product requirement that `ccx` must not start in a half-supported state.

## Failure Model

The system should degrade by feature tier, not collapse globally.

### Allowed localized failures

- prompt highlighting fails -> session continues without highlighting
- switch banner formatting fails -> session continues without banner
- non-essential `CCX` branding fails -> session continues without branding
- non-essential diagnostics fail -> session continues silently

### Hard-stop failures

- invocation cannot be classified safely
- required capability for interactive wrapping is missing
- session supervision cannot preserve native controls reliably

In these cases, `ccx` must fail before starting the wrapped session.

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
  - may affect optional styling, but must not break core wrapper behavior

## Component Boundaries

The current codebase already hints at useful boundaries. The target architecture should formalize them further.

### Stable core modules

- invocation classification
- codex process launching
- PTY supervision
- terminal state restore
- signal forwarding

### Smart modules

- account recommendation and switching
- exhaustion detection orchestration
- prompt persistence and autosubmit

### Sacrificial modules

- prompt highlighting
- startup branding
- decorative status lines

Sacrificial modules may be disabled automatically if they threaten correctness.

## Testing Strategy

### Contract tests

- `ccx` passthrough matches `codex` for representative non-interactive commands
- exit codes are preserved
- stdout/stderr behavior is preserved

### Classification tests

- interactive vs non-interactive classification
- ambiguous invocation refusal
- capability-driven decision making

### Interactive correctness tests

- normal startup
- `resume`
- session reuse after switch
- autosubmit after exhaustion
- prompt continuity
- signal and key behavior (`Esc`, arrows, `Ctrl+C`)
- Codex-identical double-`Ctrl+C` semantics
- branding remains visible without changing interactive control flow

### Resilience tests

- delayed session discovery
- delayed usage-limit signal
- stale session log data
- redraw-heavy prompt rendering

### Degradation tests

- loss of prompt-highlighting adapter does not break the session
- partial switch-feature failure does not break terminal input

## Rollout Strategy

### Phase 1: Formalize the lanes

- make passthrough and interactive wrapped mode explicit
- isolate invocation classification
- define the refusal path clearly

### Phase 2: Capability registry

- add runtime capability probing
- move command assumptions out of ad-hoc branches

### Phase 3: Adapter hardening

- move session and prompt dependencies behind interfaces
- reduce direct coupling to specific Codex internal files

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

## Decision Summary

Build `ccx` as a transparent compatibility shell around `codex` with a strict two-lane runtime model:

- transparent passthrough for non-interactive commands
- guarded interactive wrapping for safe TUI sessions

Use capability discovery and adapter isolation to keep the design scalable as Codex evolves. Treat prompt styling and other visual enhancements as optional add-ons, not as foundations of correctness.
