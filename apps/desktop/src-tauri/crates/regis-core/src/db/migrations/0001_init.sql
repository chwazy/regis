CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE connectors (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('stdio','http','builtin')),
  command TEXT, args_json TEXT NOT NULL DEFAULT '[]', url TEXT, env_json TEXT NOT NULL DEFAULT '{}',
  secret_ref TEXT, enabled INTEGER NOT NULL DEFAULT 1, sync_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'unknown', last_sync_at TEXT, created_at TEXT NOT NULL);

CREATE TABLE items (id TEXT PRIMARY KEY, connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('message','event','task','time_entry','invoice','contact','project','partner','note')),
  external_id TEXT NOT NULL, title TEXT NOT NULL, body_text TEXT, occurred_at TEXT, data_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL, UNIQUE (connector_id, kind, external_id));
CREATE INDEX items_kind_occurred_at ON items (kind, occurred_at);

CREATE TABLE entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('client','project','contact','other')),
  name TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]', data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE links (id TEXT PRIMARY KEY, from_type TEXT NOT NULL, from_id TEXT NOT NULL, to_type TEXT NOT NULL, to_id TEXT NOT NULL,
  rel TEXT NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('auto','user')), confidence REAL,
  created_at TEXT NOT NULL, UNIQUE (from_type, from_id, to_type, to_id, rel));
CREATE INDEX links_to ON links (to_type, to_id);

CREATE TABLE facts (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, text TEXT NOT NULL,
  source_type TEXT NOT NULL, source_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed','to_verify','inferred')), created_at TEXT NOT NULL);

CREATE TABLE file_sources (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('local','smb','cloud','regis')),
  path TEXT NOT NULL UNIQUE, watch_mode TEXT NOT NULL CHECK (watch_mode IN ('realtime','poll','delta')),
  poll_minutes INTEGER, state TEXT NOT NULL DEFAULT 'unknown', last_scan_at TEXT, connector_id TEXT REFERENCES connectors(id));

CREATE TABLE files (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES file_sources(id) ON DELETE CASCADE, rel_path TEXT NOT NULL,
  ext TEXT NOT NULL, size INTEGER NOT NULL, mtime TEXT NOT NULL, sha256 TEXT,
  role TEXT NOT NULL CHECK (role IN ('template','reference','generated','imported')),
  status TEXT NOT NULL DEFAULT 'pending', indexed_at TEXT, UNIQUE (source_id, rel_path));

CREATE TABLE chunks (id INTEGER PRIMARY KEY, owner_type TEXT NOT NULL CHECK (owner_type IN ('file','item','fact')),
  owner_id TEXT NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL, UNIQUE (owner_type, owner_id, ord));
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id');
CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[1024]);

CREATE TRIGGER chunks_after_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER chunks_after_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  DELETE FROM chunks_vec WHERE rowid = old.id;
END;
CREATE TRIGGER chunks_after_update AFTER UPDATE OF text ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE templates (id TEXT PRIMARY KEY, file_id TEXT NOT NULL UNIQUE REFERENCES files(id) ON DELETE CASCADE, name TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '', variables_json TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1);

CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  runtime TEXT NOT NULL CHECK (runtime IN ('claude-cli','anthropic-api','ollama','codex-cli','gemini-cli')),
  mode TEXT NOT NULL CHECK (mode IN ('headless','pty','acp','api')), account_label TEXT, model TEXT,
  budget_daily_usd REAL, use_when TEXT NOT NULL DEFAULT '', can_spawn INTEGER NOT NULL DEFAULT 0,
  worktree_per_job INTEGER NOT NULL DEFAULT 0, connector_ids_json TEXT NOT NULL DEFAULT '[]',
  secret_ref TEXT, is_local_only INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1);

CREATE TABLE routing_rules (id TEXT PRIMARY KEY, ord INTEGER NOT NULL UNIQUE, conditions_json TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id), reason TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1);

CREATE TABLE tool_policies (id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE, tool_pattern TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('auto','ask','deny')), UNIQUE (agent_id, tool_pattern));

CREATE TABLE jobs (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES jobs(id), agent_id TEXT NOT NULL REFERENCES agents(id),
  kind TEXT NOT NULL DEFAULT 'task', title TEXT NOT NULL, prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','done','failed','cancelled')),
  session_id TEXT, cwd TEXT, cost_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  routing_reason TEXT, result_text TEXT, error TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT);
CREATE INDEX jobs_status_created_at ON jobs (status, created_at);

CREATE TABLE job_events (id INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  at TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('start','message','tool_call','tool_result','file','approval_request','approval_resolved','end','error')),
  summary TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', UNIQUE (job_id, seq));

CREATE TABLE approvals (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, tool TEXT NOT NULL,
  input_json TEXT NOT NULL, preview_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','edited')),
  decision_note TEXT, created_at TEXT NOT NULL, decided_at TEXT);

CREATE TABLE briefs (id TEXT PRIMARY KEY, date TEXT NOT NULL UNIQUE, generated_at TEXT NOT NULL, job_id TEXT REFERENCES jobs(id),
  headline TEXT NOT NULL, sections_json TEXT NOT NULL);

CREATE TABLE dashboards (id TEXT PRIMARY KEY, name TEXT NOT NULL, ord INTEGER NOT NULL);

CREATE TABLE widgets (id TEXT PRIMARY KEY, dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, title TEXT NOT NULL, config_json TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL);

CREATE TABLE entity_syntheses (entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  text TEXT NOT NULL, source_count INTEGER NOT NULL, signature TEXT NOT NULL, job_id TEXT,
  generated_at TEXT NOT NULL);

CREATE TABLE recordings (id TEXT PRIMARY KEY, title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('recording','finalizing','done','failed','cancelled')),
  sources TEXT NOT NULL CHECK (sources IN ('mic','system','both')),
  started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER,
  consent_at TEXT NOT NULL, consent_text TEXT NOT NULL,
  stt_model TEXT NOT NULL, audio_dir TEXT, audio_purged_at TEXT, error TEXT, speakers_json TEXT);
CREATE TABLE transcript_segments (id INTEGER PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('mic','system')),
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, text TEXT NOT NULL, speaker TEXT);
CREATE INDEX transcript_segments_recording ON transcript_segments (recording_id, start_ms);
