// Cartes — recherche automatique d'une carte (image, rareté, prix) à partir de ce qui est lu sur la photo.
// Pokémon : base TCGdex (https://tcgdex.dev), en français puis en anglais.

const TCGDEX = 'https://api.tcgdex.net/v2';
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
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
  let s = list.find((x) => norm(x.name) === k);
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
    language: c._lang === 'en' ? 'Anglais' : 'Français',
  };
}

async function matchPokemon(p, f) {
  const num = parseNumber(p.number);
  if (!p.name && !(p.set && num.variants.length)) return { status: 'none' };
  const cands = await findCandidates(p, num, f);
  if (!cands.length) return { status: 'none' };
  const top = cands.slice(0, 8);
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
  if (sure) return { status: 'sure', card: await enrich(best.c) };
  return { status: 'maybe', candidates: await Promise.all(scored.slice(0, 5).map((x) => enrich(x.c))) };
}

export async function matchCard(p, f = fetch) {
  const params = {
    name: String(p.name || '').slice(0, 80),
    number: String(p.number || '').slice(0, 20),
    set: String(p.set || '').slice(0, 80),
    language: String(p.language || '').slice(0, 20),
  };
  if (!/pok[eé]mon/i.test(String(p.game || ''))) return { status: 'unsupported' };
  return matchPokemon(params, f);
}
