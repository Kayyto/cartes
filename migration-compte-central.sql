-- À exécuter AVANT le déploiement du nouveau Worker (sans effet sur l'ancien : simple nouvelle table).
CREATE TABLE IF NOT EXISTS collections (
  account_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
