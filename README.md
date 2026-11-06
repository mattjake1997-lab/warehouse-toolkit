# Warehouse Toolkit

Browser tools for a receiving dock, all in one page:

| Tab | What it does |
|---|---|
| Pallet Audit | Monthly reconciliation of off-site pallet counts against each warehouse's report |
| Truck Load Builder | Plans return truck loads from the off-site inventory and needs list, and makes the Bill of Lading |
| MFN Renamer | Splits scanned receiving paperwork into one PDF per shipment, named by PO number |
| Dock to Stock | Daily 24-hour put-away %, daily log, exceptions, watch list, weekly report |
| Dock Priority | The day's put-away list, oldest first, with due times by shift |
| BOL Tracker | Counts shipments to and from the off-site warehouses from bills of lading |
| How it works | Step-by-step instructions for every tool |

## What's in this repository, and what isn't

- **Only code.** There's no company data here: no names, addresses, part weights or records.
- **Company details** (warehouses and addresses, carriers, the people who sign BOLs, exception reasons,
  part weights, dock locators) are in a **settings file** that each person imports once on the toolkit page.
  That file is kept off GitHub (`.gitignore` blocks `*settings*.json` and `*backup*.json`).
- **Files you load** (Oracle exports, scans, BOLs, reports) are read inside your browser and never uploaded.
- **Saved work** (daily log, exceptions, reasons, corrections) is kept on your own computer, either in the browser
  or in a folder you choose. See below.

Nothing in the toolkit sends data to a server.

## Using it

Open the GitHub Pages link in **Edge or Chrome**.

**First time on a computer**

1. Click **Saving to** in the top right.
2. **Import settings file** and pick `warehouse-toolkit-settings.json`. The page reloads with your warehouses,
   names and weights filled in.
3. **Save to a folder…** and pick a folder, for example `Documents\Toolkit Data`. When the browser asks to let the site
   view and edit files there, allow it. If it offers **Allow on every visit**, choose that.

**After that**

- Some browsers ask for one click to reopen the folder on each visit. A yellow bar with **Reconnect folder** shows when they do.
- **Moving to another computer:** Saving to → **Download backup**, then **Restore from backup** on the other computer.
- **Later, shared data:** point everyone's **Save to a folder…** at the same folder on the shared drive. Everyone then
  sees the same daily log, exceptions and reasons, and changes show up within about 30 seconds.

## How saving works

`runtime.js` is the toolkit's storage and download layer:

- **This browser (default):** records are kept in IndexedDB for this site, in this browser.
- **A folder:** each record is a JSON file, `<folder>/<collection>/<id>.json`, written with the browser's
  File System Access API. The folder is checked every 30 seconds for changes made by other people.
- **Downloads** are ordinary browser downloads.

Collections: `days`, `log`, `exceptions`, `loose`, `watch`, `reasons`, `tx`, `cost`, `desc`, `dock`, `learn`, `settings`.

## Libraries

All loaded from public CDNs at pinned versions, except React and docx, which are built into `recon-app.js` and `truck-app.js`.

| Library | Version | From |
|---|---|---|
| PDF.js | 3.11.174 | cdnjs.cloudflare.com |
| pdf-lib | 1.17.1 | cdnjs.cloudflare.com |
| Tesseract.js (+ core) | 5.1.1 | unpkg.com |
| Tesseract English model | standard `eng.traineddata` | `eng-ocr.wasm` in this repository |
| SheetJS (xlsx) | 0.18.5 | cdnjs.cloudflare.com |
| JSZip | 3.10.1 | cdnjs.cloudflare.com |
| jsPDF | 2.5.1 | cdnjs.cloudflare.com |
| html2canvas | 1.4.1 | cdnjs.cloudflare.com |
| React / React DOM | 19.2.8 | bundled |
| docx | 9.7.1 | bundled |
| Fonts: Inter, IBM Plex Mono, Mrs Saint Delafield | — | fonts.googleapis.com |

## Rebuilding the two bundled files

Only needed after changing anything in `src/`:

```
npm install
npm run build
```

## Putting it on GitHub Pages

Settings → Pages → Source: **Deploy from a branch** → branch `main`, folder `/ (root)` → Save.
The link appears after a minute.
