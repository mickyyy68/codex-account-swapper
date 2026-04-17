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
- Use account
- Switch account
- Save current auth as account
- Add account from auth file
- Rename account
- Swap account order
- Remove account
- List accounts

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
- `ccx` (legacy alias of `cdx`)

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

## ccx

`ccx` still exists as a legacy alias, but `cdx` is the canonical command.

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

- Interactive terminal required (TTY). Non-interactive runs exit with an error.
- `cdx smart-switch --json` is the only supported non-interactive subcommand.
- `cdx manual` is the interactive account manager entrypoint.
- If an email can be detected from an account's auth file, `cdx` shows it in labels (for example, `work <name@company.com>`).
