-- Ressources rattachées à une entité : repos, remotes, conventions, specs, documents, liens.
CREATE TABLE entity_resources (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('repo','remote','conventions','specs','document','link')),
  label TEXT, value TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX entity_resources_unique ON entity_resources (entity_id, kind, value);
