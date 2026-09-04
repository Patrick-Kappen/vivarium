# Environment Variables

Pi uses environment variables in three ways:

- Variables such as `PI_OFFLINE` configure the Pi process.
- Pi sets process markers so child processes can identify Pi as the launching agent.
- Commands run by the LLM-callable shell tools receive `PI_*` variables describing the current session.

Provider API-key variables are documented separately in [Providers](providers.md#environment-variables-or-auth-file).

## Process Marker

The CLI and RPC entry points set two process markers:

- `AI_AGENT=pi` is a generic marker that lets tooling identify Pi as the agent that launched the process.
- `PI_CODING_AGENT=true` is Pi-specific and lets child processes detect that they run inside Pi.

Child processes inherit both markers. They are not session-specific and are not set automatically when Pi is embedded through the SDK.

## Shell Tool Session Environment

Commands run by the `bash` and `powershell` tools receive the current Pi session state:

| Variable | Description |
|----------|-------------|
| `PI_SESSION_ID` | Current session ID |
| `PI_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `PI_PROVIDER` | Currently selected model provider |
| `PI_MODEL` | Currently selected model ID |
| `PI_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting Pi. `PI_PROVIDER` and `PI_MODEL` identify the selected Pi model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$PI_PROVIDER" "$PI_MODEL"
printf 'reasoning=%s session=%s\n' "$PI_REASONING_LEVEL" "$PI_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$PI_SESSION_FILE" ]; then
  tail -n 1 "$PI_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable `bash` and `powershell` tools. They are not injected into user-entered `!` or `!!` commands.

### Custom Shell Tools

Tools created with `createBashTool()` or `createPowerShellTool()` expose the session environment by default when registered with Pi. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, Pi removes inherited values for these variables so nested Pi processes do not expose stale parent-session metadata.

## Pi Process Configuration

These variables are read by Pi itself:

| Variable | Description |
|----------|-------------|
| `PI_CODING_AGENT_DIR` | Override the config directory; default is `~/.pi/agent` |
| `PI_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `VIVARIUM_SETTINGS_PATH` | Select an explicit `settings.json` input independent of `PI_CODING_AGENT_DIR`; see [Managed configuration inputs](#managed-configuration-inputs) |
| `VIVARIUM_MODELS_PATH` | Select an explicit `models.json` input independent of `PI_CODING_AGENT_DIR`; see [Managed configuration inputs](#managed-configuration-inputs) |
| `VIVARIUM_MANAGED` | Set to `1` to mark the current profile externally managed and make its effective global settings read-only; see [Managed configuration inputs](#managed-configuration-inputs) |
| `PI_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `PI_SERVER_DIR` | Override the experimental server profile and socket directory; default is `~/.pi/server` |
| `PI_SERVER_ID` | Select the logical experimental server ID when `--server-id` is omitted |
| `PI_OFFLINE` | Disable startup network operations, including update checks, package updates, and install/update telemetry |
| `PI_SKIP_VERSION_CHECK` | Disable the `pi.dev` latest-version request |
| `PI_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `PI_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `PI_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
| `PI_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `PI_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
| `PI_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
| `PI_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
| `PI_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and cloud-provider configuration are listed in [Providers](providers.md#environment-variables-or-auth-file).

## Managed Configuration Inputs

Vivarium deployments can separate operator-supplied configuration from writable runtime state. The agent directory (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) always stays writable and holds `auth.json`, trust state, `models-store.json`, managed bookkeeping state and other runtime state. When the following variables are set, the `settings.json` and `models.json` inputs are loaded from explicit locations instead:

| Variable | Behavior |
|----------|----------|
| `VIVARIUM_SETTINGS_PATH` | Absolute path to the `settings.json` input. Pi loads global settings from this file instead of `PI_CODING_AGENT_DIR/settings.json`. |
| `VIVARIUM_MODELS_PATH` | Absolute path to the `models.json` input. Pi loads the model configuration from this file instead of `PI_CODING_AGENT_DIR/models.json`, including for `pi update --models`. The `models-store.json` cache stays in the writable agent directory. |
| `VIVARIUM_MANAGED` | `1` marks the current profile as externally managed. Its effective global settings input is read-only, whether selected with `VIVARIUM_SETTINGS_PATH`, supplied by an embedding caller, or resolved under `PI_CODING_AGENT_DIR`. Changes made through `/settings`, saved model defaults (Ctrl+S in `/model`), and saved thinking defaults (Ctrl+S in `/thinking`) apply for the session but are never persisted; Pi records a settings error instead. Managed mode discovers no `SYSTEM.md` or `APPEND_SYSTEM.md` at all, neither from the writable agent directory nor from a trusted project's `.pi` directory: the managing profile owns the system prompt and may only extend or replace it through explicit `--append-system-prompt` and `--system-prompt` inputs. |

A path selected through `VIVARIUM_SETTINGS_PATH` or `VIVARIUM_MODELS_PATH`
must exist. Pi treats a missing explicit input as a deployment error and does
not create the file or its parent directory. The implicit settings and models
files under `PI_CODING_AGENT_DIR` remain optional when no explicit path is set.

Managed interactive sessions store only their last-seen changelog version in
`PI_CODING_AGENT_DIR/managed-state.json`. This prevents repeated changelog and
install-telemetry bookkeeping after an engine update without making the
operator-supplied settings input writable. The runtime state file does not
contain operator settings or credentials; malformed state is reported and
preserved.

Managed mode also makes legacy credential migration explicit. If `auth.json`
is absent while the writable agent directory contains `oauth.json` or
`settings.json.apiKeys`, an interactive session asks whether to import the
legacy credentials, start with an empty `auth.json`, or cancel. A
non-interactive session stops without changing auth state and directs the
operator to `pi auth migrate`. Metadata commands such as `--help`, `--version`
and `--list-models` neither prompt nor initialize `auth.json`. When no legacy
credentials exist, the normal auth runtime creates an empty owner-only file when
it is first needed. Empty legacy objects do not block startup. Malformed legacy
credential files are reported and preserved; a concurrent startup that already
created `auth.json` is treated as initialized rather than as a migration
failure.

`VIVARIUM_SETTINGS_PATH` and `VIVARIUM_MODELS_PATH` select inputs; they do not enable managed mutation policy by themselves. `VIVARIUM_MODELS_PATH` also keeps the writable `models-store.json` cache in the agent directory instead of beside the explicit model input. When all three variables are absent, Pi behaves exactly as upstream: `settings.json` and `models.json` are read from and written to the agent directory, and global `SYSTEM.md`/`APPEND_SYSTEM.md` files in the agent directory are honored.
