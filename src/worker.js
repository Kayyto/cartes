// Cartes — Worker (Cloudflare Workers + D1)
//
// Connexion : compte central Kayto (compte.kayto.org). Le navigateur envoie le cookie
// kc_cartes ; le Worker le fait valider par le service de comptes. Chaque compte a sa
// propre collection (table `collections`, une ligne par compte) : un nouveau compte
// démarre VIDE, on ne relie jamais une collection existante par e-mail ou par nom.
//
// Routes (navigateur, cookie de session) :
//   GET  /api/me            -> { account: { id, name, email } }       (401 sinon)
//   GET  /api/data          -> { data }  (null tant que la personne n'a rien enregistré)
//   PUT  /api/data  { data } -> { ok: true }
//   POST /api/vision, GET /api/price, GET /api/image-search
//        -> transmis à l'ancien Worker `serveur-carte` (liaison interne OUTILS) qui garde les clés
//           secrètes (Gemini, JustTCG, Google) ; réservés aux personnes connectées.
// Tout le reste est servi depuis /public (fichiers statiques).

import { matchCard } from './match.js';

const COMPTE_URL = 'https://compte.kayto.org';
const APP_SLUG = 'cartes';
const SESSION_COOKIE = 'kc_cartes';
const SESSION_CACHE_MS = 30000;
const MAX_DATA_BYTES = 1_900_000; // une ligne D1 ne peut pas dépasser 2 Mo
const MAX_VISION_BYTES = 6_000_000;
const sessionCache = new Map(); // empreinte du cookie -> { at, account }
const authWhy = new WeakMap();  // requête -> raison de l'échec (visible dans X-Auth-Why de /api/me)

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function unauthorized(request) {
  const res = json({ error: 'unauthorized', login: `${COMPTE_URL}/?app=${APP_SLUG}` }, 401);
  if (request) res.headers.set('X-Auth-Why', authWhy.get(request) || 'inconnu');
  return res;
}

function lireCookie(req, nom) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${nom}=([^;]+)`));
  return m ? m[1] : null;
}

async function sha256Hex(str) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Demande au service de comptes si le cookie est valide pour cette app (30 s en mémoire).
async function getCentralAccount(req, env) {
  const token = lireCookie(req, SESSION_COOKIE);
  if (!token) { authWhy.set(req, 'pas-de-cookie'); return null; }
  const key = await sha256Hex(token);
  const hit = sessionCache.get(key);
  if (hit && Date.now() - hit.at < SESSION_CACHE_MS) return hit.account;
  let account = null;
  try {
    const sessionUrl = `${(env && env.COMPTE_URL) || COMPTE_URL}/api/session?app=${APP_SLUG}`;
    const init = { headers: { Cookie: `${SESSION_COOKIE}=${token}` } };
    const res = env && env.COMPTE && typeof env.COMPTE.fetch === 'function'
      ? await env.COMPTE.fetch(new Request(sessionUrl, init))
      : await fetch(sessionUrl, init);
    if (!res.ok) authWhy.set(req, `comptes-http-${res.status}`);
    if (res.ok) {
      const data = await res.json();
      if (data.authenticated && data.account && data.account.app === APP_SLUG && typeof data.account.id === 'string' && data.account.id) {
        account = { id: data.account.id, name: String(data.account.name || '').trim() || 'Profil', email: String(data.account.email || '').trim().toLowerCase() };
      }
    }
  } catch (e) {
    console.error('Service de comptes injoignable :', e.message);
    authWhy.set(req, 'comptes-injoignable');
    return null; // par sécurité : pas de session valide si on ne peut pas vérifier
  }
  if (!account) {
    if (authWhy.has(req)) return null; // erreur technique : pas gardée en cache
    authWhy.set(req, 'session-refusee-par-comptes');
  }
  if (sessionCache.size > 500) sessionCache.clear();
  sessionCache.set(key, { at: Date.now(), account });
  return account;
}

// Personne connectée, ou null. Une requête qui modifie des données doit venir de ce site (CSRF).
async function getAccount(req, env) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.get('Origin');
    if (origin && origin !== new URL(req.url).origin) { authWhy.set(req, 'origine-refusee'); return null; }
  }
  return getCentralAccount(req, env);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);

      if (p === '/api/me' && req.method === 'GET') return await handleMe(req, env);
      if (p === '/api/data' && req.method === 'GET') return await handleGetData(req, env);
      if (p === '/api/data' && req.method === 'PUT') return await handlePutData(req, env);
      if (p === '/api/vision' && req.method === 'POST') return await handleOutil(req, env, url, true);
      if (p === '/api/price' && req.method === 'GET') return await handleOutil(req, env, url, false);
      if (p === '/api/image-search' && req.method === 'GET') return await handleOutil(req, env, url, false);
      if (p === '/api/match' && req.method === 'GET') return await handleMatch(req, env, url);
      return json({ error: 'not_found' }, 404);
    } catch (err) {
      console.error('Cartes — erreur serveur', err);
      return json({ error: 'server_error' }, 500);
    }
  },
};

async function handleMe(req, env) {
  const account = await getAccount(req, env);
  if (!account) return unauthorized(req);
  return json({ account });
}

async function handleGetData(req, env) {
  const account = await getAccount(req, env);
  if (!account) return unauthorized(req);
  const row = await env.DB.prepare('SELECT data FROM collections WHERE account_id = ?').bind(account.id).first();
  let data = null;
  if (row) { try { data = JSON.parse(row.data); } catch { data = null; } }
  return json({ data });
}

async function handlePutData(req, env) {
  const account = await getAccount(req, env);
  if (!account) return unauthorized(req);
  const raw = await req.text();
  if (raw.length > MAX_DATA_BYTES + 100) return json({ error: 'Collection trop volumineuse.' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'invalid_payload' }, 400); }
  if (!body || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) return json({ error: 'invalid_payload' }, 400);
  const dataStr = JSON.stringify(body.data);
  if (dataStr.length > MAX_DATA_BYTES) return json({ error: 'Collection trop volumineuse.' }, 413);
  await env.DB.prepare(
    'INSERT INTO collections (account_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
  ).bind(account.id, dataStr, new Date().toISOString()).run();
  return json({ ok: true });
}

// Recherche automatique de la carte (nom + numéro + extension) dans la base TCGdex.
async function handleMatch(req, env, url) {
  const account = await getAccount(req, env);
  if (!account) return unauthorized(req);
  const q = url.searchParams;
  const result = await matchCard({
    game: q.get('game') || '', name: q.get('name') || '', number: q.get('number') || '',
    set: q.get('set') || '', language: q.get('lang') || '',
  });
  return json(result);
}

// Outils externes (IA, prix, images) via l'ancien Worker, uniquement pour les personnes connectées.
async function handleOutil(req, env, url, withBody) {
  const account = await getAccount(req, env);
  if (!account) return unauthorized(req);
  if (!env.OUTILS) return json({ error: 'Outils indisponibles.' }, 503);
  const init = { method: req.method, headers: { 'Content-Type': 'application/json' } };
  if (withBody) {
    const raw = await req.text();
    if (raw.length > MAX_VISION_BYTES) return json({ error: 'Image trop volumineuse.' }, 413);
    init.body = raw;
  }
  const res = await env.OUTILS.fetch(new Request(`https://serveur-carte.internal${url.pathname}${url.search}`, init));
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
