# cdx (Codex Account Switcher)

Interactive account switching for Codex CLI.

Run:

```bash
cdx
```

`cdx` opens an interactive menu for:
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
- Legacy subcommands (`cdx use ...`, `cdx save ...`, etc.) are removed.
- If an email can be detected from an account's auth file, `cdx` shows it in labels (for example, `work <name@company.com>`).
