# CDX Stability Redesign

Date: 2026-04-16
Status: Approved
Author: Codex

## Goal

Stabilize `cdx` so it behaves like a transparent `codex` wrapper for interactive sessions while preserving automatic account switching on confirmed usage exhaustion.

The redesign explicitly prioritizes:

- native Codex shortcut behavior
- no wrapper-induced lag
- no accidental loss or reinterpretation of user input
- autoswitch as the only mandatory "magic"

## Problem Statement

The current wrapper mixes too many responsibilities inside the input/output path:

- it interprets `Enter` semantically
- it reconstructs user intent from visible TUI output
- it performs stream-aware styling and footer rewriting on every output chunk
- it couples autosubmit and autoswitch to mutable wrapper-local state

This causes three recurring failure classes:

1. input failures
   - approvals are mistaken for prompt submits
   - `Esc`, arrows, and history become unreliable
2. output failures
   - lag from buffering and transform pipelines
   - prompt highlighting glitches and lost redraw context
3. state failures
   - wrapper-local assumptions diverge from real Codex session state

## Core Decision

`cdx` must become almost fully transparent in the interactive path.

It should no longer infer meaning from every `Enter`, prompt repaint, or visible footer line. The wrapper should act only when it has a strong exhaustion signal from a stable source such as session logs / structured session state.

## Non-Negotiable Requirements

- `cdx ...` must keep the same command surface as `codex ...`
- interactive shortcuts must remain identical to Codex
- the wrapper must not introduce visible lag
- autoswitch must remain enabled
- autoswitch must trigger only after strong exhaustion confirmation
- the canonical prompt source after exhaustion must be session state (`user_message`), not visible TUI text

## Required Tradeoff

To restore stability, optional "magic" may be reduced or temporarily removed from the critical path:

- autosubmit after switch is optional
- prompt highlighting is optional
- footer badges / banners are optional
- decorative branding in the wrapped TUI is optional

If any of these threaten correctness, they must be disabled before shipping the stabilized path.

## New Runtime Model

### 1. Input lane

Responsibility:

- forward terminal input to Codex

Rules:

- no semantic interpretation of `Enter`
- no prompt reconstruction in the input path
- no autoswitch decision in the input path

### 2. Output lane

Responsibility:

- forward Codex output with minimal or no transformation

Rules:

- output must remain near-pass-through
- complex styling and redraw-aware transforms are not allowed in the critical path

### 3. Observer lane

Responsibility:

- observe session logs / structured state
- detect:
  - `sessionId`
  - `user_message`
  - `usage_limit_exceeded`

Rules:

- use session/log adapters as the source of truth
- do not rely on visible TUI parsing except as last-resort diagnostics

### 4. Switch orchestrator

Responsibility:

- react to confirmed exhaustion
- run smart switch
- resume the session
- restore prompt context from canonical session state

Rules:

- depends only on strong identifiers and structured state
- must not depend on repaint timing or prompt visibility

## Behavioral Contract

### Normal interactive flow

- `cdx` behaves like Codex
- input and output remain transparent
- optional styling must not affect correctness

### Exhaustion flow

1. user submits a prompt normally
2. observer confirms exhaustion from session state
3. switch orchestrator runs smart switch
4. wrapper resumes the session
5. wrapper restores the last canonical user prompt

For the stabilization version, prompt restoration is required. Autosubmit is explicitly optional and may remain disabled until the core is stable.

### Failure handling

- if optional visual features fail, disable them locally
- if autoswitch logic cannot prove exhaustion, do nothing
- if wrapping safety is compromised, fail clearly instead of running a half-broken wrapper

## Scope of the Redesign

### In scope

- simplify the interactive runtime
- remove fragile prompt inference from the critical path
- preserve autoswitch using strong signals only
- isolate observer and switch orchestration from PTY transport
- reduce or disable fragile visual transforms by default

### Out of scope for the first stabilization pass

- richer styling of prompt history
- always-on autosubmit after switch
- fancy branding inside the wrapped TUI
- TUI-driven approval awareness beyond transparent pass-through

## Migration Strategy

### Phase 1: Stabilize

- strip fragile input/output logic out of the critical path
- keep autoswitch
- disable anything that threatens transparency

### Phase 2: Harden

- verify native Codex controls exhaustively
- verify non-interactive passthrough remains identical
- verify `resume` / `fork` / session reuse remain stable

### Phase 3: Reintroduce optional features carefully

- prompt restore polish
- autosubmit, only if it can be proven not to interfere with shortcuts or approvals
- visual enhancements only as sacrificial modules

## Success Criteria

The redesign is successful when:

- `cdx` no longer lags in normal interactive use
- approvals and shortcuts behave like Codex
- no prompt or state is "randomly" lost by wrapper logic
- autoswitch still works on real exhaustion
- optional wrapper visuals can be disabled without affecting core correctness
