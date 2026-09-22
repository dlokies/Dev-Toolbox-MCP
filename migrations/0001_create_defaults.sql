CREATE TABLE defaults (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  preference TEXT NOT NULL CHECK (length(preference) BETWEEN 1 AND 1000),
  applies_when TEXT CHECK (applies_when IS NULL OR length(applies_when) BETWEEN 1 AND 500),
  topics TEXT NOT NULL CHECK (json_valid(topics) AND json_type(topics) = 'array' AND json_array_length(topics) <= 8),
  reference TEXT CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 500),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  search_text TEXT NOT NULL
);

CREATE INDEX defaults_title_id ON defaults(title COLLATE NOCASE, id);
