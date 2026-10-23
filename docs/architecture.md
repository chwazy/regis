# Architecture and rules

## Overview

- **`regis-desktop`** (Rust, Tauri 2) owns the SQLite database, the file sources (watch, extraction,
  indexing), the scheduler, the secrets, the terminal (PTY), audio capture and transcription, and supervises
  the sidecar.
- **`@regis/sidecar`** (Node.js, compiled to a single binary for releases) hosts the MCP connectors, the
  agent drivers, the tool policy and approvals, jobs, routing, the brief, the brain and the built-in MCP
  servers.
- **Front end** (React, Vite) talks to Rust through Tauri commands only.
- Rust and the sidecar speak JSON-RPC 2.0 over NDJSON on stdin/stdout; stderr is for logs. Sidecar events
  (`method: "event"`) are re-emitted to the front end on `regis://event`.

## Design decisions

- **Rust is the only owner of the database.** The sidecar reads and writes through the `store.*` host
  methods: one source of truth, one writer, no concurrent locks.
- **`links` is the only source of truth for relations** between items, files and entities. No foreign IDs
  or ID arrays duplicated on other tables.
- **Connectors are MCP servers.** The dashboard, the brain and the agents use the same tools, named
  `mcp__<connector>__<tool>`. Odoo goes through a built-in MCP server (external JSON-RPC API with an API
  key), because the existing server needs a module that cannot be installed on Odoo SaaS.
- **Every agent write goes through the tool policy** (`auto` / `ask` / `deny`, resolved per agent then by
  default, most specific pattern wins; reads fall back to `auto`, writes to `policy.defaultWrite`, which is
  `ask` or `deny`, never `auto`). `ask` creates an approval, deferred after `approvals.waitTimeoutSec`.
- **Claude Code is driven through its CLI** in headless mode, so it keeps its own sign-in. Permissions go
  through `--permission-prompt-tool mcp__regis__approve`, `auto` and `deny` through `--allowedTools` /
  `--disallowedTools`.
- **External formats come from captured fixtures** (`tests/fixtures/`), never from documentation. Tests
  replay them, for example through `tests/fake-bins/claude`.
- **"Local only" means Ollama.** Claude Code runs locally but sends data to Anthropic, so the `claude-cli`
  and `anthropic-api` agents are never local only.
- **Secrets live in the OS vault** (`keyring`, service `regis`); the database only stores `secret_ref`s.
- **Local modules (voice, semantic search) are off by default** and turned on only once their model is
  downloaded, with the user's consent. Embeddings use `bge-m3`; the 1024 dimension of `chunks_vec` changes
  only with a migration and a re-index.
- **Audio stays local and in Rust.** Microphone and system sound (WASAPI loopback) are captured by `cpal`,
  never by the webview; transcription runs whisper.cpp locally. Speakers are split by channel: microphone
  = "Moi", system sound = "Participants".
- **Transcripts and minutes are brain notes** (`items.kind = 'note'`, `dataJson.noteType = 'transcript' |
  'minutes'`), linked to the recording, the event and the entities. `recordings` only holds the session
  state and its consent.
- **Recording requires consent**: a confirmation each time, a timestamped consent in the database, and a
  banner, "● REC" title and tray icon for the whole session. Raw audio is purged after
  `audio.retentionDays` (30 by default); dictation audio is never written to disk.
- **Teams meeting links** (`onlineMeeting.joinUrl`) are read back from the database and validated (`https`
  only) in Rust before being opened; the front end never passes a URL to open.
- **Regis never writes to watched folders** (`local`, `smb` sources). Its own files go to
  `<data_dir>/library/{models,imported,generated}`.
- **Data folder**: resolved from `REGIS_DATA_DIR`, then `<app_config_dir>/bootstrap.json`, then the OS
  app data folder (never from a database setting, since the database lives in it), and marked by
  `regis-data.json`.
- **Distribution**: per-user NSIS installer (no admin rights, no MSI), sidecars through `externalBin`,
  single instance. Uninstalling keeps everything unless the user ticks the data removal box; that cleanup
  (`--uninstall-cleanup`) never runs during an update.

## Conventions

- Rust: `snake_case` modules, typed errors with `thiserror` (one enum per module), no `unwrap()` outside
  tests.
- TypeScript: `strict`, ESM, `kebab-case.ts` files, `PascalCase.tsx` components.
- JSON over IPC, RPC and MCP in `camelCase`; SQL columns in `snake_case`.
- IDs are ULIDs, dates ISO 8601 UTC strings; calendar dates are `YYYY-MM-DD`, and "today" / "this week"
  are computed in `app.timezone` (`Europe/Zurich` by default).
- Validate every external input at the boundary (model output, MCP and Odoo responses): Zod in TypeScript,
  typed serde in Rust.
- Parsing, mapping and rule functions are pure and unit tested.
- UI: use the variables of `tokens.css` only, no hard-coded colour. UI labels are in French. Real `<button>`, `<a href>` and `<label>` elements, `aria-label` on icon-only
  buttons.
- Comments in French, only where the code cannot say why.

## Never

- Open the SQLite database from the sidecar or the front end.
- Store a secret in the database, a config file, a log or a fixture.
- Run an agent's write tool without `resolvePolicy` and, for `ask`, an approved request.
- Write, move or delete a file in a `local` or `smb` source from Regis's own code.
- Write to stdout in the sidecar outside the JSON-RPC protocol.
- Hard-code an absolute path, a user name or a drive letter.
- Execute SQL, JavaScript or shell commands produced by a model (custom widgets are declarative).
- Show amounts, hours or counters taken from model output: they come from the data.
- Add a network dependency to the UI runtime (fonts and assets are bundled).
- Start a recording without confirmed consent in the UI, from an agent, an MCP tool or the scheduler.
- Send audio or transcripts to a cloud service, or write audio or transcribed text to logs.
- Delete a data folder without the `regis-data.json` marker, or touch data or secrets during an update.
- Install an update without an explicit user action, or call Ollama or whisper while their module is off.
