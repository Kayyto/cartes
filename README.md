# Cartes (Ma Collection) — compte Kayto

App de collection de cartes sur `cartes.kayto.org`. Connexion via le compte central (compte.kayto.org, app `cartes`).
Chaque compte a sa propre collection (table `collections`, une ligne par compte). Un nouveau compte démarre vide.

- `src/worker.js` : API (`/api/me`, `/api/data`) + passerelle vers l'ancien Worker `serveur-carte` (`/api/vision`, `/api/price`, `/api/image-search`, clés secrètes restées là-bas).
- `public/` : l'app (index.html, manifest, service worker, icônes).
- `schema.sql` / `migration-compte-central.sql` : table `collections` (la table `store` de l'ancienne version n'est pas touchée).
- `test/e2e.mjs` : tests de bout en bout (nécessite le Worker comptes sur :8799 et ce Worker sur :8788 avec `wrangler.test.toml`).
- `tools/patch-cartes-html.js` : transformation de l'ancien index.html (code d'accès) vers la version compte.
