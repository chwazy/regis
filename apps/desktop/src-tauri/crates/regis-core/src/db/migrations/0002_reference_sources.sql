-- Source de référence : visible par les agents, jamais scannée ni indexée.
ALTER TABLE file_sources ADD COLUMN indexed INTEGER NOT NULL DEFAULT 1;
