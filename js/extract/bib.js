// Bibliographic metadata: CrossRef lookup by DOI, RIS and BibTeX parsing,
// author-name splitting and citation formatting.

export function splitName(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let family, given;
  if (s.includes(',')) {
    [family, given] = s.split(',').map((x) => x.trim());
  } else {
    const parts = s.split(' ');
    // keep particles with the family name: "van der Knaap", "de Vernal"
    let i = parts.length - 1;
    while (i > 1 && /^(van|von|der|de|del|della|di|da|du|le|la|den|ter|dos|das)$/i.test(parts[i - 1])) i--;
    family = parts.slice(i).join(' ');
    given = parts.slice(0, i).join(' ');
  }
  // "Karl-Heinz" → "K.-H.", "Ana María" → "A.M.", "R.S." stays "R.S."
  const initials = (given || '').split(/\s+/).filter(Boolean).map((part) => part.replace(/\./g, ' ').trim().split(/\s+/)
    .map((p) => p.split('-').filter(Boolean).map((q) => q[0].toUpperCase() + '.').join('-')).join('')).join('');
  return {
    FamilyName: family,
    GivenNames: given || '',
    LeadingInitials: initials,
    FullContactName: given ? `${family}, ${given}` : family,
    ShortContactName: initials ? `${family}, ${initials}` : family,
  };
}

// Neotoma citation style, as in hand-made Tilia files:
// "Galka, M., K.-H. Knorr, and A. Feurdean. 2025. Title. Journal 0(0):1-22. [DOI: 10.x/y]"
export function formatCitation(p) {
  const names = (p.authors || []).map((a, i) => {
    const ini = a.LeadingInitials || '';
    if (i === 0) return ini ? `${a.FamilyName}, ${ini}` : a.FamilyName;
    return ini ? `${ini} ${a.FamilyName}` : a.FamilyName;
  }).filter(Boolean);
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}` : (names[0] || '');
  const bits = [];
  if (who) bits.push(who.endsWith('.') ? who : `${who}.`);
  if (p.Year) bits.push(`${p.Year}.`);
  if (p.ArticleTitle) bits.push(p.ArticleTitle.replace(/\.$/, '') + '.');
  let src = p.Journal || '';
  if (src && p.Volume) src += ` ${p.Volume}`;
  if (src && p.Issue) src += `(${p.Issue})`;
  if (src && p.Pages) src += `:${p.Pages}`;
  if (src) bits.push(src + '.');
  if (p.DOI) bits.push(`[DOI: ${p.DOI}]`);
  return bits.join(' ');
}

// Neotoma publication types (as written in Tilia files)
const typeMap = { 'journal-article': 'journal article', 'book-chapter': 'book chapter', 'book': 'authored book', 'edited-book': 'edited book', 'dissertation': 'doctoral thesis', 'report': 'authored report', 'proceedings-article': 'journal article', JOUR: 'journal article', CHAP: 'book chapter', BOOK: 'authored book', THES: 'doctoral thesis', RPRT: 'authored report', article: 'journal article', incollection: 'book chapter', inbook: 'book chapter', phdthesis: 'doctoral thesis', mastersthesis: "master's thesis", techreport: 'authored report' };

function fromCrossref(m, doi = '') {
  // Tilia records the print year; CrossRef's 'issued' is often the earlier online date
  const year = m['published-print']?.['date-parts']?.[0]?.[0] || m.issued?.['date-parts']?.[0]?.[0] || m.published?.['date-parts']?.[0]?.[0];
  return {
    PubType: typeMap[m.type] || 'journal article',
    Year: year || '',
    ArticleTitle: (m.title || [])[0]?.replace(/<[^>]+>/g, '') || '',
    Journal: (m['container-title'] || [])[0] || '',
    Volume: m.volume || '',
    Issue: m.issue || '',
    Pages: m.page || '',
    Publisher: m.publisher || '',
    DOI: m.DOI || doi,
    authors: (m.author || []).map((a) => {
      const c = splitName(a.family ? `${a.family}, ${a.given || ''}` : a.name);
      if (!c) return null;
      const orcid = a.ORCID && String(a.ORCID).match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/i);
      if (orcid) c.crossrefOrcid = { id: orcid[0].toUpperCase(), authenticated: !!a['authenticated-orcid'] };
      const affs = (a.affiliation || []).map((x) => x.name).filter(Boolean);
      if (affs.length) c.affiliations = affs;
      return c;
    }).filter(Boolean),
  };
}

// Fetch metadata from CrossRef. Sends only the DOI.
export async function crossrefLookup(doi) {
  const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  if (!res.ok) throw new Error(`CrossRef returned ${res.status}`);
  return fromCrossref((await res.json()).message, doi);
}

const titleTokens = (s) => new Set(String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/<[^>]+>/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 2));
export function titleSimilarity(a, b) {
  const x = titleTokens(a), y = titleTokens(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.max(x.size, y.size);
}

// Find a paper's CrossRef record from its title (for PDFs without a printed DOI).
// Sends only the title. Returns null unless the best hit's title clearly matches.
export async function crossrefSearchTitle(title) {
  if (!title || title.length < 20) return null;
  const res = await fetch(`https://api.crossref.org/works?rows=3&query.bibliographic=${encodeURIComponent(title.slice(0, 300))}`);
  if (!res.ok) throw new Error(`CrossRef returned ${res.status}`);
  const items = (await res.json()).message?.items || [];
  const best = items.map((m) => ({ m, sim: titleSimilarity(title, (m.title || [])[0]) })).sort((a, b) => b.sim - a.sim)[0];
  return best && best.sim >= 0.8 ? { ...fromCrossref(best.m), matchedBy: 'title', similarity: best.sim } : null;
}

export function parseRIS(text) {
  const recs = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9])\s{2}-\s?(.*)$/);
    if (!m) continue;
    const [, tag, val] = m;
    if (tag === 'TY') { cur = { PubType: typeMap[val.trim()] || 'journal article', authors: [] }; continue; }
    if (!cur) continue;
    if (tag === 'ER') { recs.push(cur); cur = null; continue; }
    if (tag === 'AU' || tag === 'A1') cur.authors.push(splitName(val));
    else if (tag === 'TI' || tag === 'T1') cur.ArticleTitle = val.trim();
    else if (tag === 'JO' || tag === 'T2' || tag === 'JF') cur.Journal = cur.Journal || val.trim();
    else if (tag === 'PY' || tag === 'Y1' || tag === 'DA') cur.Year = cur.Year || (val.match(/\d{4}/) || [''])[0];
    else if (tag === 'VL') cur.Volume = val.trim();
    else if (tag === 'IS') cur.Issue = val.trim();
    else if (tag === 'SP') cur.Pages = val.trim();
    else if (tag === 'EP') cur.Pages = `${cur.Pages || ''}-${val.trim()}`;
    else if (tag === 'DO') cur.DOI = val.trim();
    else if (tag === 'PB') cur.Publisher = val.trim();
  }
  if (cur) recs.push(cur);
  return recs;
}

export function parseBibTeX(text) {
  const recs = [];
  for (const m of text.matchAll(/@(\w+)\s*\{[^,]*,([\s\S]*?)\n\}/g)) {
    const fields = {};
    for (const f of m[2].matchAll(/(\w+)\s*=\s*(?:\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)"|(\d+))/g)) {
      fields[f[1].toLowerCase()] = (f[2] ?? f[3] ?? f[4] ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    }
    recs.push({
      PubType: typeMap[m[1].toLowerCase()] || 'journal article',
      ArticleTitle: fields.title || '',
      Journal: fields.journal || fields.booktitle || '',
      Year: fields.year || '',
      Volume: fields.volume || '',
      Issue: fields.number || '',
      Pages: (fields.pages || '').replace(/-+/, '-'),
      DOI: fields.doi || '',
      Publisher: fields.publisher || '',
      authors: (fields.author || '').split(/\s+and\s+/i).map(splitName).filter(Boolean),
    });
  }
  return recs;
}
