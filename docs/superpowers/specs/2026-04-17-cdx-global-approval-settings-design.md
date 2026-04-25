# CDX Global Approval Settings Design

## Goal

Add a global `CDX settings` section to `cdx manual` so the user can choose the Codex approval policy once and have `cdx` launch interactive Codex sessions with that policy automatically.

This setting is global, not per-account.

## Scope

In scope:

- Add a new `CDX settings` action inside `cdx manual`
- Add a new `Approval policy` setting
- Support the three standard Codex approval policies:
  - `untrusted`
  - `on-request`
  - `never`
- Persist the chosen value in `~/.cdx`
- When launching Codex through `cdx`, automatically pass `-a <policy>` if the user did not already specify an approval policy explicitly in the CLI arguments

Out of scope:

- Per-account approval settings
- Any attempt to persist or replay per-command approvals granted inside a Codex session
- Changes to Codex's own `~/.codex/config.toml`
- Additional settings beyond `Approval policy`

## User Experience

### Manual Menu

`cdx manual` gains a new top-level action:

- `CDX settings`

Inside that section, there is initially one setting:

- `Approval policy`

The user can select one of:

- `untrusted`
- `on-request`
- `never`

The settings menu should show the current saved value clearly.

### Runtime Behavior

When the user launches:

- `cdx`
- `cdx resume ...`
- `cdx fork ...`
- or any other wrapper-routed Codex invocation

`cdx` should:

1. read the global saved approval policy from `~/.cdx`
2. check whether the current CLI invocation already contains an explicit approval policy
3. if no explicit approval policy is present, inject `-a <saved-policy>` into the Codex launch arguments
4. if an explicit approval policy is already present, leave the launch arguments unchanged

This keeps the saved policy as the default while preserving transparent CLI override semantics.

## Precedence Rules

The precedence must be:

1. explicit CLI approval policy passed by the user
2. saved global `CDX` approval setting
3. Codex default behavior if no saved setting exists yet

This avoids surprising the user when they intentionally launch:

- `cdx -a never`
- `cdx --ask-for-approval untrusted`

## Storage

Store the new setting under `~/.cdx` in a dedicated settings file, separate from accounts.

Recommended file:

- `~/.cdx/settings.json`

Initial schema:

```json
{
  "approvalPolicy": "on-request"
}
```

Rules:

- missing file is valid
- malformed file should not crash `cdx`
- invalid values should be ignored and treated as unset
- writes should preserve future extensibility for additional global settings

## Validation

Valid values are exactly:

- `untrusted`
- `on-request`
- `never`

Any other value must be treated as invalid and ignored at runtime.

## Integration Points

### Manual UI

The existing manual interactive menu in `bin/cdx.js` should gain:

- a `CDX settings` action in the top-level menu
- a small settings flow for reading, editing, and saving `approvalPolicy`

### Codex Launch Path

The wrapper launch path should inspect forwarded args before calling Codex.

It must detect both forms:

- `-a <value>`
- `--ask-for-approval <value>`

If either is already present, the saved setting must not be injected.

## Error Handling

If settings cannot be read:

- do not fail the launch
- continue without injecting a policy

If settings cannot be written from `cdx manual`:

- show a clear error in the manual UI
- do not partially claim success

## Testing

Minimum coverage:

- manual settings read/write roundtrip
- invalid settings file does not crash runtime
- saved approval policy is injected when no CLI override is present
- no injection occurs when `-a ...` is already present
- no injection occurs when `--ask-for-approval ...` is already present
- missing settings file leaves launch behavior unchanged

## Recommendation

Implement this as a small global settings layer in `~/.cdx/settings.json`, with launch-time argument injection only.

Do not attempt to persist or replay per-session granular approvals. The only supported permissions behavior is selecting the default Codex approval policy before launch.
