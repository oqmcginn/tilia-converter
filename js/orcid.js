// ORCID iD matching for contacts.
//
// Evidence, strongest first:
//   1. Publisher-supplied ORCID in CrossRef metadata (authenticated or not)
//   2. The person's ORCID record lists this paper's DOI  (ORCID search: doi-self)
//   3. An iD printed in the paper, checksum-valid, whose record name matches
//   4. Name search, scored on given-name agreement, affiliation overlap,
//      shared journal, and how many of their works are on paleo/ecology topics
// Only 1–3 can reach "Confirmed". Name-only evidence is capped at 0.85 and is
// auto-selected only when it reaches "Likely" (0.7) and clearly beats the rest.

const API = 'https://pub.orcid.org/v3.0';
const TOPIC = /pollen|palyno|pal(a)?eo|holocene|pleistocene|quaternary|glacia|sediment|lake|lacustrine|peat|fossil|diatom|ostraco|chironomid|charcoal|radiocarbon|tephra|vegetation|climate|neotoma|macrofossil|testate|biogeograph|ecolog/i;

// ---------- identifiers ----------
export function normalizeOrcid(s) {
  const m = String(s || '').toUpperCase().match(/(\d{4})-?(\d{4})-?(\d{4})-?(\d{3}[\dX])/);
  return m ? `${m[1]}-${m[2]}-${m[3]}-${m[4]}` : null;
}

// ISO 7064 MOD 11-2, as specified by ORCID
export function orcidChecksumOK(id) {
  const n = normalizeOrcid(id);
  if (!n) return false;
  const digits = n.replace(/-/g, '');
  let total = 0;
  for (const ch of digits.slice(0, 15)) total = (total + Number(ch)) * 2;
  const result = (12 - (total % 11)) % 11;
  return digits[15] === (result === 10 ? 'X' : String(result));
}

// iDs printed in a paper (often in the author block or footnotes)
export function findOrcidsInText(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text).matchAll(/(?:orcid\.org\/|ORCID(?:\s*iD)?[:\s]*)?\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/gi)) {
    const id = normalizeOrcid(m[1]);
    if (!id || seen.has(id) || !orcidChecksumOK(id)) continue;
    seen.add(id);
    out.push({ id, index: m.index, context: text.slice(Math.max(0, m.index - 120), m.index + 40) });
  }
  return out;
}

// Institution names mentioned in a paper's front matter
export function findAffiliations(text) {
  const head = String(text).slice(0, 12000);
  const re = /\b((?:University|Université|Universidad|Universität|Universidade|Università) (?:of |de |del |di |do )?[A-Z][\w'’. -]{2,40}|[A-Z][\w'’.-]+(?: [A-Z][\w'’.-]+){0,3} (?:University|College|Institute|Survey|Museum|Laboratory)(?: of [A-Z][\w -]{2,30})?|(?:Institute|Museum|Laboratory) (?:of|for) [A-Z][\w -]{2,40})/g;
  const set = new Set();
  for (const m of head.matchAll(re)) set.add(m[1].replace(/[\s,.;]+$/, '').trim());
  return [...set].slice(0, 30);
}

// ---------- name & affiliation comparison ----------
const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim();

// 'full' = given names agree, 'initials' = compatible initials only, null = conflict
export function nameAgreement(contact, cand) {
  const fam = (s) => fold(s).replace(/-/g, ' ');
  if (fam(contact.FamilyName) !== fam(cand.family)) {
    // allow hyphenated/double family names where one contains the other
    const a = fam(contact.FamilyName), b = fam(cand.family);
    if (!a || !b || !(a.split(' ').includes(b) || b.split(' ').includes(a))) return null;
  }
  const g1 = fold(contact.GivenNames || contact.LeadingInitials).replace(/-/g, ' ').split(' ').filter(Boolean);
  const g2 = fold(cand.given).replace(/-/g, ' ').split(' ').filter(Boolean);
  if (!g1.length || !g2.length) return 'initials';
  if (g1[0][0] !== g2[0][0]) return null;
  // compare first given names; an initial on either side only has to agree on its letter
  if (g1[0].length > 1 && g2[0].length > 1) {
    if (g1[0] === g2[0]) return 'full';
    // "Bob" vs "Robert" can't be settled here; treat differing first names as a conflict
    return null;
  }
  return 'initials';
}

const STOP = new Set('university universite universidad universitat universidade universita of de del di do the and institute college department dept school faculty centre center for laboratory lab museum survey national state research sciences science'.split(' '));
const sigTokens = (s) => fold(s).split(/[\s-]+/).filter((t) => t.length > 2 && !STOP.has(t));

export function affiliationOverlap(candInstitutions, paperAffiliations) {
  let best = null;
  for (const a of paperAffiliations) {
    const ta = sigTokens(a);
    if (!ta.length) continue;
    for (const b of candInstitutions) {
      const tb = new Set(sigTokens(b));
      const shared = ta.filter((t) => tb.has(t));
      if (shared.length && shared.length / Math.min(ta.length, tb.size) >= 0.5) {
        if (!best || shared.length > best.shared) best = { shared: shared.length, paper: a, orcid: b };
      }
    }
  }
  return best;
}

// ---------- scoring ----------
// cand: {id, given, family, institutions[], works?: {count, dois:Set, journals:Set, topical}}
// ctx: {dois[], journals[], affiliations[] (paper-wide), authorAffiliations[] (this author)}
export function scoreCandidate(contact, cand, ctx) {
  const agree = nameAgreement(contact, cand);
  if (!agree) return null;
  const evidence = [];
  let score = agree === 'full' ? 0.35 : 0.25;
  evidence.push(agree === 'full' ? 'Family and given names match' : 'Family name and initials match');

  const affs = [...(ctx.authorAffiliations || []), ...(ctx.affiliations || [])];
  const aff = affiliationOverlap(cand.institutions || [], affs);
  if (aff) { score += 0.25; evidence.push(`Affiliation matches: ${aff.orcid}`); }

  if (cand.works) {
    const w = cand.works;
    const doiHit = (ctx.dois || []).find((d) => w.dois.has(d.toLowerCase()));
    if (doiHit) return { ...cand, score: 0.97, evidence: [`ORCID record lists this paper (${doiHit})`, ...evidence] };
    const jHit = (ctx.journals || []).find((j) => j && w.journals.has(fold(j)));
    if (jHit) { score += 0.1; evidence.push(`Has published in ${jHit}`); }
    if (w.count) {
      const share = w.topical / w.count;
      score += 0.25 * Math.min(1, share * 1.5);
      if (w.topical) evidence.push(`${w.topical} of ${w.count} works on related topics`);
      else evidence.push(`None of ${w.count} works look related`);
    } else {
      evidence.push('ORCID record lists no works');
    }
  }
  return { ...cand, score: Math.min(0.85, Math.round(score * 100) / 100), evidence };
}

export function confidenceLabel(score) {
  if (score >= 0.9) return 'Confirmed';
  if (score >= 0.7) return 'Likely';
  if (score >= 0.4) return 'Possible';
  return 'Weak';
}

// Decide whether one candidate is clear enough to select automatically.
export function decide(scored) {
  const list = scored.filter(Boolean).sort((a, b) => b.score - a.score);
  if (!list.length) return { status: 'none', selected: null, candidates: [] };
  const [top, next] = list;
  const clear = top.score >= 0.9 || (top.score >= 0.7 && (!next || top.score - next.score >= 0.15));
  return {
    status: clear ? (top.score >= 0.9 ? 'confirmed' : 'likely') : 'ambiguous',
    selected: clear ? top.id : null,
    candidates: list.slice(0, 5),
  };
}

// ---------- network ----------
async function getJSON(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`ORCID API ${res.status}`);
  return res.json();
}

const q = (s) => `"${String(s).replace(/["\\]/g, ' ').trim()}"`;

async function searchByDoi(fetchImpl, doi) {
  const d = await getJSON(fetchImpl, `${API}/expanded-search/?q=${encodeURIComponent(`doi-self:${q(doi)}`)}&rows=100`);
  return (d['expanded-result'] || []).map(toCand);
}

async function searchByName(fetchImpl, contact, affiliation) {
  const given = fold(contact.GivenNames || contact.LeadingInitials).split(' ').filter(Boolean)[0] || '';
  let query = `family-name:${q(contact.FamilyName)}`;
  if (given.length > 1) query += ` AND given-names:${q(given)}`;
  else if (given) query += ` AND given-names:${given}*`;
  if (affiliation) query += ` AND affiliation-org-name:(${sigTokens(affiliation).slice(0, 4).join(' AND ')})`;
  const d = await getJSON(fetchImpl, `${API}/expanded-search/?q=${encodeURIComponent(query)}&rows=${affiliation ? 10 : 30}`);
  return { total: d['num-found'] || 0, results: (d['expanded-result'] || []).map(toCand) };
}

async function fetchWorks(fetchImpl, id) {
  const d = await getJSON(fetchImpl, `${API}/${id}/works`);
  const dois = new Set(), journals = new Set();
  let topical = 0;
  for (const g of d.group || []) {
    const s = (g['work-summary'] || [])[0];
    if (!s) continue;
    for (const e of s['external-ids']?.['external-id'] || []) if (e['external-id-type'] === 'doi') dois.add(String(e['external-id-value']).toLowerCase());
    const journal = s['journal-title']?.value;
    if (journal) journals.add(fold(journal));
    if (TOPIC.test(`${s.title?.title?.value || ''} ${journal || ''}`)) topical++;
  }
  return { count: (d.group || []).length, dois, journals, topical };
}

async function fetchName(fetchImpl, id) {
  const d = await getJSON(fetchImpl, `${API}/${id}/person`);
  return { given: d.name?.['given-names']?.value || '', family: d.name?.['family-name']?.value || '' };
}

const toCand = (r) => ({ id: r['orcid-id'], given: r['given-names'] || '', family: r['family-names'] || '', institutions: r['institution-name'] || [] });

// Run the whole matching pass. Mutates each contact's `.orcid` result and returns a summary.
// sources: {dois[], journals[], affiliations[], printed[{id}], crossref: Map(familyLower → {id, authenticated})}
export async function resolveOrcids(contacts, sources, { fetchImpl = fetch.bind(globalThis), onProgress, force = false } = {}) {
  const todo = contacts.filter((c) => c.FamilyName && (force || !c.orcid?.checked) && !c.orcid?.userPicked);
  if (!todo.length) return { checked: 0 };
  const ctx = { dois: sources.dois || [], journals: sources.journals || [], affiliations: sources.affiliations || [] };
  const results = new Map(todo.map((c) => [c, []]));
  const done = new Set();

  // 1. publisher-supplied iDs
  for (const c of todo) {
    if (c.crossrefOrcid) {
      results.get(c).push({ id: c.crossrefOrcid.id, given: c.GivenNames, family: c.FamilyName, institutions: c.affiliations || [],
        score: c.crossrefOrcid.authenticated ? 0.99 : 0.92,
        evidence: [c.crossrefOrcid.authenticated ? 'Supplied by the publisher and authenticated by the author (CrossRef)' : 'Supplied by the publisher (CrossRef)'] });
      done.add(c);
    }
  }

  // 2. people who list one of these DOIs on their record
  for (const doi of ctx.dois) {
    onProgress?.(`Searching ORCID for authors of ${doi}…`);
    let hits = [];
    try { hits = await searchByDoi(fetchImpl, doi); } catch (e) { onProgress?.(`DOI search failed: ${e.message}`); }
    for (const c of todo) {
      for (const h of hits) {
        const agree = nameAgreement(c, h);
        if (!agree) continue;
        results.get(c).push({ ...h, score: agree === 'full' ? 0.97 : 0.93, evidence: [`ORCID record lists this paper (${doi})`, agree === 'full' ? 'Family and given names match' : 'Family name and initials match'] });
        done.add(c);
      }
    }
  }

  // 3. iDs printed in the paper: look up each record's name and attach to the matching contact
  for (const p of sources.printed || []) {
    try {
      const name = await fetchName(fetchImpl, p.id);
      for (const c of todo) {
        const agree = nameAgreement(c, name);
        if (!agree) continue;
        const existing = results.get(c).find((r) => r.id === p.id);
        if (existing) { existing.score = Math.max(existing.score, 0.98); existing.evidence.push('Also printed in the paper'); }
        else results.get(c).push({ id: p.id, ...name, institutions: [], score: 0.93, evidence: ['Printed in the paper; checksum valid', 'Name on the ORCID record matches'] });
        done.add(c);
      }
    } catch { /* unreachable record: skip */ }
  }

  // 4. name search for everyone still unresolved
  let i = 0;
  for (const c of todo) {
    i++;
    if (done.has(c)) continue;
    onProgress?.(`Searching ORCID by name (${i}/${todo.length}): ${c.FullContactName || c.FamilyName}`);
    let found;
    try { found = await searchByName(fetchImpl, c); } catch (e) { c.orcid = { status: 'error', error: e.message, candidates: [], checked: Date.now() }; continue; }
    // Common names overflow one page of results; re-search within each known affiliation
    if (found.total > found.results.length) {
      const affs = [...(c.affiliations || []), ...ctx.affiliations].filter((a) => sigTokens(a).length).slice(0, 4);
      for (const a of affs) {
        try {
          const more = await searchByName(fetchImpl, c, a);
          for (const r of more.results) if (!found.results.some((x) => x.id === r.id)) found.results.unshift(r);
        } catch { /* keep what we have */ }
      }
    }
    const compatible = found.results.filter((r) => nameAgreement(c, r));
    // fetch works for the most plausible few to score topic/journal/DOI evidence
    const cctx = { ...ctx, authorAffiliations: c.affiliations || [] };
    const pre = compatible.map((r) => scoreCandidate(c, r, cctx)).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 6);
    for (const cand of pre) {
      try { cand.works = await fetchWorks(fetchImpl, cand.id); } catch { /* score without works */ }
    }
    const scored = pre.map((cand) => scoreCandidate(c, cand, cctx));
    if (scored.length === 1 && found.total === 1) { scored[0].score = Math.min(0.85, scored[0].score + 0.1); scored[0].evidence.push('Only ORCID record with this name'); }
    if (found.total > found.results.length) scored.forEach((s) => s.evidence.push(`${found.total} ORCID records share this surname/initial`));
    results.get(c).push(...scored);
  }

  for (const c of todo) {
    if (c.orcid?.status === 'error') continue;
    // merge duplicates of the same iD from different evidence paths
    const byId = new Map();
    for (const r of results.get(c)) {
      const prev = byId.get(r.id);
      if (!prev) byId.set(r.id, { ...r, evidence: [...r.evidence] });
      else { prev.score = Math.max(prev.score, r.score); prev.evidence.push(...r.evidence.filter((e) => !prev.evidence.includes(e))); }
    }
    const decision = decide([...byId.values()].map(({ works, ...rest }) => rest));
    c.orcid = { ...decision, checked: Date.now() };
  }
  return { checked: todo.length };
}
