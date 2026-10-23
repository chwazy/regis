# Development guide

## Prerequisites

Checked by `npm run doctor` (exit code 1 when Node, Rust, the C toolchain or WebView2 are missing).

| Prerequisite | Required | Notes |
|---|---|---|
| Node.js ≥ 22.22 LTS + npm | yes | |
| Rust stable ≥ 1.90 (`rustup`) | yes | |
| CMake and LLVM (libclang) | yes | build of whisper.cpp (`whisper-rs`); set `LIBCLANG_PATH` if libclang is not found |
| Windows: Visual Studio Build Tools (C++), WebView2 | yes | WebView2 ships with Windows 11 |
| macOS: Xcode CLT · Linux: Tauri's webkit2gtk dependencies | on those OSes | |
| Ollama + `ollama pull bge-m3` | recommended | embeddings and local agent |
| Claude Code CLI, signed in (`claude`) | recommended | main agent |
| Microsoft Word (Windows) | optional | PDF export of templates |
| Anthropic API key | optional | API agent, entered in the app (OS vault) |

## Commands

```bash
npm ci                       # install all workspaces
npm run doctor               # check the prerequisites
npm run dev                  # Tauri window in dev mode (Vite + Rust + sidecar on Node)
npm run dev:demo             # same, on a throwaway demo database with a simulated Claude agent
npm run dev:demo:onboarding  # demo with the first-run assistant forced
```

| Command | Effect |
|---|---|
| `npm run typecheck` | `tsc` on every workspace |
| `npm run lint` | eslint, prettier, `cargo clippy -- -D warnings`, `cargo fmt --check` |
| `npm test` | vitest + `cargo test` (the Rust sidecar tests need `node`) |
| `npm run format` | prettier + `cargo fmt` |
| `npm run build` | sidecar binaries (`@yao-pkg/pkg`), then the Tauri bundle for the current OS; no cross-compilation |
| `npm run measure:build` | measures Rust build times (`-- --runs N`, `--full`, `--timings`) |

`npm run build` produces `apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe` on Windows,
`app,dmg` on macOS and `appimage,deb` on Linux. The first build downloads the Node base binary used by
`pkg` (network access required).

On Windows the linker is `rust-lld` (shipped with the Rust toolchain, set in `.cargo/config.toml`)
instead of `link.exe`.

## Faster builds (optional)

[sccache](https://github.com/mozilla/sccache) reuses compiled dependencies across several `target/`
folders (worktrees, clones, `cargo clean`). It is never required and no build file (`.cargo/config.toml`,
`Cargo.toml`) references it; without it the build behaves exactly as usual.

```bash
cargo install sccache --locked
```

Enable it through the environment only:

```powershell
$env:RUSTC_WRAPPER = "sccache"        # PowerShell, current session
```

```bash
export RUSTC_WRAPPER=sccache          # bash
```

`cc` (SQLite, `sqlite-vec`) picks the wrapper up automatically. Check with `sccache --show-stats`
(cache hits grow on the second build of a fresh `target/`) or `npm run doctor` (optional sccache line).
To disable it, unset the variable (`Remove-Item Env:RUSTC_WRAPPER` or `unset RUSTC_WRAPPER`). A
`RUSTC_WRAPPER` pointing to a missing binary fails every build, so unset it if you uninstall sccache.

Limits:

- No gain on incremental builds of the app crate (sccache skips incremental compilation): editing
  and rebuilding is not faster.
- The gain shows on a fresh `target/` and needs a stable `target/` path to hit the Rust cache.
- whisper.cpp (`whisper-rs-sys`, built by CMake with the Visual Studio generator) is not cached.
- If a build fails with stale artifacts after renaming a crate, clear the cache (`SCCACHE_DIR`).

## Environment variables

See `.env.example`.

| Variable | Effect |
|---|---|
| `REGIS_DATA_DIR` | data folder (the `regis.sqlite` database is created there); overrides the folder chosen in the app |
| `REGIS_CLAUDE_BIN` | path to the Claude Code CLI when it is not on `PATH` |
| `REGIS_LOG` | log level of the Rust backend: `error`, `warn`, `info`, `debug` |

## External accounts

- **Microsoft 365**: device-code sign-in through `ms-365-mcp-server`. If your tenant blocks user consent,
  ask for admin consent or register your own Entra ID app (public client) and enter its client ID in the
  connector (passed to the server as `MS365_MCP_CLIENT_ID`; `MS365_MCP_TENANT_ID` for the tenant).
  In Entra ID › App registrations › New app: platform "Mobile and desktop applications" (public client,
  device-code flow allowed), delegated permissions `Mail.Read` and `Calendars.Read`. The token stays in the
  OS vault managed by the server, never in Régis's database.
- **Odoo (SaaS / Odoo.sh ≥ 17)**: URL, database, login and an **API key** (Preferences › Account
  security). External API access may depend on your Odoo subscription.

## Agent routing

A job created without an agent goes to the first agent matched by the rules of the *Agents* screen. When no
rule applies, a "router" agent (setting `routing.routerAgentId`, the Ollama agent by default) receives the
task and the "use this agent when…" hints of the eligible agents. The router is local by default: the task
text only leaves your PC if you pick a remote router yourself. A "local only" rule never routes to Claude
Code or the Anthropic API, which send their data to Anthropic.

## Project layout

```
apps/desktop/src/        React front end
apps/desktop/src-tauri/  Cargo workspace: app regis-desktop (Tauri commands, PTY) and crates/
                         regis-model, regis-core (database, files, sidecar), regis-stt-whisper, regis-voice
sidecar/                 @regis/sidecar: MCP host, agents, policy, jobs, built-in MCP servers
packages/shared/         @regis/shared: RPC and event types, types generated from Rust (ts-rs)
scripts/                 doctor, builds, fixture capture
tests/                   fixtures, fake binaries, fake MCP and Odoo servers
docs/                    architecture, development guide, brand assets
```

Design decisions, conventions and project rules are in [architecture.md](architecture.md).

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please): merging
conventional commits into `main` keeps a release pull request up to date (version bump and changelog).
Merging that pull request tags the version, creates the GitHub release, and the `Release` workflow builds
the Windows installer and attaches it with its checksum. See [CONTRIBUTING.md](../CONTRIBUTING.md).
