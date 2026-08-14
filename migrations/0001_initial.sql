CREATE TABLE allowed_chats (
  chat_id INTEGER PRIMARY KEY CHECK (chat_id <> 0),
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY CHECK (update_id >= 0),
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE speaker_profiles (
  chat_id INTEGER NOT NULL CHECK (chat_id <> 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  primary_language TEXT CHECK (primary_language IN ('ja', 'pt-br', 'other')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, user_id)
);
