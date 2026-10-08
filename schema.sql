-- Cartes : une collection par compte central (compte.kayto.org).
-- La collection entière est un seul document JSON (comme dans l'ancienne version).
CREATE TABLE IF NOT EXISTS collections (
  account_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
