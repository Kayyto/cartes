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
//   PUT  /api/data  { data } -> { ok: true }   (remplacement complet, gardé pour les anciennes versions de l'app)
//   POST /api/sync  { meta?, upsert: [cartes], remove: [ids] } -> { ok, images, backs }
//        sauvegarde carte par carte : seules les cartes modifiées sont envoyées
//   GET  /api/photo/<empreinte> -> la photo (stockée dans R2, réservée à son propriétaire)
// Stockage : une ligne par carte (table `cards`), le reste de la collection dans `meta`,
// les photos perso dans R2. L'ancienne table `collections` (un seul gros JSON) n'est plus écrite :
// elle sert de sauvegarde et de source pour la migration automatique à la première ouverture.
//   POST /api/vision, GET /api/price, GET /api/image-search
//        -> transmis à l'ancien Worker `serveur-carte` (liaison interne OUTILS) qui garde les clés
//           secrètes (Gemini, JustTCG, Google) ; réservés aux personnes connectées.
// Tout le reste est servi depuis /public (fichiers statiques).

import { matchCard } from './match.js';

const COMPTE_URL = 'https://compte.kayto.org';
const APP_SLUG = 'cartes';
const SESSION_COOKIE = 'kc_cartes';
const SESSION_CACHE_MS = 30000;
const MAX_DATA_BYTES = 1_900_000; // une ligne D1 ne peut pas dépasser 2 Mo (ancien format)
const MAX_CARD_BYTES = 1_500_000; // une carte (avec sa photo si elle n'a pas pu passer en R2)
const MAX_SYNC_BYTES = 4_000_000;
const MAX_UPSERT = 250;
const MAX_REMOVE = 2000;
const MAX_PHOTO_BYTES = 2_000_000;
const PHOTOS_PER_REQUEST = 20; // limite de sous-requêtes d'un Worker : on convertit quelques photos par appel
const D1_CHUNK = 200;
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
      if (p === '/api/sync' && req.method === 'POST') return await handleSync(req, env);
      if (p.startsWith('/api/photo/') && req.method === 'GET') return await handlePhoto(req, env, p.slice('/api/photo/'.length));
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

// ---------- stockage carte par carte ----------
let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS cards (account_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (account_id, id))'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS meta (account_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)'),
    ]).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

function upsertCardStmt(env, accountId, card, now) {
  return env.DB.prepare(
    'INSERT INTO cards (account_id, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
  ).bind(accountId, card.id, JSON.stringify(card), now);
}
function upsertMetaStmt(env, accountId, meta, now) {
  return env.DB.prepare(
    'INSERT INTO meta (account_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
  ).bind(accountId, JSON.stringify(meta), now);
}
async function runChunked(env, stmts) {
  for (let i = 0; i < stmts.length; i += D1_CHUNK) await env.DB.batch(stmts.slice(i, i + D1_CHUNK));
}

// Photo en data: URL -> R2 ; renvoie l'adresse /api/photo/<empreinte> (ou null si impossible).
const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp|gif));base64,/;
async function storePhoto(env, accountId, dataUrl) {
  if (!env.PHOTOS) return null;
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return null;
  let bytes;
  try {
    const bin = atob(dataUrl.slice(m[0].length));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch { return null; }
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) return null;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)].slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.PHOTOS.put(`${accountId}/${hash}`, bytes, { httpMetadata: { contentType: m[1] } });
  return `/api/photo/${hash}`;
}

// Prépare des cartes avant l'écriture : valide, et passe les photos perso en R2 (quelques-unes par appel).
async function prepareCards(env, accountId, cards, images) {
  let budget = PHOTOS_PER_REQUEST;
  const out = [];
  for (const c of cards) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    if (typeof c.id !== 'string' || !c.id || c.id.length > 120) continue;
    const card = { ...c };
    if (typeof card.image === 'string' && card.image.startsWith('data:') && budget > 0) {
      const url = await storePhoto(env, accountId, card.image);
      budget--;
      if (url) { card.image = url; if (images) images[card.id] = url; }
    }
    if (JSON.stringify(card).length > MAX_CARD_BYTES) continue;
    out.push(card);
  }
  return out;
}
async function prepareMeta(env, accountId, meta, backs) {
  const m = { ...meta };
  delete m.cards;
  if (m.cardBacks && typeof m.cardBacks === 'object') {
    m.cardBacks = { ...m.cardBacks };
    let budget = 10;
    for (const [k, v] of Object.entries(m.cardBacks)) {
      if (typeof v === 'string' && v.startsWith('data:') && budget > 0) {
        const url = await storePhoto(env, accountId, v);
        budget--;
        if (url) { m.cardBacks[k] = url; if (backs) backs[k] = url; }
      }
    }
  }
  return m;
}

// Première ouverture après le passage au stockage par carte : on découpe l'ancien JSON.
async function migrateLegacy(env, account) {
  const row = await env.DB.prepare('SELECT data FROM collections WHERE account_id = ?').bind(account.id).first();
  if (!row) return null;
  let data;
  try { data = JSON.parse(row.data); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const now = new Date().toISOString();
  const cards = (Array.isArray(data.cards) ? data.cards : [])
    .filter((c) => c && typeof c === 'object' && !Array.isArray(c))
    .map((c) => (typeof c.id === 'string' && c.id ? c : { ...c, id: crypto.randomUUID() }));
  const meta = { ...data };
  delete meta.cards;
  const stmts = cards.map((c) => upsertCardStmt(env, account.id, c, now));
  await runChunked(env, stmts);
  await env.DB.prepare(upsertMetaSql()).bind(account.id, JSON.stringify(meta), now).run(); // meta en dernier : si ça échoue, on recommence
  return { ...meta, cards };
}
function upsertMetaSql() {
  return 'INSERT INTO meta (account_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at';
}

async function handleGetData(req, env) {
  const account = await getAccount(req, env);
  if (!account) return unauthorized(req);
  await ensureSchema(env);
  const metaRow = await env.DB.prepare('SELECT data FROM meta WHERE account_id = ?').bind(account.id).first();
  if (!metaRow) {
    const migrated = await migrateLegacy(env, account);
    return json({ data: migrated });
  }
  let meta = {};
  try { meta = JSON.parse(metaRow.data) || {}; } catch { meta = {}; }
  const rows = await env.DB.prepare('SELECT data FROM cards WHERE account_id = ? ORDER BY rowid').bind(account.id).all();
  const cards = [];
  for (const r of rows.results || []) { try { cards.push(JSON.parse(r.data)); } catch { /* ligne illisible ignorée */ } }
  return json({ data: { ...meta, cards } });
}

// Ancien format (remplacement complet) : accepté pour les anciennes versions de l'app ouvertes dans un onglet.
async function handlePutData(req, env) {
  const account = await getAccount(req, env);
  if (!account) return unauthorized(req);
  await ensureSchema(env);
  const raw = await req.text();
  if (raw.length > MAX_SYNC_BYTES * 2) return json({ error: 'Collection trop volumineuse.' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'invalid_payload' }, 400); }
  if (!body || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) return json({ error: 'invalid_payload' }, 400);
  const now = new Date().toISOString();
  const cards = await prepareCards(env, account.id, Array.isArray(body.data.cards) ? body.data.cards : [], null);
  const meta = await prepareMeta(env, account.id, body.data, null);
  const existing = await env.DB.prepare('SELECT id FROM cards WHERE account_id = ?').bind(account.id).all();
  const keep = new Set(cards.map((c) => c.id));
  const stale = (existing.results || []).map((r) => r.id).filter((id) => !keep.has(id));
  const stmts = [];
  for (const id of stale) stmts.push(env.DB.prepare('DELETE FROM cards WHERE account_id = ? AND id = ?').bind(account.id, id));
  for (const c of cards) stmts.push(upsertCardStmt(env, account.id, c, now));
  await runChunked(env, stmts);
  await env.DB.prepare(upsertMetaSql()).bind(account.id, JSON.stringify(meta), now).run();
  return json({ ok: true });
}

// Sauvegarde incrémentale : cartes modifiées / supprimées + (si changé) le reste de la collection.
async function handleSync(req, env) {
  const account = await getAccount(req, env);
  if (!account) return unauthorized(req);
  await ensureSchema(env);
  const raw = await req.text();
  if (raw.length > MAX_SYNC_BYTES) return json({ error: 'Envoi trop volumineux.' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'invalid_payload' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'invalid_payload' }, 400);
  const upsert = Array.isArray(body.upsert) ? body.upsert : [];
  const remove = Array.isArray(body.remove) ? body.remove.filter((id) => typeof id === 'string' && id) : [];
  if (upsert.length > MAX_UPSERT || remove.length > MAX_REMOVE) return json({ error: 'Trop de cartes d\'un coup.' }, 413);
  const now = new Date().toISOString();
  const images = {};
  const backs = {};
  const cards = await prepareCards(env, account.id, upsert, images);
  const stmts = [];
  for (const id of remove) stmts.push(env.DB.prepare('DELETE FROM cards WHERE account_id = ? AND id = ?').bind(account.id, id));
  for (const c of cards) stmts.push(upsertCardStmt(env, account.id, c, now));
  if (body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)) {
    const meta = await prepareMeta(env, account.id, body.meta, backs);
    if (JSON.stringify(meta).length > MAX_DATA_BYTES) return json({ error: 'Réglages trop volumineux.' }, 413);
    stmts.push(upsertMetaStmt(env, account.id, meta, now));
  }
  if (stmts.length) await runChunked(env, stmts);
  return json({ ok: true, saved: cards.length, skipped: upsert.length - cards.length, images, backs });
}

// Photo perso : lue depuis R2, uniquement par la personne qui la possède (clé = compte + empreinte).
async function handlePhoto(req, env, hash) {
  const account = await getAccount(req, env);
  if (!account) return unauthorized(req);
  if (!env.PHOTOS || !/^[a-f0-9]{40}$/.test(hash)) return json({ error: 'not_found' }, 404);
  const etag = `"${hash}"`;
  if (req.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'private, max-age=31536000, immutable' } });
  }
  const obj = await env.PHOTOS.get(`${account.id}/${hash}`);
  if (!obj) return json({ error: 'not_found' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg',
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
    },
  });
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
