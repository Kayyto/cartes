// Cartes — recherche automatique d'une carte (image, rareté, prix) à partir de ce qui est lu sur la photo.
// Pokémon : base TCGdex (https://tcgdex.dev), en français puis en anglais.
// Autres jeux : Magic (Scryfall), Yu-Gi-Oh! (YGOPRODeck), One Piece (optcgapi), Lorcana (Lorcast),
// Riftbound (Riftcodex), Dragon Ball Fusion World (données apitcg sur GitHub).

const TCGDEX = 'https://api.tcgdex.net/v2';
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const setsCache = new Map(); // langue -> { at, list }
const SETS_TTL = 12 * 3600 * 1000;

async function tj(path, f) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 9000);
  try {
    const res = await f(TCGDEX + path, { signal: ctl.signal, cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(to); }
}

function langsFor(language) {
  const s = norm(language);
  if (s.startsWith('japon') || s === 'ja' || s === 'jp' || s.startsWith('japan')) return ['ja', 'en'];
  if (s.startsWith('angl') || s === 'en' || s.startsWith('engl')) return ['en', 'fr'];
  return ['fr', 'en'];
}

function parseNumber(n) {
  const m = String(n || '').trim().match(/^([A-Za-z]{0,5}\d{1,4}[A-Za-z]?)\s*(?:\/\s*([A-Za-z]{0,5}\d{1,4}))?/);
  if (!m) return { variants: [], denom: 0 };
  const raw = m[1].toUpperCase();
  const dm = (m[2] || '').match(/\d+/);
  const mm = raw.match(/^([A-Z]*)0*(\d+)([A-Z]?)$/);
  const variants = [raw];
  if (mm) {
    variants.push(mm[1] + mm[2] + mm[3]);
    if (!mm[1] && !mm[3]) { variants.push(mm[2].padStart(3, '0')); variants.push(mm[2].padStart(2, '0')); }
  }
  return { variants: [...new Set(variants)], denom: dm ? parseInt(dm[0], 10) : 0 };
}

async function setList(lang, f) {
  const hit = setsCache.get(lang);
  if (hit && Date.now() - hit.at < SETS_TTL) return hit.list;
  const list = await tj(`/${lang}/sets`, f);
  if (Array.isArray(list)) { setsCache.set(lang, { at: Date.now(), list }); return list; }
  return hit ? hit.list : [];
}

async function setIdByName(lang, setName, f) {
  const k = norm(setName);
  if (!k) return null;
  const list = await setList(lang, f);
  const code = String(setName || '').trim().toLowerCase();
  let s = list.find((x) => String(x.id).toLowerCase() === code) || list.find((x) => norm(x.name) === k);
  if (!s && k.length >= 5) s = list.find((x) => norm(x.name).includes(k) || k.includes(norm(x.name)));
  return s ? s.id : null;
}

async function findCandidates(p, num, f) {
  const out = [];
  const seen = new Set();
  for (const lang of langsFor(p.language)) {
    let found = [];
    const name = (p.name || '').trim();
    if (name && num.variants.length) {
      for (const v of num.variants) {
        const r = await tj(`/${lang}/cards?name=${encodeURIComponent(name)}&localId=${encodeURIComponent(v)}`, f);
        if (Array.isArray(r) && r.length) { found = r; break; }
      }
    }
    if (!found.length && p.set) {
      const sid = await setIdByName(lang, p.set, f);
      if (sid) {
        if (name) {
          const r = await tj(`/${lang}/cards?name=${encodeURIComponent(name)}`, f);
          if (Array.isArray(r)) found = r.filter((c) => String(c.id).startsWith(sid + '-'));
        }
        if (!found.length && num.variants.length) {
          const sj = await tj(`/${lang}/sets/${encodeURIComponent(sid)}`, f);
          if (sj && Array.isArray(sj.cards)) found = sj.cards.filter((c) => num.variants.includes(String(c.localId).toUpperCase()));
        }
      }
    }
    if (!found.length && name && !num.variants.length) {
      const r = await tj(`/${lang}/cards?name=${encodeURIComponent(name)}`, f);
      if (Array.isArray(r)) found = r.slice(0, 30);
    }
    for (const c of found) if (!seen.has(c.id)) { seen.add(c.id); out.push({ id: c.id, lang }); }
    if (out.length) break;
  }
  return out;
}

function shape(c, imageFallback) {
  const cm = (c.pricing && c.pricing.cardmarket) || null;
  const price = cm ? (cm.trend || cm.avg || 0) : 0;
  const off = c.set && c.set.cardCount && c.set.cardCount.official;
  const img = c.image || imageFallback || '';
  return {
    id: c.id,
    name: c.name || '',
    set: (c.set && c.set.name) || '',
    setId: (c.set && c.set.id) || '',
    number: off ? `${c.localId}/${off}` : String(c.localId || ''),
    rarity: c.rarity || '',
    illustrator: c.illustrator || '',
    image: img ? img + '/high.webp' : '',
    thumb: img ? img + '/low.webp' : '',
    price: Math.round(price * 100) / 100,
    language: LANG_NAMES[c._lang] || 'Français',
  };
}

async function matchPokemon(p, f) {
  const num = parseNumber(p.number);
  if (!p.name && !(p.set && num.variants.length)) return { status: 'none' };
  const cands = await findCandidates(p, num, f);
  if (!cands.length) return { status: 'none' };
  const lim = Math.min(30, Math.max(0, parseInt(p.limit, 10) || 0));
  const top = cands.slice(0, lim || 8);
  const fulls = (await Promise.all(top.map((c) => tj(`/${c.lang}/cards/${encodeURIComponent(c.id)}`, f))))
    .map((c, i) => (c ? Object.assign(c, { _lang: top[i].lang }) : null)).filter(Boolean);
  if (!fulls.length) return { status: 'none' };
  const scored = fulls.map((c) => {
    let s = 0;
    const off = c.set && c.set.cardCount && c.set.cardCount.official;
    const tot = c.set && c.set.cardCount && c.set.cardCount.total;
    if (num.denom && off === num.denom) s += 3; else if (num.denom && tot === num.denom) s += 1;
    if (p.set && norm(c.set && c.set.name) === norm(p.set)) s += 3;
    if (p.name && norm(c.name) === norm(p.name)) s += 1;
    return { c, s };
  }).sort((a, b) => b.s - a.s);
  const best = scored[0];
  const unique = scored.length === 1 || scored[1].s < best.s;
  const numOk = !num.variants.length || num.variants.includes(String(best.c.localId).toUpperCase());
  const sure = numOk && ((best.s >= 3 && unique) || (scored.length === 1 && best.s >= 1));
  const pref = langsFor(p.language)[0];
  const enrich = async (c) => {
    if (c._lang !== pref) { // même carte dans la langue demandée (ex. français) si elle existe
      const alt = await tj(`/${pref}/cards/${encodeURIComponent(c.id)}`, f);
      if (alt && alt.name) c = Object.assign(alt, { _lang: pref });
    }
    if (c.image || c._lang === 'en') return shape(c);
    const en = await tj(`/en/cards/${encodeURIComponent(c.id)}`, f);
    return shape(c, en && en.image);
  };
  if (sure && !lim) return { status: 'sure', card: await enrich(best.c) };
  return { status: 'maybe', candidates: await Promise.all(scored.slice(0, lim || 5).map((x) => enrich(x.c))) };
}


/* ================= autres jeux ================= */
const UA = { 'User-Agent': 'kayto-cartes/1.0 (cartes.kayto.org)', Accept: 'application/json' };
async function gj(url, f, ms = 9000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await f(url, { signal: ctl.signal, headers: UA, cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(to); }
}
const enc = encodeURIComponent;
const LANG_NAMES = { en: 'Anglais', fr: 'Français', de: 'Allemand', es: 'Espagnol', it: 'Italien', pt: 'Portugais', ja: 'Japonais', ko: 'Coréen', ru: 'Russe', zhs: 'Chinois', zht: 'Chinois' };
const baseName = (s) => String(s || '').replace(/\s*\([^)]*\)\s*$/, '').trim();

// « OP01-001 », « LOB-EN005 », « 123/264 », « 229* »… -> code (préfixe-numéro), numéro, dénominateur
function codeKey(code) {
  const m = String(code || '').toUpperCase().match(/^([A-Z0-9]+)-([A-Z]{0,3})0*(\d+)/);
  return m ? `${m[1]}-${parseInt(m[3], 10)}` : '';
}
function parseNum(raw) {
  const s = String(raw || '').trim();
  const cm = s.match(/([A-Za-z]{1,6}\d{0,3})-([A-Za-z]{0,3}\d{1,4}[A-Za-z]?\*?)/);
  const code = cm ? `${cm[1]}-${cm[2]}`.toUpperCase() : '';
  const body = cm ? cm[2] : s.split('/')[0];
  const nm = body.match(/(\d{1,4})/);
  const dm = s.match(/\/\s*(\d{1,4})/);
  return {
    code, key: codeKey(code),
    n: nm ? parseInt(nm[1], 10) : 0,
    rawN: cm ? '' : s.split('/')[0].trim().replace(/^0+(?=\d)/, ''),
    denom: dm ? parseInt(dm[1], 10) : 0,
  };
}
const prefLang = (language) => langsFor(language)[0];

function publicShape(c) {
  return {
    id: String(c.id || ''), name: c.name || '', set: c.set || '', setId: c.setCode || '', number: c.number || '',
    rarity: c.rarity || '', illustrator: c.illustrator || '', image: c.image || '', thumb: c.thumb || c.image || '',
    price: Math.round((c.price || 0) * 100) / 100, language: c.language || 'Français',
    // false : base disponible en anglais seulement, la langue de ta carte reste celle que tu as indiquée
    langExact: c.langExact !== false,
  };
}

// Choisit la bonne carte parmi les candidats : « sure » (ajout automatique) ou « maybe » (à choisir).
function decide(cands, p, num) {
  if (!cands.length) return { status: 'none' };
  const pn = norm(baseName(p.name)), ps = norm(p.set), pref = prefLang(p.language);
  const scored = cands.map((c) => {
    let s = 0;
    const cn = norm(baseName(c.name));
    const nameEq = !!pn && (cn === pn || norm(c.altName) === pn);
    if (nameEq) s += 2; else if (pn && cn && (cn.includes(pn) || pn.includes(cn))) s += 1;
    const cs = norm(c.set), cc = norm(c.setCode);
    const setEq = !!ps && (cs === ps || cc === ps || (ps.length >= 5 && cs && (cs.includes(ps) || ps.includes(cs))));
    if (setEq) s += 3;
    const codeEq = !!num.key && !!c.code && codeKey(c.code) === num.key;
    const numEq = codeEq || (!!num.n && !num.code && c.n === num.n);
    if (codeEq) s += 4; else if (numEq) s += 3;
    if (num.code && c.code && String(c.code).toUpperCase() === num.code) s += 2; // même région / même version exacte
    if (num.denom && c.total === num.denom) s += 1;
    const s0 = s; // score sans bonus de langue : sert à savoir si UNE seule carte correspond vraiment
    if (c.lang && c.lang === pref) s += 1;
    return { c, s, s0, nameEq, setEq, numEq, codeEq };
  }).sort((a, b) => b.s - a.s);
  const best = scored[0];
  const unique = scored.length === 1 || scored[1].s0 < best.s0;
  const hasNum = !!(num.n || num.code);
  const sure = unique && (
    best.codeEq ||
    (best.numEq && (best.nameEq || best.setEq)) ||
    (best.nameEq && (best.setEq || (!hasNum && !p.set)))
  );
  if (sure) return { status: 'sure', card: publicShape(best.c) };
  const seen = new Set();
  const top = [];
  for (const x of scored) { if (seen.has(x.c.id)) continue; seen.add(x.c.id); top.push(publicShape(x.c)); if (top.length >= 5) break; }
  return { status: 'maybe', candidates: top };
}

const listCache = new Map();
async function cachedList(key, loader) {
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < SETS_TTL) return hit.list;
  const list = await loader();
  if (Array.isArray(list) && list.length) { listCache.set(key, { at: Date.now(), list }); return list; }
  return hit ? hit.list : [];
}
function pickSetByName(list, setName, nameKey = 'name', codeKey2 = 'code') {
  const k = norm(setName);
  if (!k) return null;
  return list.find((x) => norm(x[codeKey2]) === k) || list.find((x) => norm(x[nameKey]) === k)
    || (k.length >= 5 ? list.find((x) => norm(x[nameKey]).includes(k) || k.includes(norm(x[nameKey]))) : null) || null;
}

/* ---------- Magic (Scryfall) ---------- */
const SF = 'https://api.scryfall.com';
async function matchMagic(p, f) {
  const num = parseNum(p.number);
  const pref = prefLang(p.language);
  const sets = await cachedList('sf-sets', async () => { const d = await gj(SF + '/sets', f, 12000); return d && d.data ? d.data : []; });
  const set = p.set ? pickSetByName(sets, p.set) : null;
  const sizeOf = (code) => { const s = sets.find((x) => x.code === code); return s ? (s.printed_size || s.card_count || 0) : 0; };
  const shapeSf = (c) => {
    const u = c.image_uris || (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris) || {};
    const size = sizeOf(c.set);
    const cn = String(c.collector_number || '');
    return {
      id: c.id, name: c.printed_name || c.name || '', altName: c.name, set: c.set_name || '', setCode: c.set || '',
      number: size ? `${cn}/${size}` : cn, n: parseInt(cn, 10) || 0, total: size || 0,
      rarity: c.rarity || '', illustrator: c.artist || '',
      image: u.large || u.normal || '', thumb: u.small || '',
      price: parseFloat((c.prices && c.prices.eur) || 0) || 0,
      language: LANG_NAMES[c.lang] || 'Anglais', lang: c.lang,
    };
  };
  let cards = [];
  if (set && (num.rawN || num.n)) {
    const nn = num.rawN || String(num.n);
    for (const l of pref === 'fr' ? ['/fr', ''] : ['']) {
      const c = await gj(`${SF}/cards/${enc(set.code)}/${enc(nn)}${l}`, f);
      if (c && c.object === 'card') { cards = [c]; break; }
    }
  }
  const name = String(p.name || '').replace(/"/g, '').trim();
  if (!cards.length && name) {
    const sfx = set ? ` e:${set.code}` : '';
    const qs = pref === 'fr' ? [`lang:fr "${name}"${sfx}`, `!"${name}"${sfx}`] : [`!"${name}"${sfx}`, `lang:fr "${name}"${sfx}`];
    for (const q of qs) {
      const d = await gj(`${SF}/cards/search?q=${enc(q)}&unique=prints&order=released&include_multilingual=true`, f);
      if (d && Array.isArray(d.data) && d.data.length) { cards = d.data.slice(0, 40); break; }
    }
    if (!cards.length) {
      const c = await gj(`${SF}/cards/named?fuzzy=${enc(name)}`, f);
      if (c && c.object === 'card') cards = [c];
    }
  }
  return decide(cards.map(shapeSf), p, num);
}

/* ---------- Yu-Gi-Oh! (YGOPRODeck) ---------- */
const YGO = 'https://db.ygoprodeck.com/api/v7';
async function matchYugioh(p, f) {
  const num = parseNum(p.number);
  const pref = prefLang(p.language);
  const regionLang = (code) => ({ EN: 'en', FR: 'fr', DE: 'de', IT: 'it', SP: 'es', PT: 'pt', JP: 'ja', KR: 'ko' })[(String(code).match(/-([A-Z]{2})\d/) || [])[1]] || 'en';
  const cands = [];
  const addCard = (card, onlyCode) => {
    const img = (card.card_images && card.card_images[0]) || {};
    const price = parseFloat((card.card_prices && card.card_prices[0] && card.card_prices[0].cardmarket_price) || 0) || 0;
    const ps = norm(p.set);
    let sets = card.card_sets || [];
    if (onlyCode) { const hit = sets.filter((s) => codeKey(s.set_code) === codeKey(onlyCode)); if (hit.length) sets = hit; }
    else if (ps) { const hit = sets.filter((s) => norm(s.set_name) === ps || norm(s.set_name).includes(ps)); if (hit.length) sets = hit; }
    if (!sets.length) sets = [{ set_name: '', set_code: '', set_rarity: '' }];
    for (const s of sets.slice(0, 30)) {
      const last = String(s.set_code || '').split('-').pop() || '';
      cands.push({
        id: `${card.id}:${s.set_code || ''}`, name: card.name, set: s.set_name, setCode: String(s.set_code || '').split('-')[0],
        code: s.set_code, number: s.set_code || '', n: parseInt(last.replace(/\D/g, ''), 10) || 0, rarity: s.set_rarity || '',
        image: img.image_url || '', thumb: img.image_url_small || img.image_url || '', price,
        language: LANG_NAMES[regionLang(s.set_code)] || 'Anglais', lang: regionLang(s.set_code),
      });
    }
  };
  if (num.code) {
    for (const code of [num.code, num.code.replace(/^([A-Z0-9]+)-[A-Z]{2}(?=\d)/, '$1-EN')]) {
      const info = await gj(`${YGO}/cardsetsinfo.php?setcode=${enc(code)}`, f);
      if (info && info.id) {
        const d = await gj(`${YGO}/cardinfo.php?id=${info.id}`, f);
        if (d && d.data && d.data[0]) { addCard(d.data[0], num.code.replace(/^([A-Z0-9]+)-[A-Z]{2}(?=\d)/, '$1-EN')); break; }
      }
    }
  }
  const name = String(p.name || '').trim();
  if (!cands.length && name) {
    const tries = [];
    if (pref === 'fr') tries.push(`name=${enc(name)}&language=fr`);
    tries.push(`name=${enc(name)}`, `fname=${enc(name)}`);
    if (pref === 'fr') tries.push(`fname=${enc(name)}&language=fr`);
    for (const t of tries) {
      const d = await gj(`${YGO}/cardinfo.php?${t}`, f);
      if (d && Array.isArray(d.data) && d.data.length) { d.data.slice(0, 6).forEach((c) => addCard(c, null)); break; }
    }
  }
  return decide(cands, p, num);
}

/* ---------- One Piece (optcgapi.com) ---------- */
const OPTCG = 'https://optcgapi.com/api';
async function matchOnePiece(p, f) {
  const num = parseNum(p.number);
  const by = new Map();
  const add = (list) => (Array.isArray(list) ? list : []).forEach((c) => {
    const k = c.card_set_id; const base = c.card_image_id === c.card_set_id;
    if (!by.has(k) || (base && !by.get(k).base)) by.set(k, { base, c });
  });
  if (num.code) add(await gj(`${OPTCG}/sets/card/${enc(num.code)}/`, f));
  const name = baseName(p.name);
  if (!by.size && name) add(await gj(`${OPTCG}/sets/filtered/?card_name=${enc(name)}`, f));
  const cands = [...by.values()].map(({ c }) => ({
    id: c.card_set_id, name: baseName(c.card_name), set: c.set_name || '', setCode: c.set_id || '', code: c.card_set_id,
    number: c.card_set_id, n: parseInt(String(c.card_set_id).split('-').pop().replace(/\D/g, ''), 10) || 0, rarity: c.rarity || '',
    image: c.card_image || (c.card_image_id ? `https://optcgapi.com/media/static/Card_Images/${c.card_image_id}.jpg` : ''),
    language: 'Anglais', lang: 'en', price: 0, langExact: false,
  }));
  return decide(cands, p, num);
}

/* ---------- Lorcana (Lorcast) ---------- */
const LORCAST = 'https://api.lorcast.com/v0';
async function matchLorcana(p, f) {
  const num = parseNum(p.number);
  const sets = await cachedList('lorcast-sets', async () => { const d = await gj(LORCAST + '/sets', f); return d && d.results ? d.results : []; });
  const set = p.set ? pickSetByName(sets, p.set) : null;
  const shapeLc = (c) => {
    const u = (c.image_uris && c.image_uris.digital) || {};
    return {
      id: c.id, name: c.name + (c.version ? ' - ' + c.version : ''), altName: c.name, set: (c.set && c.set.name) || '', setCode: (c.set && c.set.code) || '',
      number: String(c.collector_number || ''), n: parseInt(c.collector_number, 10) || 0, rarity: c.rarity || '',
      illustrator: Array.isArray(c.illustrators) ? c.illustrators.join(', ') : '',
      image: u.large || u.normal || u.small || '', thumb: u.small || '', language: 'Anglais', lang: 'en', price: 0, langExact: false,
    };
  };
  let cards = [];
  if (set && num.n) {
    const c = await gj(`${LORCAST}/cards/${enc(set.code)}/${num.n}`, f);
    if (c && c.id) cards = [c];
  }
  const full = String(p.name || '').trim();
  if (!cards.length && full) {
    const d = await gj(`${LORCAST}/cards/search?q=${enc(full.split(/\s+[-–—]\s+/)[0])}`, f);
    if (d && Array.isArray(d.results)) cards = d.results.slice(0, 40);
  }
  const cands = cards.map(shapeLc);
  // « Elsa - Snow Queen » : on compare aussi avec le nom complet (nom + version)
  const p2 = Object.assign({}, p, { name: full });
  return decide(cands, p2, num);
}

/* ---------- Riftbound (Riftcodex) ---------- */
const RIFT = 'https://api.riftcodex.com';
async function matchRiftbound(p, f) {
  const num = parseNum(p.number);
  const shapeRb = (c) => {
    const mid = String((c.riftbound_id || '').split('-')[1] || c.collector_number || '');
    const setId = (c.set && c.set.set_id) || '';
    return {
      id: c.id, name: c.name || '', set: (c.set && c.set.label) || '', setCode: setId, code: `${setId}-${mid}`,
      number: mid || String(c.collector_number || ''), n: parseInt(c.collector_number, 10) || parseInt(mid, 10) || 0,
      rarity: (c.classification && c.classification.rarity) || '', illustrator: (c.media && c.media.artist) || '',
      image: (c.media && c.media.image_url) || '', language: 'Anglais', lang: 'en', price: 0, langExact: false,
    };
  };
  let items = [];
  const name = String(p.name || '').trim();
  if (name) {
    const d = await gj(`${RIFT}/cards/name?fuzzy=${enc(name)}`, f);
    if (d && Array.isArray(d.items)) items = d.items;
  }
  if (!items.length && (num.code || p.set) && num.n) {
    const sets = await cachedList('rift-sets', async () => { const d = await gj(RIFT + '/sets', f); return d && d.items ? d.items : []; });
    const code = num.code ? num.code.split('-')[0] : '';
    const set = sets.find((s) => String(s.set_id).toUpperCase() === code) || (p.set ? pickSetByName(sets, p.set, 'name', 'set_id') : null);
    if (set) {
      const first = await gj(`${RIFT}/cards?size=100&page=1&set_id=${enc(set.set_id)}`, f);
      const pages = first ? Math.min(first.pages || 1, 4) : 0;
      const rest = pages > 1 ? await Promise.all(Array.from({ length: pages - 1 }, (_, i) => gj(`${RIFT}/cards?size=100&page=${i + 2}&set_id=${enc(set.set_id)}`, f))) : [];
      [first].concat(rest).forEach((pg) => { if (pg && Array.isArray(pg.items)) items = items.concat(pg.items); });
      items = items.filter((c) => parseInt(c.collector_number, 10) === num.n);
    }
  }
  return decide(items.slice(0, 40).map(shapeRb), p, num);
}

/* ---------- Dragon Ball Fusion World (apitcg, GitHub) ---------- */
const DBFW = 'https://raw.githubusercontent.com/apitcg/dragon-ball-fusion-tcg-data/main/cards/en/';
const DBFW_SETS = ['fb01', 'fb02', 'fb03', 'fb04', 'fb05', 'fb06', 'fs01', 'fs02', 'fs03', 'fs04', 'fs05', 'fs06', 'fs07', 'fs08', 'fs09', 'fs10', 'sb01'];
async function matchDragonBall(p, f) {
  const num = parseNum(p.number);
  const sid = num.code ? num.code.split('-')[0].toLowerCase() : '';
  const ids = sid && /^[a-z]{2}\d{2}$/.test(sid) ? [sid] : DBFW_SETS;
  const files = await Promise.all(ids.map(async (id) => ({ id, list: await cachedList('dbfw-' + id, async () => { const d = await gj(DBFW + id + '.json', f, 12000); return Array.isArray(d) ? d : []; }) })));
  const cands = [];
  const pn = norm(p.name);
  for (const { id, list } of files) {
    for (const c of list) {
      if (/-p\d+$/i.test(c.code)) continue;
      if (num.key ? codeKey(c.code) !== num.key : !(pn && norm(c.name) && (norm(c.name) === pn || norm(c.name).includes(pn)))) continue;
      const im = c.images || {};
      cands.push({
        id: c.id || c.code, name: c.name || '', set: (/^fs/.test(id) ? 'Starter ' : /^sb/.test(id) ? 'Booster spécial ' : 'Booster ') + id.toUpperCase(), setCode: id.toUpperCase(),
        code: c.code, number: c.code, n: parseInt(String(c.code).split('-').pop().replace(/\D/g, ''), 10) || 0, rarity: c.rarity || '',
        image: im.large || im.small || '', thumb: im.small || im.large || '', language: 'Anglais', lang: 'en', price: 0, langExact: false,
      });
      if (cands.length > 40) break;
    }
  }
  return decide(cands, p, num);
}

const GAMES = [
  ['pokemon', /pok[eé]mon/i], ['onepiece', /one\s*piece/i], ['dragonball', /dragon\s*ball|\bdbs?\b|\bdbz\b/i],
  ['magic', /magic|mtg/i], ['yugioh', /yu-?\s*gi-?\s*oh|\bygo\b/i], ['lorcana', /lorcana/i], ['riftbound', /riftbound|league|\blol\b/i],
];
const MATCHERS = { pokemon: matchPokemon, magic: matchMagic, yugioh: matchYugioh, onepiece: matchOnePiece, lorcana: matchLorcana, riftbound: matchRiftbound, dragonball: matchDragonBall };

export async function matchCard(p, f = fetch) {
  const params = {
    name: String(p.name || '').slice(0, 80),
    number: String(p.number || '').slice(0, 20),
    set: String(p.set || '').slice(0, 80),
    language: String(p.language || '').slice(0, 20),
    limit: String(p.limit || '').slice(0, 3),
  };
  if (p.gk === 'manual') return { status: 'unsupported' };
  let key = MATCHERS[String(p.gk || '')] ? String(p.gk) : '';
  if (!key) { const g = GAMES.find(([, re]) => re.test(String(p.game || ''))); key = g ? g[0] : ''; }
  if (!key) return { status: 'unsupported' };
  if (!params.name && !params.number) return { status: 'none' };
  try { return await MATCHERS[key](params, f); } catch (e) { return { status: 'none', error: 'recherche impossible' }; }
}
