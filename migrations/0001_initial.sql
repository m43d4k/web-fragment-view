CREATE TABLE sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  commit_sha TEXT,
  target_commit_sha TEXT,
  completed_at TEXT,
  lock_owner TEXT,
  lock_until TEXT
);
INSERT INTO sync_state (id) VALUES (1);

CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  area TEXT NOT NULL CHECK (area IN ('active', 'archive')),
  folder TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_json TEXT NOT NULL CHECK (json_valid(tags_json)),
  attachments_json TEXT NOT NULL CHECK (json_valid(attachments_json)),
  hash TEXT NOT NULL,
  search_text TEXT NOT NULL,
  search_tokens TEXT NOT NULL
);
CREATE INDEX articles_feed ON articles (area, created_at DESC, id DESC);
CREATE INDEX articles_channel ON articles (area, folder, created_at DESC, id DESC);

CREATE TABLE article_tags (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (article_id, tag)
);
CREATE INDEX tags_lookup ON article_tags (tag, article_id);

CREATE TABLE article_assets (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  metadata TEXT NOT NULL,
  PRIMARY KEY (article_id, id)
);
CREATE INDEX assets_lookup ON article_assets (id);

CREATE VIRTUAL TABLE articles_fts USING fts5(id UNINDEXED, tokens, tokenize='ascii');

CREATE TRIGGER articles_insert AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts (rowid, id, tokens) VALUES (new.rowid, new.id, new.search_tokens);
  INSERT INTO article_tags SELECT new.id, value FROM json_each(new.tags_json);
  INSERT INTO article_assets SELECT new.id, json_extract(value, '$.id'), value FROM json_each(new.attachments_json);
  UPDATE sync_state SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER articles_update AFTER UPDATE ON articles BEGIN
  DELETE FROM articles_fts WHERE rowid = old.rowid;
  INSERT INTO articles_fts (rowid, id, tokens) VALUES (new.rowid, new.id, new.search_tokens);
  DELETE FROM article_tags WHERE article_id = old.id;
  INSERT INTO article_tags SELECT new.id, value FROM json_each(new.tags_json);
  DELETE FROM article_assets WHERE article_id = old.id;
  INSERT INTO article_assets SELECT new.id, json_extract(value, '$.id'), value FROM json_each(new.attachments_json);
  UPDATE sync_state SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER articles_delete AFTER DELETE ON articles BEGIN
  DELETE FROM articles_fts WHERE rowid = old.rowid;
  UPDATE sync_state SET revision = revision + 1 WHERE id = 1;
END;
