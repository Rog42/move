-- D1 schema for the move app. Safe to run more than once.
CREATE TABLE IF NOT EXISTS docs (
  col        TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (col, id)
);

CREATE TABLE IF NOT EXISTS counters (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);

-- Photos of what's in each box. The API also makes this table the first time it needs it.
CREATE TABLE IF NOT EXISTS photos (
  id         TEXT    PRIMARY KEY,
  box        TEXT    NOT NULL,
  mime       TEXT    NOT NULL,
  data       BLOB    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_box ON photos (box);

INSERT OR IGNORE INTO counters (k, v) VALUES ('box', 0);
INSERT OR IGNORE INTO counters (k, v) VALUES ('test', 0);
