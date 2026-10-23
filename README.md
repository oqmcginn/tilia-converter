# Tilia Converter

A static website that turns **spreadsheets** and **publications** into a **Tilia (`.tlx`) file** for the [Neotoma Paleoecology Database](https://www.neotomadb.org/).

Drop in your count/measurement spreadsheet, the paper that describes the site, and optionally a metadata sheet, RIS/BibTeX file, or DOI. The converter pulls out everything it can find, shows you where each value came from, lets you correct it, and writes a Tilia file you can open in [Tilia](https://www.neotomadb.org/apps/tilia).

Everything runs in the browser. Files are not uploaded anywhere. The exceptions are all opt-in: CrossRef (sends the DOI or title), ORCID (sends author names and DOIs), OpenStreetMap reverse geocoding (sends the site coordinates), and Claude extraction (sends the paper to the Anthropic API with your own key).

## What it extracts

| From | What |
|---|---|
| **Data spreadsheets** (xlsx, xls, ods, csv, tsv) | Samples (depth, top/bottom → midpoint + thickness, age, sample/analysis-unit name, analyst) and variables (taxa or measurements, with units parsed from headers like `Pinus (%)`). Both layouts are detected: samples as rows (typical Excel) or samples as columns (Tilia layout, including `Code/Name/Element/Units/Group` columns and `#` rows). Unit conversions: depth m/mm → cm, age ka → yr. Totals/sums/concentrations are excluded by default. |
| **Metadata sheets** (key/value rows) | Site name, coordinates (decimal or DMS), elevation, country/state/county, core name, device, collection date, water depth, dataset type, investigators, analysts, collectors, DOI. |
| **Date sheets** | Lab number, depth (incl. ranges like `100-102`), ¹⁴C age, error, material, method. |
| **Publications** (PDF, txt) | DOI, coordinates (DMS, decimal-minutes, decimal with hemispheres, labelled), altitude, water depth, site name, country/state/county, dataset type, coring device, depositional environment, collection date, radiocarbon dates (lab number + age ± error + depth + material), author emails. Each value records its page. |
| **CrossRef / RIS / BibTeX** | Title, authors, journal, year, volume, issue, pages, DOI → publication + contacts. |
| **Claude** (optional) | Reads the full paper, including tables, scanned pages and image-only tables. Returns every Tilia field it can support with a page number and supporting quote, every radiometric date (tagged with its analysis unit), and the vertebrate faunal list as taxon × element × unit records, following the lab's conventions (NISP or presence/absence, “Assemblage” for single assemblages, totals for time-bin tables, only the chosen site's column). The faunal table becomes the dataset unless you pick another. |

## ORCID iDs for contacts

Every contact (authors from publications plus people named in metadata sheets) is matched to ORCID using the public ORCID API. Each match gets a confidence score and a list of the evidence behind it:

| Evidence | Score |
|---|---|
| ORCID supplied by the publisher in CrossRef (authenticated by the author) | 99% |
| ORCID supplied by the publisher in CrossRef | 92% |
| The person's ORCID record lists this paper's DOI, and the name matches | 93–97% |
| iD printed in the paper (checksum-valid), and the record's name matches | 93% |
| Name search only: given-name agreement, affiliation overlap, same journal, share of works on related topics | up to 85% |

Scores are labelled **Confirmed** (≥90%), **Likely** (≥70%), **Possible** (≥40%) or **Weak**. The best match is selected automatically only when it is at least Likely and clearly ahead of the next candidate. Otherwise up to six candidates are listed with their affiliations and evidence, and you choose one, choose none, or type an iD.

For common names, add an affiliation hint and search again; this runs an affiliation-restricted search. The chosen iD is written to the contact's `URL` field, since Tilia 3 has no dedicated ORCID element. **Contacts CSV** exports each contact's iD, confidence, evidence and runner-up candidates.

Pollen taxa get a provisional Neotoma ecological group (TRSH, UPHE, VACR, AQVP, LABO, UNID) and default element/units for the dataset type. Everything stays editable.

## Output format

The `.tlx` matches files saved by **Tilia 3.0.3**. The element names, order and attributes were taken from 20 hand-converted lab examples, and a check confirms that every element path the converter writes also appears in those files.

```
TiliaFile
├─ Version            Tilia 3.0.3
├─ Contacts           Contact ID=n (name fields, email, URL ← chosen ORCID iD)
├─ Publications       Publication ID Primary: PublicationType, PublicationYear, Citation,
│                     Authors/Author (Contact, LastName, Initials), Title, Journal, Volume, Issue, Pages, DOI
├─ SpreadSheetBook    SpreadSheetOptions (+ GroupCategories)
│  └─ SpreadSheet     Col 1–7: Code, Name, Element, Units, Context, Taphonomy, Group
│                     Col 8…: one per sample. Row 1 depth, row 2 analysis unit,
│                     #Chron1 (sample ages), #Samp.Analyst, then one row per taxon
├─ Site               SiteName, Long/Lat, Altitude, Country, State, County, SiteDescription
├─ CollectionUnit     Handle, CollectionType, CollectionDevice, Collectors, CollectionDate (day serial), …
├─ Datasets/Dataset   DatasetType, IsSSamp, Investigators, Processors, Publications
├─ GeochronDataset    Geochronology/GeochronSample: Method, AgeUnits, Depth, Thickness, LabNumber,
│                     Age, ErrorOlder/Younger, Sigma, StdDev, MaterialDated, Publications
└─ AgeModels          AgeModel: ChronologyName, Model (e.g. Bacon), bounds, Preparers,
                      ChronControls linked to the geochronology samples
```

Citations use Neotoma's style ("Galka, M., K.-H. Knorr, and A. Feurdean. 2025. Title. Journal 0(0):1-22. [DOI: …]").

**Taxon lookup.** `js/data/taxa.js` holds 740 taxa (name → Neotoma code, element, units, ecological group) collected from the example files. Spreadsheet columns that match a name get the real code; the rest get a provisional code and a best-guess group.

**Multi-site papers.** When you pick or type the site you're converting, coordinates, altitude, water depth and depositional environment are re-read from the text around that site's name. That includes site tables like `Frog Lake 48.48, 123.59 …`.

Always review the file in Tilia (lookups, taxon names, chronology) before you submit to Neotoma.

## Accuracy on real examples

Two local test suites compare the converter with hand-made Tilia files (example folders stay on your machine; manifests in `tests/_eval/` are git-ignored):

- `tests/eval.html` scores metadata extracted from papers (`?site=1` = site chosen by the user, `?set=new` = the October examples).
- `tests/data-eval.html` builds the data table from each case's spreadsheets and papers and compares it cell by cell.

**Metadata** (site chosen by the user):

| Field | Original 22 papers | October examples (45 pairs) |
|---|---|---|
| Radiocarbon dates found | 134 / 152 | 109 / 144 |
| …with exact age and error | 119 / 134 | 94 / 109 |
| Dataset type | 20 / 22 | 36 / 45 |
| Collection type | 19 / 22 | 33 / 45 |
| Depositional environment | 13 / 22 | 18 / 45 |
| DOI / journal / year | 7 / 7, 11 / 16, 14 / 18 | 11 / 12, 39 / 43, 39 / 45 |
| Authors found | 57% | 90% |
| Coordinates | 12 / 22 | 13 / 45 (many faunal sites are deliberately not located in the paper) |

**Data tables:** 16 cases reproduce the expert's file exactly, or within the expert's rounding: Billy Slope Meadow, Dewey Lake, all 9 Galka charcoal sites, Kimble Pond, Sharkey Lake, O'Brien isotopes, Round Lake CaCO₃ and (from the paper alone) most of Bender's Cave, Ziegler Reservoir and Signature Cave.

What still needs a person or Claude extraction:

- scanned PDFs;
- faunal lists in prose or image-only tables;
- choosing between several proxy tables in one workbook (Round Lake);
- expert judgement calls (re-identified taxa, genus-level entries).

**What the converter learned from the examples:**

- a dictionary of non-taxon variables: charcoal size classes and units; δ¹⁸O, δ¹³C and δ²H; elements with units; C:N; CaCO₃; sample quantity. "CHAR" (accumulation rate) is treated as derived, while "Total Charcoal" is kept as the count.
- splitting sheets that stack several sites, put sites side by side, or hold several sub-tables.
- converting CE ages to years BP, and preferring composite depth.
- rebuilding faunal tables from PDF word positions: site columns, Total columns used for time bins, and Latin names inside common names.
- linking dates to named analysis units (`AnalysisUnitID="Name"`).
- lab vocabulary: Terrestrial and Archaeological environments for faunal sites, Kettle Lake, Excavation and Section.
- a taxon lookup of 1,060 Neotoma taxa from 121 expert files.

## Run locally

It's plain HTML and ES modules with no build step:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Unit tests are at http://localhost:8000/tests/.

## Deploy to GitHub Pages

Live at **https://oqmcginn.github.io/tilia-converter/**. Pages deploys straight from the `main` branch root (Settings → Pages → Deploy from a branch), so every push to `main` updates the site within a minute or two. There's no build step.

## Project layout

```
index.html              page shell
css/style.css           styles (light + dark)
js/app.js               UI, ingestion, review, export
js/record.js            candidate/merge model (provenance + confidence)
js/tilia.js             .tlx writer + validation
js/io.js                file readers (SheetJS, pdf.js, loaded on demand)
js/ai.js                optional Claude extraction (structured JSON output)
js/orcid.js             ORCID matching, scoring and evidence
js/pipeline.js          publication ingestion, site re-anchoring, reverse geocoding
js/data/taxa.js         Neotoma taxon lookup built from hand-converted files
js/data/variables.js    non-taxon variables (charcoal, isotopes, elements) → Neotoma names
js/extract/tables.js    faunal tables rebuilt from PDF word positions
js/extract/spreadsheet.js  sheet classification, layout detection, sample/variable parsing
js/extract/text.js      publication text heuristics
js/extract/bib.js       CrossRef, RIS, BibTeX, names, citations
js/lookups.js           vocabularies, pollen groups, device/environment patterns
samples/                fictional example inputs
tests/index.html        browser unit tests
tests/eval.html         metadata accuracy against hand-made Tilia files
tests/data-eval.html    data-table accuracy, cell by cell
```

## Libraries

Loaded from CDNs at runtime: [SheetJS](https://sheetjs.com/) 0.20.3, [pdf.js](https://mozilla.github.io/pdf.js/) 4.10.38, [Leaflet](https://leafletjs.com/) 1.9.4 (map), [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) 0.128.0 (only when Claude extraction is used).

## License

MIT
