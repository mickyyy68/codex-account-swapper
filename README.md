# cdx (Codex Account Switcher)

Transparent Codex wrapper with conservative autoswitch on real usage exhaustion.

Run:

```bash
cdx
```

`cdx` opens the wrapped Codex session.

Use:

```bash
cdx manual
```

to open the account manager for:
- Smart switch
- Account list (Enter activates, Space adds, Tab renames, Del removes)
- Add account (launches Codex login in the browser, then reopens Account list)
- CDX settings
- Exit

Account list sorts accounts by the 5h limit (most remaining on top); the
cursor starts on the best candidate. Space launches the Codex login flow
in your browser and saves the resulting auth as a new account; leaving the
name empty auto-assigns the smallest unused integer.

## Install

```bash
npm i -g codex-account-switcher
```

or

```bash
bun add -g codex-account-switcher
```

Commands installed:
- `cdx`
- `cxs` (alias of `cdx`)
- `ccx` (legacy compatibility entrypoint for the same wrapper core)

## Smart Switching

`cdx` can now evaluate live account limits and switch to the best account automatically.

Interactive:

```bash
cdx manual
```

then choose `Smart switch`.

Non-interactive JSON output:

```bash
cdx smart-switch --json
```

## CDX Settings

Open:

```bash
cdx manual
```

then choose `CDX settings`.

Currently supported:
- `Access mode`
- Values: `Read Only`, `Default` (selected by default), `Full Access`

`cdx` injects the saved access mode by default when launching Codex:

- `Read Only` → `codex --sandbox read-only --ask-for-approval never`
- `Default` → `codex` (no flags injected)
- `Full Access` → `codex --sandbox danger-full-access --ask-for-approval never`

Explicit CLI `-a ...` / `--ask-for-approval ...` / `-s ...` / `--sandbox ...` overrides win.

## Minimal Autoswitch Mode

`cdx` is intentionally conservative in the interactive path.

During autoswitch:
- exhaustion is detected from structured session state
- `cdx` stops the current session
- switches account
- resumes the exact same `sessionId`
- verifies that the reopened session is the same one

`cdx` does not:
- restore the last prompt
- autosubmit anything
- fall back to `fork`
- guess when session identity is uncertain

Current behavior:
- launches the real `codex` using your normal `~/.codex`
- keeps Codex config, skills, sessions, and MCP setup intact
- on startup, auto-registers the current auth as the first free numeric account if it is not saved yet
- automatically switches accounts after confirmed usage exhaustion
- resumes only the same session after autoswitch, or stops with an error

## Before Setup

Make sure Codex stores auth in a file (`auth.json`):

```bash
codex -c 'cli_auth_credentials_store="file"' login
```

## Storage

`cdx` reads/writes:
- `~/.cdx/accounts.json`
- `~/.cdx/active`
- `~/.cdx/auth/*.auth.json`
- `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`)

## One-time Migration

On first interactive run, `cdx` checks legacy `~/.cdx/accounts.tsv` and imports it into `~/.cdx/accounts.json` when needed.
It writes a marker file when migration is finalized (for example after import, or when `accounts.json` is already non-empty):

- `~/.cdx/.migration_accounts_tsv_v1.done`

## Notes

- Interactive terminal required (TTY) for interactive commands.
- Most non-interactive runs exit with an error. `cdx smart-switch --json` is the supported exception.
- `cdx smart-switch --json` is the only supported non-interactive subcommand.
- `cdx manual` is the interactive account manager entrypoint.
- If an email can be detected from an account's auth file, `cdx` shows it in labels (for example, `work <name@company.com>`).

## Troubleshooting Autoswitch

`cdx` logs wrapper events to `~/.cdx/cdx.log` (JSONL). Useful events when the autoswitch does not trigger on exhaustion:

- `session_state_snapshot` — what the observer saw in the session JSONL (error code, rate limits, credits). A snapshot with a non-empty `errorCode` or `primaryUsedPercent >= 100` but no subsequent `usage_watch_fired` indicates a missed pattern.
- `live_fallback_check` — periodic live rate-limit probe on the active account (independent from the session JSONL).
- `live_fallback_exhausted` / `usage_watch_fired` — the detector triggered.
- `tui_usage_limit_detected` — the rendered TUI stream matched a usage-limit error that Codex does not write to the session JSONL (e.g. `Error running remote compact task: ... usage limit`). The wrapper autoswitches from this signal when both the JSONL and the live probe miss it.

Tune the live fallback interval (default 90s) with `CDX_LIVE_FALLBACK_INTERVAL_MS=<ms>`. Set it to `0` to disable.
