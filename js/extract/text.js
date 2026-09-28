// Heuristic extraction of Tilia metadata from publication text.
// Every function is pure: text in, candidates out. Candidates carry the page
// (when known) and the snippet they came from so the UI can show provenance.

import {
  DATASET_KEYWORDS, DEPENV_PATTERNS, COLLECTION_DEVICES, COUNTRIES, COUNTRY_ALIASES,
  US_STATES, CA_PROVINCES, LAB_PREFIXES,
} from '../lookups.js';

const snippet = (text, index, len = 90) =>
  text.slice(Math.max(0, index - 30), Math.min(text.length, index + len)).replace(/\s+/g, ' ').trim();

// pages: [{page: 1, text: '...'}]. Returns a flat searchable string plus a lookup from offset → page.
export function joinPages(pages) {
  let text = '';
  const starts = [];
  for (const p of pages) {
    starts.push({ offset: text.length, page: p.page });
    text += p.text + '\n';
  }
  const pageAt = (i) => {
    let pg = starts.length ? starts[0].page : null;
    for (const s of starts) if (s.offset <= i) pg = s.page; else break;
    return pg;
  };
  return { text, pageAt };
}

// ---------- DOI ----------
export function findDOI(text) {
  const m = text.match(/\b(10\.\d{4,9}\/[^\s"<>,;]+[^\s"<>,;.)\]])/i);
  return m ? m[1] : null;
}

// ---------- coordinates ----------
// Real PDFs write the same coordinate many ways: 45°12′30″N, N 45°12′30″, 45 ◦ 12 ′ N,
// 0.599 ֯ S, decimal commas in seconds, and some (Wiley) fonts turn the symbols into
// digits: 33°57′55″N extracts as "33 8 57 0 55 00 N". normalizeCoordText() rewrites all
// of these into one canonical D°M′S″H form before matching.

function dmsToDecimal(d, m, s, hemi) {
  let v = Math.abs(parseFloat(d)) + (parseFloat(m || 0) / 60) + (parseFloat(s || 0) / 3600);
  if (/[SW]/i.test(hemi || '') || String(d).trim().startsWith('-')) v = -v;
  return Math.round(v * 1e6) / 1e6;
}

export function normalizeCoordText(text) {
  return String(text)
    .replace(/ | | /g, ' ')
    .replace(/−/g, '-')
    // Wiley glyph loss: "33 8 57 0 55 00 N" → 33°57′55″N ; "69 ˚ 19 0 24,48 00" → 69°19′24.48″
    .replace(/\b(\d{1,3}) ?(?:8|[°º˚◦֯]) ?(\d{1,2}) 0 (\d{1,2}(?:[.,]\d+)?) 00\b/g, '$1°$2′$3″')
    .replace(/\b(\d{1,3}) ?[°º˚◦֯] ?(\d{1,2}(?:[.,]\d+)?) 0\b(?=\s*[NSEW,])/g, '$1°$2′')
    .replace(/(\d)\s*[°º˚◦֯]/g, '$1°')
    .replace(/(\d)\s*(?:′′|''|’’|″|”|")/g, '$1″')
    .replace(/(\d)\s*[′'’´]/g, '$1′')
    .replace(/(\d),(\d+)(?=[′″])/g, '$1.$2');
}

// one coordinate: optional leading hemisphere, D[.d]° [M[.m]′ [S[.s]″]], optional trailing hemisphere
const COORD = String.raw`([NSEW])?\s*(-\s*)?(\d{1,3}(?:\.\d+)?)°(?:\s*(\d{1,2}(?:\.\d+)?)′(?:\s*(\d{1,2}(?:\.\d+)?)″)?)?\s*([NSEW](?![a-z]))?`;
const DEC_PAIR = String.raw`(-?\d{1,2}\.\d{2,})\s*°?\s*([NS])[\s,;/–]{1,8}(?:and\s+)?(-\s*)?(\d{1,3}\.\d{2,})\s*°?\s*([EW])`;

// Returns [{lat, lon, index, raw, hemispheres}] pairs found in text, in reading order.
export function findCoordinates(text) {
  const t = normalizeCoordText(text);
  const out = [];
  // no plain hyphen in the separator: it is usually a minus sign on the longitude
  const pairRe = new RegExp(`${COORD}[\\s,;/–—]{0,10}(?:and\\s+)?${COORD}`, 'g');
  for (const m of t.matchAll(pairRe)) {
    const [, h1a, s1, d1, m1, x1, h1b, h2a, s2, d2, m2, x2, h2b] = m;
    const hLat = h1a || h1b, hLon = h2a || h2b;
    if (hLat && !/[NS]/.test(hLat)) continue;
    if (hLon && !/[EW]/.test(hLon)) continue;
    const hasMinutes = m1 != null || m2 != null;
    if (!hLat && !hLon && !s2 && !hasMinutes) continue; // bare "48°, 12°" is too ambiguous
    const lat = dmsToDecimal((s1 ? '-' : '') + d1, m1, x1, hLat);
    const lon = dmsToDecimal((s2 ? '-' : '') + d2, m2, x2, hLon);
    out.push({ lat, lon, index: m.index, raw: m[0].trim(), hemispheres: !!(hLat || hLon) });
  }
  for (const m of t.matchAll(new RegExp(DEC_PAIR, 'g'))) {
    if (out.some((o) => Math.abs(o.index - m.index) < 8)) continue;
    out.push({ lat: dmsToDecimal(m[1], 0, 0, m[2]), lon: dmsToDecimal((m[3] ? '-' : '') + m[4], 0, 0, m[5]), index: m.index, raw: m[0], hemispheres: true });
  }
  // Labeled signed decimals: "latitude 45.123, longitude -93.456"
  const lab = /lat(?:itude)?\.?\s*[:=]?\s*(-?\d{1,2}\.\d+)\s*°?\s*[,;]?\s*(?:and\s+)?long?(?:itude)?\.?\s*[:=]?\s*(-?\d{1,3}\.\d+)/gi;
  for (const m of t.matchAll(lab)) out.push({ lat: parseFloat(m[1]), lon: parseFloat(m[2]), index: m.index, raw: m[0], hemispheres: true });
  // A range like "48.4°N to 48.6°N" is a region, not a site
  return out.filter((c) => Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180 && !/\bto\b/.test(c.raw))
    .sort((a, b) => a.index - b.index);
}

// ---------- altitude / water depth ----------
// Both return every match so the caller can pick the one nearest the chosen site/coordinates.
const ALT_PATS = [
  /(?:elevation|altitude)\s*(?:of|is|was|at|:|=)?\s*(?:ca\.?|approximately|~|c\.)?\s*(\d[\d,]*(?:\.\d+)?)\s*m\b(?!\s*(?:long|wide|deep|thick))/gi,
  /(\d[\d,]*(?:\.\d+)?)\s*m\s*(?:a\.?s\.?l\.?|above\s+(?:mean\s+)?sea[-\s]*level|elevation|altitude|asl)/gi,
  /(\d[\d,]*(?:\.\d+)?)\s*m\s*a\.?m\.?s\.?l/gi,
];
const WD_PATS = [
  /water depth\s*(?:of|was|is|:|=)?\s*(?:ca\.?|approximately|~)?\s*(\d+(?:\.\d+)?)\s*m\b/gi,
  /(\d+(?:\.\d+)?)\s*m\s*(?:of\s+)?water depth/gi,
  /(\d+(?:\.\d+)?)\s*m\s*(?:of\s+)?water\b/gi,
  /(?:maximum|max\.?)\s*(?:water\s*)?depth\s*(?:of|is|was|:)?\s*(\d+(?:\.\d+)?)\s*m\b/gi,
];
function allMatches(text, pats, ok) {
  const out = [];
  pats.forEach((p, rank) => {
    for (const m of text.matchAll(p)) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (ok(v) && !out.some((o) => Math.abs(o.index - m.index) < 5)) out.push({ value: v, index: m.index, raw: m[0], rank });
    }
  });
  return out.sort((x, y) => x.index - y.index);
}
// US papers often give elevation in feet ("6100’ above sea level", "6,100 ft asl"); converted to metres
const ALT_FT = /(\d[\d,]*(?:\.\d+)?)\s*(?:’|'|′|ft\.?|feet)\s*(?:a\.?s\.?l\.?|above\s+(?:mean\s+)?sea[-\s]*level|elevation)/gi;
export const findAltitudes = (text) => {
  const m = allMatches(text, ALT_PATS, (v) => v > -500 && v < 9000);
  for (const x of text.matchAll(ALT_FT)) {
    const ft = parseFloat(x[1].replace(/,/g, ''));
    if (ft > 0 && ft < 30000) m.push({ value: Math.round(ft * 0.3048), index: x.index, raw: `${x[0]} (= ${Math.round(ft * 0.3048)} m)`, rank: 3 });
  }
  return m.sort((a, b) => a.index - b.index);
};
export const findWaterDepths = (text) => allMatches(text, WD_PATS, (v) => v > 0 && v < 2000);
export const findAltitude = (text) => findAltitudes(text)[0] || null;
export const findWaterDepth = (text) => findWaterDepths(text)[0] || null;

// the match closest to (and preferably just after) an anchor offset
function nearest(list, anchor, maxDist = 600) {
  if (anchor == null) return list[0] || null;
  const scored = list.map((m) => ({ m, d: m.index >= anchor ? m.index - anchor : (anchor - m.index) * 1.5 })).filter((x) => x.d <= maxDist);
  return scored.sort((a, b) => a.d - b.d)[0]?.m || null;
}

// ---------- site name ----------
const FEATURE = "(?:Lake|Lakes|Lac|Loch|Lough|Pond|Bog|Fen|Mire|Marsh|Swamp|Cave|Moss|Tarn|Lagoon|Laguna|Lagoa|Lago|Mere|Meadow|Hollow|Slough|Pocosin|Pool|See|Sjön|Järvi|Blue Hole|Sinkhole|Cenote|Wetland|Peatland|Spring|Springs|Creek|Cocha|Ciénaga|Vlei)";
const NAME_WORD = "[A-ZÀ-Þ][a-zà-ÿ'’]+";
const NAME = `${NAME_WORD}(?:[ -](?:(?:de|del|da|do|dos|das|la|le|of) )?${NAME_WORD}){0,2}`;
const STOP_LEAD = /^(The|This|These|That|In|At|From|Our|A|An|Figure|Fig|Table|Late|Early|Middle|Holocene|Pleistocene|North|South|East|West|Northern|Southern|Eastern|Western|Upper|Lower|Great|Small|Large|Modern|Surface|Using|Environmental|Change|Changes|Record|Records|Data|Study|Site|Sites|Core|Cores|Each|Both|Near|Nearby|Between|Two|Three|Several|Other|Many|Most|All|Some|And|Of|For|With)\b\s*/;

// Candidate site names ranked by how often they occur, with a strong bonus for
// appearing in the title (papers usually name their main site there).
const LEADING_FEATURE = '(?:Lake|Lac|Lago|Lagoa|Laguna|Loch|Lough|Lagoon|Ciénaga)';
export function findSiteNames(rawText, title = '') {
  const text = String(rawText).replace(/\s+/g, ' '); // names often wrap across lines
  const counts = new Map();
  const res = [
    new RegExp(`(?<![\\w-])(${NAME} ${FEATURE})(?![\\w-])`, 'g'),
    // only lake-type words come before a name ("Lake Tahoe", "Laguna de Río Seco"), never "Creek Canyon"
    new RegExp(`(?<![\\w-])(${LEADING_FEATURE} (?:(?:de|del|da|do|of) )?${NAME})(?![\\w-])`, 'g'),
  ];
  const onlyFeature = new RegExp(`^${FEATURE}$`);
  for (const re of res) {
    for (const m of text.matchAll(re)) {
      let n = m[1].trim().replace(/’/g, "'");
      for (let k = 0; k < 3 && STOP_LEAD.test(n); k++) n = n.replace(STOP_LEAD, '').trim();
      if (!n || onlyFeature.test(n) || n.split(' ').length > 5) continue;
      const e = counts.get(n) || { value: n, count: 0, index: Math.max(0, String(rawText).indexOf(n.split(' ')[0])) };
      e.count += 1;
      counts.set(n, e);
    }
  }
  const t = title.toLowerCase();
  const scored = [...counts.values()].map((e) => {
    const esc = e.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // "Range Creek Canyon", "Snake River Plain": the name is part of a region, not the site
    const regional = (text.match(new RegExp(`${esc}\\s+(?:Canyon|Valley|Basin|Watershed|Mountains?|Range|National|State Park|Park|Plain|Plateau|Region|Drainage|Wilderness|Forest|City|County|Formation)\\b`, 'g')) || []).length;
    // "Billy Slope Meadow (BSM)": authors define an abbreviation for their study site
    const abbrev = new RegExp(`${esc}\\s*\\(([A-Z]{2,6})\\)`).test(text);
    const inTitle = !!t && t.includes(e.value.toLowerCase()) && regional < e.count / 2;
    const score = e.count - regional * 1.5 + (inTitle ? 25 : 0) + (abbrev ? 20 : 0);
    return { ...e, inTitle, abbrev, score };
  });
  // drop a name that is just a shorter piece of a better-scoring one ("Blue Hole" inside "Church's Blue Hole")
  const kept = scored.filter((e) => e.score > 0).filter((e) => !scored.some((o) => o !== e && o.value.length > e.value.length && o.value.includes(e.value) && o.score >= e.score / 3));
  return kept.sort((a, b) => b.score - a.score).slice(0, 5);
}

// ---------- geography ----------
function countTerms(text, terms) {
  const found = [];
  for (const t of terms) {
    const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const matches = [...text.matchAll(re)];
    if (matches.length) found.push({ value: t, count: matches.length, index: matches[0].index });
  }
  return found.sort((a, b) => b.count - a.count);
}

export function findGeography(text) {
  const countries = countTerms(text, COUNTRIES.concat(['USA', 'U.S.A.', 'United States']))
    .map((c) => ({ ...c, value: COUNTRY_ALIASES[c.value] || c.value }));
  const states = countTerms(text, US_STATES);
  const provinces = countTerms(text, CA_PROVINCES);
  let country = countries[0] || null;
  const topState = states[0];
  const topProv = provinces[0];
  // A US state or Canadian province mentioned more than any country implies the country.
  if (topState && (!country || topState.count >= country.count) && (!topProv || topState.count >= topProv.count)) {
    country = { value: 'United States', count: topState.count, index: topState.index, implied: true };
  } else if (topProv && (!country || topProv.count >= country.count)) {
    country = { value: 'Canada', count: topProv.count, index: topProv.index, implied: true };
  }
  let state = null;
  if (country?.value === 'United States') state = topState || null;
  if (country?.value === 'Canada') state = topProv || null;
  // "in Comal\nCounty": tolerate line breaks; ignore the reference list, where other
  // counties appear in cited titles ("…fauna from Crockett County, Texas")
  const body = text.split(/\n\s*(?:References|Bibliography|Literature cited|References cited)\s*\n/i)[0];
  const counties = [...body.matchAll(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:County|Parish|Borough)\b/g)]
    .filter((m) => !/^(The|This|Each|Which|Our|Same|Other)$/.test(m[1]))
    .map((m) => ({ value: m[1].replace(/\s+/g, ' '), index: m.index }));
  const tally = new Map();
  counties.forEach((c) => tally.set(c.value, (tally.get(c.value) || 0) + 1));
  const county = counties.sort((a, b) => tally.get(b.value) - tally.get(a.value) || a.index - b.index)[0] || null;
  return { country, state, county };
}

// ---------- dataset type / device / environment ----------
export function guessDatasetType(text) {
  // pollen is weighted up: fire-history papers mention charcoal constantly, but the
  // spreadsheet being converted is usually the pollen data
  return DATASET_KEYWORDS.map(([type, re]) => ({ value: type, count: (text.match(re) || []).length * (type === 'pollen' ? 3 : 1) }))
    .filter((s) => s.count > 0).sort((a, b) => b.count - a.count);
}

// Keep the paper's own wording ("Modified Livingstone piston corer"), as hand conversions do.
const DEVICE_RE = /\b((?:[Mm]odified |[Ss]quare[- ]rod |[Hh]and[- ]operated |[Tt]rack[- ]mounted )?(?:[A-Z][\w-]+(?:[- ](?:[A-Z][\w-]+))? )?(?:piston |gravity |percussion |peat |freeze |push |box |vibra|Russian[- ]type |)(?:corer|core sampler|sampler|coring device|coring system|auger)|[Ll]ong[- ]bladed shovel|Geoprobe[\w ]{0,12})\b/g;
const DEVICE_STOP = /^(The|A|An|This|Our|Each|Two|Three|Both|Using|With|By|Sediment|Core|Cores|Lake|Surface)\b\s*/;
export function findDevice(raw) {
  const text = String(raw).replace(/\s+/g, ' ');
  const counts = new Map();
  for (const m of text.matchAll(DEVICE_RE)) {
    let v = m[1].trim();
    for (let k = 0; k < 2 && DEVICE_STOP.test(v); k++) v = v.replace(DEVICE_STOP, '');
    if (!/\w{3,}.*\s|shovel|Geoprobe/i.test(v) && !/[A-Z]/.test(v)) continue; // skip a bare "corer"
    // keep a stated diameter: "a 5 cm Livingstone piston corer" → "Livingstone piston corer (5cm)"
    const dia = text.slice(Math.max(0, m.index - 12), m.index).match(/(\d+(?:\.\d+)?)\s*-?\s*cm\s*(?:diameter\s*)?$/i);
    if (dia) v += ` (${dia[1]}cm)`;
    const key = v.toLowerCase().replace(/\s*\(\d+(?:\.\d+)?cm\)$/, '');
    const e = counts.get(key) || { value: v, index: m.index, count: 0 };
    if (dia && !/\(\d/.test(e.value)) e.value = v;
    e.count++;
    counts.set(key, e);
  }
  // a named corer ("Livingstone", "Kajak") beats a generic "piston corer"
  const list = [...counts.values()].map((e) => ({ ...e, score: e.count + (/[A-Z]/.test(e.value.replace(/^Modified /, '')) ? 3 : 0) + e.value.split(' ').length * 0.2 }));
  const best = list.sort((a, b) => b.score - a.score || a.index - b.index)[0];
  if (best) return best;
  for (const [name, re] of COLLECTION_DEVICES) {
    const m = text.match(re);
    if (m) return { value: name, index: m.index };
  }
  return null;
}

// Environment follows the site's own feature word first (as in hand-made files:
// most lakes "Natural Lake", peatlands "Palustrine"), refined by origin words near the site.
export function findDepEnv(text, siteName) {
  const site = siteName || '';
  let near = '';
  if (site) {
    for (const m of text.matchAll(new RegExp(site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))) near += ' ' + text.slice(m.index, m.index + 400);
  }
  near = near || text.slice(0, 15000);
  const origin = [
    ['Cirque Lake', /\bcirque\b/i], ['Landslide Origin Lake', /landslide|slump/i], ['Glacial Origin Lake', /\bglacial(?:ly)? (?:formed|origin|lake|carved|scoured)|kettle|moraine[- ]dammed/i],
  ];
  const isLake = /\b(lake|lakes|lac|lago|lagoa|laguna|loch|lough|pond|tarn|mere|cocha|see)\b/i.test(site);
  const idx = site ? text.indexOf(site) : 0;
  if (/\b(marsh)\b/i.test(site)) return { value: 'Marsh', index: idx };
  // spring-fed sites are "Spring" in hand-made files (Billy Slope Meadow: "a spring-fed wet meadow")
  if (/\b(spring|springs|cienega|ciénaga|seep)\b/i.test(site) || (site && /spring[- ]fed/i.test(near))) return { value: 'Spring', index: idx };
  if (/\b(bog|fen|mire|moss|peatland|wetland|swamp|muskeg|meadow)\b/i.test(site)) return { value: 'Palustrine', index: idx };
  // Neotoma cave sub-environments (hand-made files use "Stream Deposited Cave Sediment")
  if (/\b(cave|cavern|sinkhole)\b/i.test(site)) return { value: /\b(stream|fluvial|underground river|conduit)\b/i.test(near) ? 'Stream Deposited Cave Sediment' : 'Cave', index: idx };
  if (isLake || /\blake\b/i.test(near)) {
    for (const [env, re] of origin) if (re.test(near)) return { value: env, index: idx };
    return { value: 'Natural Lake', index: idx };
  }
  if (/\b(peat|peatland|bog|fen|mire|palsa|monolith)\b/i.test(near)) return { value: 'Palustrine', index: idx };
  if (/floodplain|alluvi/i.test(near)) return { value: 'Floodplain', index: idx };
  if (/\b(marine|continental shelf|estuary|ocean|gulf)\b/i.test(near)) return { value: 'Marine', index: idx };
  return null;
}

// "In summer 2014 a core was taken", "obtained in August, 2008", "In May 2005, a … core was obtained".
// Month-less dates keep just the year; seasons map to their middle month (summer → July).
export function findCollectionDate(text) {
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const seasons = { spring: 4, summer: 7, autumn: 10, fall: 10, winter: 1 };
  const body = text.split(/\n\s*(?:References|Bibliography|Literature cited)\s*\n/i)[0];
  const verbs = /\b(cored|coring|collected|retrieved|obtained|sampled|samples? were|recovered|extracted|taken|drilled|fieldwork|field work|field season)\b/i;
  for (const sm of body.matchAll(/[^.]*\b(?:19[5-9]\d|20[0-4]\d)\b[^.]*(?:\.|$)/g)) {
    const sent = sm[0];
    if (!verbs.test(sent) || /\bet al\.|\(\d{4}\)|published/i.test(sent)) continue;
    const m = sent.match(/(?:(\d{1,2})\s+)?\b(january|february|march|april|may|june|july|august|september|october|november|december|spring|summer|autumn|fall|winter)?\b(?:\s+of)?,?\s*(?:(\d{1,2}),?\s+)?\b((?:19[5-9]|20[0-4])\d)\b/i);
    if (!m) continue;
    const word = (m[2] || '').toLowerCase();
    const month = months.indexOf(word) + 1 || seasons[word] || null;
    const day = months.includes(word) ? (m[1] || m[3]) : null;
    let value = m[4];
    if (month) value += '-' + String(month).padStart(2, '0');
    if (month && day) value += '-' + String(day).padStart(2, '0');
    return { value, index: sm.index, raw: sent.trim().slice(0, 160) };
  }
  return null;
}

// ---------- geochronology ----------
// Date tables come out of PDFs as loosely ordered tokens. We find lab numbers first
// (known lab prefixes, tolerant of "UOC - 17575", "Poz151143", "CAIS*39123"), then read
// the text between one lab number and the next as that row.
const MATERIALS = /\b(bulk sediments?|bulk|gyttja|peat|charcoal|wood(?: cellulose)?|twigs?|needles?|leaves|leaf|seeds?|fruits?|pollen(?: concentrate)?|shells?|pelecypod[a-z ]*|foraminifera|sphagnum[a-z ]*|carex[a-z ]*|macrofossils?|plant(?: remains| material| macrofossils?)?|organics?|humates?|humic acids?|bone|conifer needles?|terrestrial [a-z ]{3,30}|ash|tephra)\b/i;

function labRegex() {
  const extra = ['UOC', 'LACUFF', 'CAIS', 'ACC', 'NOSAMS', 'ISGS', 'WW', 'NTUAMS', 'SacA', 'VERA', 'FTMC', 'YAUG', 'DeA', 'ICA', 'TKA', 'RICH', 'BGS', 'GIA'];
  const all = [...new Set([...LAB_PREFIXES, ...extra])].sort((a, b) => b.length - a.length);
  const long = all.filter((p) => p.length > 2).map((p) => p.replace(/-/g, String.raw`\s*[-–]\s*`)).join('|');
  const short = all.filter((p) => p.length <= 2).join('|');
  // long prefixes: optional separator; short ones (AA, OS, TO…) need a hyphen to avoid false hits
  return new RegExp(String.raw`(?<![A-Za-z0-9])(?:(${long})\s*[-–*]?\s*(\d{3,7}(?:[-.]\d{1,4})?)|(${short})\s*[-–]\s*(\d{3,7}))(?!\d)`, 'gi');
}
let LAB_RE;

const NUM = String.raw`\d{1,3}(?: \d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const PM = String.raw`(?:±|\u0005|\+\/[-−]|\+[-−]|\+\s*\/\s*[-−])`;

function numbersIn(s) {
  // ranges (depth or calibrated intervals) and single numbers, in order
  const toks = [];
  const re = /(\d+(?:\.\d+)?)\s*(?:[-–]|\be\b|to)\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)/g;
  for (const m of s.matchAll(re)) {
    if (m[3] != null) toks.push({ n: parseFloat(m[3]), i: m.index });
    else toks.push({ a: parseFloat(m[1]), b: parseFloat(m[2]), i: m.index });
  }
  return toks;
}

const depthOf = (d) => (d.b != null ? { depth: (d.a + d.b) / 2, thickness: Math.abs(d.b - d.a) } : { depth: d.n });

function readRow(after, before) {
  const row = {};
  let age = after.match(new RegExp(`(${NUM})\\s*${PM}\\s*(\\d+(?:\\.\\d+)?)`));
  let side = after;
  if (!age) {
    const all = [...before.matchAll(new RegExp(`(${NUM})\\s*${PM}\\s*(\\d+(?:\\.\\d+)?)`, 'g'))];
    if (all.length) { age = all[all.length - 1]; side = before; }
  }
  if (age) {
    row.age = parseFloat(age[1].replace(/ /g, ''));
    row.error = parseFloat(age[2]);
    const toks = numbersIn(side.slice(0, age.index)).filter((t) => t.b != null || t.n < 100000);
    const d = side === after ? toks[toks.length - 1] : toks[0];
    if (d) Object.assign(row, depthOf(d));
    row.pmc = /pMC|percent modern/i.test(side.slice(age.index, age.index + age[0].length + 12));
    return row;
  }
  // no ± sign: columns like "Bulk sediment 35.5 - 36 879 16 760" → depth, age, error
  const toks = numbersIn(after.slice(0, 160));
  for (let i = 0; i + 1 < toks.length; i++) {
    const a = toks[i], e = toks[i + 1];
    if (a.n == null || e.n == null) continue;
    if (a.n >= 20 && a.n <= 60000 && e.n >= 5 && e.n <= 3000 && e.n <= Math.max(30, a.n / 2) && Number.isInteger(e.n)) {
      row.age = a.n; row.error = e.n;
      if (toks[i - 1]) Object.assign(row, depthOf(toks[i - 1]));
      break;
    }
  }
  return row;
}

export function findDates(text) {
  LAB_RE ||= labRegex();
  const t = String(text).replace(/−/g, '-');
  const hits = [...t.matchAll(LAB_RE)].map((m) => {
    const prefix = (m[1] || m[3]).replace(/\s+/g, '');
    return { lab: `${prefix}-${m[2] || m[4]}`, index: m.index, end: m.index + m[0].length };
  });
  const dates = [];
  const seen = new Set();
  hits.forEach((h, k) => {
    const key = h.lab.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) return;
    const next = hits[k + 1]?.index ?? h.end + 220;
    const after = t.slice(h.end, Math.min(next, h.end + 220));
    const prevEnd = hits[k - 1]?.end ?? 0;
    const lineStart = t.lastIndexOf('\n', h.index - 1) + 1;
    const before = t.slice(Math.max(prevEnd, lineStart, h.index - 120), h.index);
    const row = readRow(after, before);
    if (row.age == null) return;
    seen.add(key);
    const matM = (after.match(MATERIALS) || before.match(MATERIALS) || [])[1];
    const context = before + ' ' + after;
    dates.push({
      labNumber: h.lab, age: row.age, error: row.error ?? null,
      depth: row.depth ?? null, thickness: row.thickness ?? null,
      material: (matM || '').trim(),
      method: /\bOSL\b|luminescence/i.test(context) ? 'OSL' : 'Carbon-14',
      units: row.pmc ? 'Percent modern carbon' : 'Radiocarbon years BP',
      index: h.index,
      raw: t.slice(h.index, h.end + 100).replace(/\s+/g, ' ').slice(0, 140),
    });
  });
  return dates;
}

// ---------- bibliographic fallbacks when no DOI/CrossRef ----------
export function findYear(text) {
  const head = text.slice(0, 3000);
  const m = head.match(/(?:©|\(c\)|Copyright|Published|Received|Accepted)[^0-9]{0,30}((?:19|20)\d{2})/i) || head.match(/\b((?:19|20)\d{2})\b/);
  return m ? { value: parseInt(m[1], 10), index: m.index } : null;
}

export function findEmails(text) {
  return [...new Set((text.slice(0, 8000).match(/[\w.+-]+@[\w-]+\.[\w.-]+[a-z]/gi) || []))];
}

// Run everything; returns an array of {path, value, page, snippet, confidence}.
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const AMERICAS = /United States|Canada|Mexico|Guatemala|Belize|Honduras|Nicaragua|Costa Rica|Panama|Colombia|Venezuela|Ecuador|Peru|Bolivia|Brazil|Chile|Argentina|Paraguay|Uruguay|Guyana|Suriname|Cuba|Jamaica|Haiti|Dominican Republic|Bahamas|Greenland/;

// `site` pins extraction to one named site (for papers that describe several).
export function extractFromPublication(pages, fileName, { title = '', site = '' } = {}) {
  const { text, pageAt } = joinPages(pages);
  const found = [];
  const add = (path, value, index, confidence, raw) => {
    if (value == null || value === '') return;
    found.push({
      path, value, confidence,
      source: `${fileName}${index != null && pageAt(index) ? `, p.${pageAt(index)}` : ''}`,
      snippet: raw || (index != null ? snippet(text, index) : ''),
    });
  };

  const doi = findDOI(text);
  if (doi) add('publication.DOI', doi, text.indexOf(doi), 0.95);

  let names = findSiteNames(text, title);
  if (site) {
    const i = text.toLowerCase().indexOf(site.toLowerCase());
    names = [{ value: site, index: i < 0 ? null : i, inTitle: true, pinned: true }, ...names.filter((n) => n.value.toLowerCase() !== site.toLowerCase())];
  } else if (names[0]) {
    add('site.SiteName', names[0].value, names[0].index, names[0].inTitle ? 0.75 : Math.min(0.4 + names[0].count * 0.03, 0.65));
  }
  names.slice(1).forEach((n) => add('site.SiteName', n.value, n.index, 0.3));
  const siteName = names[0]?.value;
  const geo = findGeography(text);

  // Prefer the coordinate pair that follows a mention of the site name (usually "Study site")
  const norm = normalizeCoordText(text);
  const mentions = siteName ? [...norm.matchAll(new RegExp(escapeRe(siteName), 'gi'))].map((m) => m.index) : [];
  const coords = findCoordinates(text);
  let chosen = coords.find((c) => mentions.some((i) => c.index - i >= 0 && c.index - i < 400));
  let conf = chosen ? (site ? 0.85 : 0.8) : 0.6;
  if (!chosen && mentions.length) {
    // site tables: "Frog Lake 48.48, 123.59 Goldstream …" (no symbols; sign from the region)
    for (const i of mentions) {
      const m = norm.slice(i + siteName.length, i + siteName.length + 40).match(/^\s*[,;:(]?\s*(-?\d{1,2}\.\d{2,})\s*[,;/]\s*(-?\s*\d{1,3}\.\d{2,})\b/);
      if (!m) continue;
      let lon = parseFloat(m[2].replace(/\s+/g, ''));
      if (lon > 0 && geo.country && AMERICAS.test(geo.country.value)) lon = -lon;
      chosen = { lat: parseFloat(m[1]), lon, index: i, raw: norm.slice(i, i + siteName.length + m[0].length) };
      conf = 0.6;
      break;
    }
  }
  if (!chosen) { chosen = coords.find((x) => x.hemispheres) || coords[0]; conf = site ? 0.45 : 0.6; }
  if (chosen) {
    add('site.LatNorth', chosen.lat, chosen.index, conf, chosen.raw);
    add('site.LongEast', chosen.lon, chosen.index, conf, chosen.raw);
  }
  if (coords.length > 1 || (coords.length && !chosen)) {
    found.push({ path: 'site._altCoords', value: coords.slice(0, 12).map((x) => ({ lat: x.lat, lon: x.lon, raw: x.raw, page: pageAt(x.index) })), confidence: 0.3, source: fileName });
  }

  const anchor = chosen?.index ?? (mentions[0] ?? null);
  const alts = findAltitudes(norm);
  const alt = nearest(alts, anchor, 300) || alts[0];
  if (alt) add('site.Altitude', alt.value, alt.index, anchor != null && nearest(alts, anchor, 300) ? 0.7 : 0.5, alt.raw);
  const wds = findWaterDepths(norm);
  const wd = nearest(wds, anchor, 2000) || wds[0];
  if (wd) add('collectionUnit.WaterDepth', wd.value, wd.index, 0.5, wd.raw);

  if (geo.country) add('site.Country', geo.country.value, geo.country.index, geo.country.implied ? 0.5 : 0.6);
  if (geo.state) add('site.State', geo.state.value, geo.state.index, 0.55);
  if (geo.county) add('site.County', geo.county.value, geo.county.index, 0.45);

  const types = guessDatasetType(text);
  if (types[0]) add('dataset.DatasetType', types[0].value, null, 0.5, `keyword “${types[0].value}” appears ${types[0].count}×`);

  const dev = findDevice(text);
  if (dev) add('collectionUnit.CollectionDevice', dev.value, dev.index, 0.6);
  const env = findDepEnv(text, siteName);
  if (env) add('collectionUnit.DepositionalEnvironment', env.value, env.index, 0.45);
  const cd = findCollectionDate(text);
  if (cd) add('collectionUnit.CollectionDate', cd.value, cd.index, 0.5, cd.raw);
  // "core" also appears in URLs (cambridge.org/core) and prose; require coring language
  const coring = text.match(/\b(sediment cores?|cored|coring|corer|piston cores?|cores? (?:was|were) (?:taken|collected|retrieved|recovered|obtained))\b/i);
  // peat monoliths, cut banks and exposures are "Section" in hand-made files
  const section = text.match(/\b(peat monoliths?|monoliths?|peat blocks?|exposed sections?|stratigraphic sections?|cut ?banks?|outcrops?|exposures?)\b/i);
  const monolithCount = (text.match(/\bmonoliths?\b|\bpeat blocks?\b|\bexposed sections?\b/gi) || []).length;
  const coringCount = (text.match(/\b(sediment cores?|cored|coring|corer)\b/gi) || []).length;
  if (section && monolithCount >= Math.max(1, coringCount)) add('collectionUnit.CollectionType', 'Section', section.index, 0.55, section[0]);
  else if (coring) add('collectionUnit.CollectionType', 'Core', coring.index, 0.5, coring[0]);
  else if (/\b(excavat|specimens? (?:were )?collected|fossils? (?:were )?collected|test pit|trench)\w*/i.test(text) || /\b(cave|rockshelter|rock shelter)\b/i.test(siteName || '')) {
    add('collectionUnit.CollectionType', 'Excavation', null, 0.45, 'fossils collected, no coring described');
  }

  // age-model software named in the methods ("…modelled in Bacon…")
  const models = [['Bacon', /\bbacon\b|rbacon/gi], ['OxCal', /\boxcal\b/gi], ['clam', /\bclam\b/g], ['Bchron', /\bbchron\b/gi]]
    .map(([v, re]) => ({ v, n: (text.match(re) || []).length })).filter((m) => m.n).sort((a, b) => b.n - a.n);
  if (models[0]) add('dataset.AgeModel', models[0].v, text.search(new RegExp(models[0].v, 'i')), 0.6);

  const yr = findYear(text);
  if (yr) add('publication.Year', yr.value, yr.index, 0.3);

  const dates = findDates(text);
  if (dates.length) {
    found.push({
      path: 'geochron', value: dates.map((d) => ({ ...d, source: `${fileName}, p.${pageAt(d.index)}` })),
      confidence: 0.6, source: fileName,
    });
  }
  const emails = findEmails(text);
  if (emails.length) found.push({ path: 'contacts._emails', value: emails, confidence: 0.5, source: fileName });

  return found;
}
