// Controlled vocabularies and heuristics tables.
// Values follow Neotoma naming where known; everything stays editable in the UI.

export const DATASET_TYPES = [
  'pollen', 'plant macrofossil', 'diatom', 'ostracode', 'chironomid', 'charcoal',
  'testate amoebae', 'vertebrate fauna', 'insect', 'loss-on-ignition', 'geochemistry',
  'X-ray fluorescence (XRF)', 'physical sedimentology', 'water chemistry', 'stable isotope',
  'phytolith', 'dinoflagellates', 'foraminifera', 'cladocera', 'biomarker',
];

// keyword regex → dataset type, used to score publication text
export const DATASET_KEYWORDS = [
  ['pollen', /\bpollen\b|palynolog/gi],
  ['plant macrofossil', /macrofossil/gi],
  ['diatom', /\bdiatom/gi],
  ['ostracode', /ostraco[dq]/gi],
  ['chironomid', /chironomid/gi],
  ['charcoal', /\bcharcoal\b/gi],
  ['testate amoebae', /testate/gi],
  ['vertebrate fauna', /\b(vertebrate|NISP|faunal remains|mammal)/gi],
  ['loss-on-ignition', /loss[- ]on[- ]ignition|\bLOI\b/g],
  ['X-ray fluorescence (XRF)', /\bXRF\b|x-ray fluorescence/gi],
  ['phytolith', /phytolith/gi],
  ['cladocera', /cladocera/gi],
  ['foraminifera', /foraminifer/gi],
];

export const COLLECTION_TYPES = ['Core', 'Composite', 'Section', 'Excavation', 'Surface sample', 'Modern sample', 'Isolated specimen', 'Trap'];

// Terms used in the lab's hand-made Tilia files come first
export const DEPOSITIONAL_ENVIRONMENTS = [
  'Natural Lake', 'Glacial Origin Lake', 'Cirque Lake', 'Landslide Origin Lake', 'Palustrine', 'Marsh', 'Floodplain',
  'Terrestrial', 'Marine', 'Kettle Lake', 'Pond', 'Bog', 'Fen', 'Mire', 'Swamp', 'Cave', 'Rockshelter', 'Fluvial',
  'Alluvial', 'Estuarine', 'Lacustrine', 'Spring', 'Midden', 'Archaeological',
];

// phrase → depositional environment (first match in priority order)
export const DEPENV_PATTERNS = [
  ['Kettle Lake', /kettle (lake|hole|pond)/i],
  ['Glacial Origin Lake', /glacial (lake|origin)/i],
  ['Cave', /\bcave\b/i],
  ['Rockshelter', /rock ?shelter/i],
  ['Bog', /\b(raised |ombrotrophic )?bog\b/i],
  ['Fen', /\bfen\b/i],
  ['Mire', /\bmire\b/i],
  ['Marsh', /\bmarsh\b/i],
  ['Swamp', /\bswamp\b/i],
  ['Pond', /\bpond\b/i],
  ['Natural Lake', /\blake\b/i],
  ['Estuarine', /estuar/i],
  ['Fluvial', /fluvial|floodplain|river terrace/i],
];

export const COLLECTION_DEVICES = [
  ['Livingstone corer', /livingstone/i],
  ['Russian corer', /russian (peat )?(corer|sampler)|russian-type/i],
  ['Hiller corer', /hiller/i],
  ['Glew gravity corer', /\bglew\b/i],
  ['Gravity corer', /gravity corer/i],
  ['Piston corer', /piston corer/i],
  ['Freeze corer', /freeze corer|frozen[- ]finger/i],
  ['Vibracorer', /vibra-?cor/i],
  ['Ekman sampler', /ekman/i],
  ['Kajak corer', /kajak/i],
  ['UWITEC corer', /uwitec/i],
  ['Bolivia corer', /bolivia corer/i],
  ['Macaulay corer', /macaulay/i],
];

export const DEFAULTS_BY_TYPE = {
  'pollen': { element: 'pollen', units: 'NISP' },
  'plant macrofossil': { element: 'seed', units: 'NISP' },
  'diatom': { element: 'valve', units: 'NISP' },
  'ostracode': { element: 'valve', units: 'NISP' },
  'chironomid': { element: 'head capsule', units: 'NISP' },
  'testate amoebae': { element: 'test', units: 'NISP' },
  'vertebrate fauna': { element: 'bone/tooth', units: 'NISP' },
  'charcoal': { element: 'fragment', units: 'NISP' },
  'cladocera': { element: 'headshield', units: 'NISP' },
  'phytolith': { element: 'phytolith', units: 'NISP' },
  'loss-on-ignition': { element: '', units: 'percent' },
  'geochemistry': { element: '', units: '' },
};

// Common pollen taxa → Neotoma ecological group code. Anything not listed is left blank for review.
const TRSH = 'Abies Acer Alnus Betula Carpinus Carya Castanea Celtis Corylus Cupressaceae Fagus Fraxinus Ilex Juglans Juniperus Larix Liquidambar Nyssa Ostrya Picea Pinus Platanus Populus Quercus Salix Taxodium Taxus Thuja Tilia Tsuga Ulmus Ericaceae Myrica Rhamnaceae Rosaceae Sambucus Viburnum Cornus Shepherdia Ephedra Sarcobatus Olea Pistacia Phillyrea Hedera Eucalyptus Nothofagus Podocarpus Dacrydium'.split(' ');
const UPHE = 'Poaceae Gramineae Artemisia Ambrosia Asteraceae Compositae Chenopodiaceae Amaranthaceae Cheno-Am Plantago Rumex Thalictrum Apiaceae Brassicaceae Caryophyllaceae Fabaceae Lamiaceae Polygonum Ranunculaceae Urtica Urticaceae Galium Rubiaceae Onagraceae Epilobium Saxifragaceae Sanguisorba Cerealia Liguliflorae Tubuliflorae Helianthemum Cyperaceae Filipendula Sarracenia'.split(' ');
const VACR = 'Lycopodium Selaginella Huperzia Diphasiastrum Osmunda Pteridium Polypodiaceae Polypodium Monolete Trilete Dryopteris Equisetum Botrychium Isoetes Sphagnum Filicales Pteridophyta'.split(' ');
const AQVP = 'Typha Sparganium Nuphar Nymphaea Potamogeton Myriophyllum Menyanthes Brasenia Sagittaria Alisma Utricularia Hippuris Callitriche'.split(' ');

export function guessPollenGroup(name) {
  const n = String(name || '');
  if (/spike|exotic|marker|tracer|eucalyptus.*added|microsphere/i.test(n)) return 'LABO';
  if (/indeterm|unknown|unidentif|degraded|corroded|crumpled|broken/i.test(n)) return 'UNID';
  const first = n.trim().split(/[\s/-]+/)[0].replace(/[^A-Za-z]/g, '');
  const hit = (list) => list.some((t) => t.toLowerCase() === first.toLowerCase());
  if (hit(AQVP)) return 'AQVP';
  if (hit(VACR)) return 'VACR';
  if (hit(TRSH)) return 'TRSH';
  if (hit(UPHE)) return 'UPHE';
  return '';
}

export const COUNTRIES = 'Afghanistan Albania Algeria Andorra Angola Argentina Armenia Australia Austria Azerbaijan Bahamas Bangladesh Belarus Belgium Belize Benin Bhutan Bolivia Botswana Brazil Bulgaria Burundi Cambodia Cameroon Canada Chad Chile China Colombia Congo Croatia Cuba Cyprus Czechia Denmark Ecuador Egypt Estonia Ethiopia Fiji Finland France Gabon Georgia Germany Ghana Greece Greenland Guatemala Guinea Guyana Haiti Honduras Hungary Iceland India Indonesia Iran Iraq Ireland Israel Italy Jamaica Japan Jordan Kazakhstan Kenya Kyrgyzstan Laos Latvia Lebanon Lesotho Liberia Libya Lithuania Luxembourg Madagascar Malawi Malaysia Mali Malta Mauritania Mexico Moldova Mongolia Montenegro Morocco Mozambique Myanmar Namibia Nepal Netherlands Nicaragua Niger Nigeria Norway Oman Pakistan Panama Paraguay Peru Philippines Poland Portugal Romania Russia Rwanda Senegal Serbia Slovakia Slovenia Somalia Spain Sudan Suriname Sweden Switzerland Syria Taiwan Tajikistan Tanzania Thailand Togo Tunisia Turkey Uganda Ukraine Uruguay Uzbekistan Venezuela Vietnam Yemen Zambia Zimbabwe'.split(' ')
  .concat(['Czech Republic', 'New Zealand', 'Papua New Guinea', 'South Africa', 'South Korea', 'North Korea', 'Sri Lanka', 'United Kingdom', 'Costa Rica', 'El Salvador', 'Dominican Republic', 'Saudi Arabia', 'Bosnia and Herzegovina', 'North Macedonia', 'Scotland', 'England', 'Wales']);

export const COUNTRY_ALIASES = { 'USA': 'United States', 'U.S.A.': 'United States', 'United States of America': 'United States', 'UK': 'United Kingdom', 'Scotland': 'United Kingdom', 'England': 'United Kingdom', 'Wales': 'United Kingdom', 'Czech Republic': 'Czechia' };

export const US_STATES = 'Alabama Alaska Arizona Arkansas California Colorado Connecticut Delaware Florida Georgia Hawaii Idaho Illinois Indiana Iowa Kansas Kentucky Louisiana Maine Maryland Massachusetts Michigan Minnesota Mississippi Missouri Montana Nebraska Nevada Ohio Oklahoma Oregon Pennsylvania Tennessee Texas Utah Vermont Virginia Washington Wisconsin Wyoming'.split(' ')
  .concat(['New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Rhode Island', 'South Carolina', 'South Dakota', 'West Virginia']);

export const CA_PROVINCES = ['Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Newfoundland and Labrador', 'Nova Scotia', 'Ontario', 'Prince Edward Island', 'Quebec', 'Québec', 'Saskatchewan', 'Yukon', 'Northwest Territories', 'Nunavut'];

// Radiocarbon / dating lab prefixes (used to spot lab numbers in text)
export const LAB_PREFIXES = ['Beta', 'AA', 'UCIAMS', 'OS', 'CAMS', 'Poz', 'KIA', 'SUERC', 'GrA', 'GrN', 'Wk', 'NZA', 'LuS', 'Ua', 'ETH', 'OxA', 'ANU', 'ANSTO', 'OZ', 'I', 'WIS', 'Hv', 'Lu', 'UGAMS', 'D-AMS', 'BA', 'TO', 'GX', 'SNU', 'IAAA', 'LLNL', 'NOSAMS', 'CURL', 'MAMS', 'DirectAMS', 'Erl', 'COL', 'Tua', 'UBA', 'PSUAMS', 'ISGS', 'WAT', 'Gd', 'GdA', 'LTL', 'Ki', 'St', 'Q', 'SRR', 'Deb', 'RCD', 'CIAMS', 'UCI'];
