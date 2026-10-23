# Régis

**A local-first personal command center: mail, calendar, ERP, files and notes in one desktop app, with AI agents kept under human control.**

[![CI](https://github.com/chwazy/regis/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/chwazy/regis/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/chwazy/regis)](https://github.com/chwazy/regis/releases/latest)
[![License: MIT](https://img.shields.io/github/license/chwazy/regis)](LICENSE)

Régis is a desktop app (Tauri 2, Rust, React) that brings together your Microsoft 365 mail and calendar,
Odoo, your files and a "second brain" of notes and facts, and lets AI agents (Claude Code, the Anthropic
API, Ollama, ACP agents) work on them. Every write an agent wants to make goes through a tool policy
(`auto` / `ask` / `deny`) and, when needed, your explicit approval.

Everything runs on your machine. The database, the file index, voice transcription and semantic search are
local; nothing is hosted by the project. Data only leaves your PC when you use a remote agent (Claude Code
or the Anthropic API) or a connector that talks to its own service (Microsoft 365, Odoo).

> **Status**: pre-1.0, built for and tested on Windows 11. macOS and Linux build from source but are not
> tested. The UI is in French.

## Features

- **Daily brief**: today's meetings, mail to handle, Odoo hours, written by an agent from your data.
- **Customizable dashboard**: widgets fed by the connectors and the brain.
- **Brain**: notes, entities (clients, projects, contacts) and facts, with full-text and optional local
  semantic search (`bge-m3` through Ollama).
- **Agents**: Claude Code CLI (headless), Anthropic API, Ollama and ACP agents, with routing rules,
  jobs, an interactive terminal mode, and a tool policy with an approval queue.
- **Connectors as MCP servers**: Microsoft 365, Odoo (built-in server), file system, or any MCP server.
- **Documents**: Word templates filled by agents, file sources indexed in place (Régis never writes to
  your watched folders).
- **Voice and meetings** (Windows): dictation in any input field, Teams meeting join, meeting recording
  with consent, local transcription (whisper.cpp) and minutes.

## Install (Windows 11)

1. Download `Regis_<version>_x64-setup.exe` from the [latest release](https://github.com/chwazy/regis/releases/latest).
   Each installer comes with a `.sha256` checksum and a GitHub build provenance attestation:
   `gh attestation verify <file> --repo chwazy/regis`.
2. Run it. It installs for the current user, without admin rights. The installer is not code-signed yet,
   so SmartScreen shows a warning: *More info* → *Run anyway*.
3. A first-run assistant checks the optional prerequisites: [Ollama](https://ollama.com) with
   `ollama pull bge-m3` (embeddings, local agent) and the [Claude Code](https://claude.com/claude-code) CLI.

Data (database, Régis's own files) lives in `%APPDATA%\io.github.chwazy.regis`, or in the folder chosen in
*Réglages*. Secrets are stored in the OS credential vault (service `regis`), never in the database.

**Uninstall**: *Settings › Apps › Régis*. Data and secrets are kept unless you tick the "delete application
data" box in the uninstaller. Nothing is deleted during an update.

**macOS / Linux**: build from source (`npm run build`), see [docs/development.md](docs/development.md).

## Build from source

Requirements: Node.js ≥ 22.22, Rust ≥ 1.90, CMake and LLVM/libclang (for whisper.cpp), plus the Tauri
platform prerequisites (on Windows: Visual Studio Build Tools with C++, WebView2).

```bash
npm ci            # install all workspaces
npm run doctor    # check the prerequisites of this PC
npm run dev:demo  # run the app on a throwaway demo database
npm run build     # build the installer for the current OS
```

The full guide (commands, environment variables, external accounts, project layout) is in
[docs/development.md](docs/development.md).

## Documentation

- [docs/development.md](docs/development.md): development setup and commands.
- [docs/architecture.md](docs/architecture.md): architecture, design decisions and project rules.
- [docs/design/brand/](docs/design/brand/): logo and tray icons.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and report security issues
privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Régis does not ship any AI model: Ollama models and the whisper model are downloaded on
demand, with your consent, and remain under their own licenses.
