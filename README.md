# cdx (Codex Account Switcher)

Interactive account switching for Codex CLI.

Run:

```bash
cdx
```

`cdx` opens an interactive menu for:
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
- `ccx` (smart Codex wrapper)

## Smart Switching

`cdx` can now evaluate live account limits and switch to the best account automatically.

Interactive:

```bash
cdx
```

then choose `Smart switch`.

Non-interactive JSON output:

```bash
cdx smart-switch --json
```

## ccx

`ccx` is a lightweight wrapper around the real `codex` CLI.

Run:

```bash
ccx
```

Current behavior:
- launches the real `codex` using your normal `~/.codex`
- keeps Codex config, skills, sessions, and MCP setup intact
- on `Enter`, checks the latest session rate limits before forwarding the prompt
- if the active account is exhausted, runs `cdx smart-switch --json`
- reopens the conversation with `codex fork <sessionId>`
- restores the pending prompt in the reopened conversation without sending it automatically

Current limitations:
- it is optimized for normal interactive use, not scripted `codex` prompts passed on the CLI
- it does not auto-submit the restored prompt

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
- Legacy subcommands (`cdx use ...`, `cdx save ...`, etc.) are removed.
- If an email can be detected from an account's auth file, `cdx` shows it in labels (for example, `work <name@company.com>`).
