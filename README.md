# Cartes (Ma Collection) — compte Kayto

App de collection de cartes sur `cartes.kayto.org`. Connexion via le compte central (compte.kayto.org, app `cartes`).
Chaque compte a sa propre collection. Un nouveau compte démarre vide.

Stockage (depuis oct. 2026) : une ligne par carte (table `cards`), les réglages/historiques dans `meta`, les photos perso dans R2 (bucket `cartes-photos`, binding `PHOTOS`). Les tables sont créées automatiquement par le Worker. L'ancienne table `collections` (un seul JSON) n'est plus écrite : elle reste en sauvegarde et sert à la migration automatique à la première ouverture.

- `src/worker.js` : API (`/api/me`, `/api/data`, `/api/sync`, `/api/photo/<empreinte>`) + passerelle vers l'ancien Worker `serveur-carte` (`/api/vision`, `/api/price`, `/api/image-search`, clés secrètes restées là-bas).
- `public/` : l'app (index.html, manifest, service worker, icônes).
- `schema.sql` / `migration-compte-central.sql` : table `collections` (la table `store` de l'ancienne version n'est pas touchée).
- `test/e2e.mjs` : tests de bout en bout (nécessite le Worker comptes sur :8799 et ce Worker sur :8788 avec `wrangler.test.toml`).
- `tools/patch-cartes-html.js` : transformation de l'ancien index.html (code d'accès) vers la version compte.
