// Non-taxon variables (charcoal, geochemistry, isotopes, sample quantity): spreadsheet
// header → Neotoma variable { code, name, element, units, group }, following the mappings
// used in the lab's hand-converted Tilia files (Galka, Dewey Lake, Round Lake, Kimble Pond,
// O'Brien, Cave Springs Cave).

const ELEMENTS = {
  C: 'Carbon', N: 'Nitrogen', P: 'Phosphorus', S: 'Sulfur', Ca: 'Calcium', Mg: 'Magnesium', K: 'Potassium', Na: 'Sodium',
  Fe: 'Iron', Mn: 'Manganese', Al: 'Aluminum', Si: 'Silicon', Ti: 'Titanium', Zn: 'Zinc', Cu: 'Copper', Pb: 'Lead',
  Hg: 'Mercury', Sr: 'Strontium', Ba: 'Barium', Rb: 'Rubidium', Zr: 'Zirconium', Br: 'Bromine', Cl: 'Chlorine',
  Ni: 'Nickel', Cr: 'Chromium', Co: 'Cobalt', As: 'Arsenic', Cd: 'Cadmium', V: 'Vanadium', Y: 'Yttrium',
};

// "(mg/g)", "%", "ppm", "μg/g" → Neotoma units as written in hand-made files
function unitsOf(header, fallback) {
  const h = header.replace(/µ/g, 'μ');
  if (/%|percent|\bwt\.?\s*%/i.test(h)) return 'percent';
  const m = h.match(/\(([^)]+)\)|\b(mg\/g|μg\/g|ug\/g|ng\/g|μg\/kg|ug\/kg|mg\/kg|ppm|ppb|cm\^?3|cc)\b/i);
  const u = (m?.[1] || m?.[2] || '').trim();
  if (!u) return fallback;
  if (/^(ug|μg)\/g$/i.test(u)) return 'μg/g';
  if (/^(ug|μg)\/kg$/i.test(u)) return 'μg/kg';
  if (/^cm\^?3$|^cc$/i.test(u)) return /cc/i.test(u) ? 'cc' : 'cm^3';
  return u;
}

export function proxyVariable(header, sheetName = '', subhead = '') {
  const h = String(header || '').replace(/\s+/g, ' ').trim();
  const both = `${h} ${sheetName}`;
  // derived values (rates, accumulation, influx, concentrations per area/time) are not raw observations
  if (/accum|influx|\brate|\bMAR\b|per (?:cm2|year)|\/yr|z-score|std ?dev|\bsd\b|concentration/i.test(h) || /\bCHAR\b/.test(h)) return null;

  // charcoal counts, with size class from the header or sheet name ("larger than 150 microns", ">125u")
  if (/charcoal|\bchar\b|macrochar/i.test(h) || (/charcoal/i.test(sheetName) && /^>?\s*\d+\s*(u|μm|µm|um|micron)/i.test(h))) {
    if (/area|mm\^?2|volume|vol\b/i.test(h)) return null;
    // size class from the header/sheet (">125u", "larger than 150 microns") or a sub-heading ("Big 250")
    const size = both.match(/(?:larger than|>|greater than)\s*(\d+)\s*(?:u\b|μm|µm|um|microns?)/i) || String(subhead).match(/\b(\d{2,4})\b/);
    const units = /particles/i.test(h) ? 'particles' : /\bcount/i.test(h) ? 'count' : /number|pieces|\(#\)|#/i.test(h) || size ? 'number' : 'nisp';
    return { code: 'char', name: 'Charcoal', element: size ? `>${size[1]} µm` : 'fragment', units: /particles/i.test(h) ? 'particles' : units, group: 'CHAR' };
  }
  // sample size
  if (/sample\s*(vol|volume|quantity|size)|sediment\s*vol|^vol(ume)?\b|^amount$/i.test(h)) {
    return { code: 'samp.quant', name: 'Sample quantity', element: 'volume', units: unitsOf(h, 'cm^3'), group: 'LABO' };
  }
  // stable isotopes
  // "d18OVPDB": the reference can follow the element with no space
  // case-sensitive so the lowercase lookahead doesn't reject the "V" of VPDB
  const iso = h.match(/(?:δ|\b[dD])\s?(18|13|15|2|34)\s?([OCNHS])(?![a-z])/) || h.match(/^(δ|d)(D)\b/);
  if (iso) {
    const [mass, el] = iso[2] === 'D' ? ['2', 'H'] : [iso[1], iso[2].toUpperCase()];
    const ref = /VPDB|PDB/i.test(h) ? ' VPDB' : /VSMOW|SMOW/i.test(h) ? ' VSMOW' : /AIR/i.test(h) ? ' AIR' : '';
    const code = el === 'H' ? 'δ2H' : `d${mass}${el}`;
    return { code, name: `δ${mass}${el}`, element: 'bulk sediment', units: `per mille${ref}`, group: el === 'H' ? 'ELEM' : 'ITOP' };
  }
  if (/\bC\s*[:/]\s*N\b|TOC\s*\/\s*TN/i.test(h)) return { code: 'C:N', name: 'Carbon:Nitrogen', element: 'bulk sediment', units: 'ratio', group: 'ELRO' };
  if (/CaCO3/i.test(h) && !/isotope|δ|d13|d18/i.test(h)) return { code: 'CaCO3', name: 'Calcium carbonate', element: 'bulk sediment', units: 'percent', group: 'IORG' };
  // element concentrations: "C%", "N %", "Wt% C", "Ca (mg/g)", "Hg Concentration (μg/kg)"
  const el = h.match(/^(?:wt\.?\s*%\s*)?([A-Z][a-z]?)(?=\s*(?:%|\(|concentration|\s*$|\s+(?:mg|μg|ug|ng|ppm|ppb)))/);
  if (el && ELEMENTS[el[1]]) {
    return { code: el[1], name: ELEMENTS[el[1]], element: 'bulk sediment', units: unitsOf(h, 'percent'), group: 'ELEM' };
  }
  return null;
}
