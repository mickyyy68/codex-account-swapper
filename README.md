# cdx (Codex Account Switcher)

Switch between Codex CLI accounts quickly with:

```bash
cdx switch
```

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

## Quick Setup

1. Login to account A and save it:

```bash
codex login
cdx save personal
```

2. Login to account B and save it:

```bash
codex logout
codex login
cdx save work
```

3. Switch:

```bash
cdx switch
```

## Usage

```bash
cdx list
cdx current
cdx use work
cdx rename work main
cdx switch
cdx swap 1 2
cdx remove work
```

## How It Works

`cdx` copies the selected account auth file into:

- `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`)

State is stored in:

- `~/.cdx/accounts.json`
- `~/.cdx/active`
- `~/.cdx/auth/*.auth.json` (created by `cdx save`)
