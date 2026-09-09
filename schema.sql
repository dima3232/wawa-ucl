-- користувачі (з Telegram-логіна)
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,   -- "tg:<telegram_id>"
  name       TEXT NOT NULL,
  username   TEXT,
  photo      TEXT,
  created_at INTEGER NOT NULL
);

-- бронювання: один рядок на пару (матч, людина)
CREATE TABLE IF NOT EXISTS rsvp (
  match_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('in','maybe','out')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS rsvp_by_match ON rsvp(match_id);
