import React, { useState, useMemo } from "react";
import * as XLSX from "xlsx";
import * as pdfjsLib from "pdfjs-dist";
import { generateBOL, generateBolNumber, carrierForWarehouse } from "./bolGenerator";
import { estimateWeight, UNRELIABLE_WEIGHT_ITEMS, isKnownWeight } from "./weightLookup";
import { SignaturePreview, SignaturePad } from "./signature.jsx";
import TK, { offsiteCodes } from "./settings.js";

// Point pdf.js at its worker. If your app already configures this elsewhere
// (e.g. for the Bills of Lading tab), remove this line to avoid setting it twice.
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`;

const TARGET_SKIDS = 26;

// The people who sign BOLs, from the settings file. The first is the default; more can be added on the page.
const DEFAULT_SIGNATURE_NAMES = TK.signatureNames || [];

// Parts that can be double-stacked on a single trailer spot — one spot holds
// two skids of these, so they only count as half a spot each toward the
// 26-spot target. Everything else counts as a full spot per skid.
const DOUBLE_STACKABLE_ITEMS = new Set((TK.doubleStack || []).map(String));   // from the settings file

// Double-stack can also be switched on or off per part on the page; that choice is remembered on this computer.
const DS_KEY = "truckLoadBuilder.doubleStack";
const DOUBLE_STACK_OVERRIDES = (() => { try { return JSON.parse(localStorage.getItem(DS_KEY) || "{}"); } catch { return {}; } })();
function setDoubleStack(itemNumber, on) {
  DOUBLE_STACK_OVERRIDES[String(itemNumber)] = !!on;
  try { localStorage.setItem(DS_KEY, JSON.stringify(DOUBLE_STACK_OVERRIDES)); } catch { /* not kept after reload */ }
}

function isDoubleStackable(itemNumber) {
  const o = DOUBLE_STACK_OVERRIDES[String(itemNumber)];
  if (o !== undefined) return o;
  return DOUBLE_STACKABLE_ITEMS.has(String(itemNumber));
}

function spotsForSkids(itemNumber, skids) {
  return isDoubleStackable(itemNumber) ? skids / 2 : skids;
}

// Off-site subinventory -> warehouse code, from the settings file; otherwise the last part of the subinventory.
const WAREHOUSE_LABELS = offsiteCodes;

function warehouseLabel(sub) {
  return WAREHOUSE_LABELS[sub] || (sub ? String(sub).split(".").pop() : "") || "Unknown";
}

// ---------------------------------------------------------------------------
// Excel parsing — offsite availability export (one row per skid/LPN)
// Columns used: Sub, Item, Item Description, LPN. Everything else is ignored.
// ---------------------------------------------------------------------------
function parseAvailabilityWorkbook(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  // itemNumber -> { description, byWarehouse: { WSI: [lpn, lpn...], ... } }
  const byItem = new Map();

  for (const row of rows) {
    const item = row["Item"];
    if (item === null || item === undefined || item === "") continue;
    const itemKey = String(item).trim();
    const sub = row["Sub"];
    const wh = warehouseLabel(sub);
    const description = row["Item Description"] || "";
    const lpn = row["LPN"];

    if (!byItem.has(itemKey)) {
      byItem.set(itemKey, { description, byWarehouse: {} });
    }
    const entry = byItem.get(itemKey);
    if (!entry.byWarehouse[wh]) entry.byWarehouse[wh] = [];
    entry.byWarehouse[wh].push(lpn ?? entry.byWarehouse[wh].length + 1);
  }

  return byItem;
}

// ---------------------------------------------------------------------------
// PDF parsing — "Items Needing Replenishment" export
// Only two things are read from each row: the ITEM number and the EVV Move
// pallet count. Everything else on the row (description, on-site / off-site
// counts, status...) is ignored — item descriptions come from the inventory
// file instead.
// ---------------------------------------------------------------------------

// Pulls the text out of a PDF as plain lines (tokens grouped by vertical
// position, read left to right).
async function extractPdfLines(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

  const lines = [];
  let textItems = 0;
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    textItems += content.items.filter((it) => it.str && it.str.trim()).length;

    const rows = new Map(); // roundedY -> [{x, str}]
    for (const item of content.items) {
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];
      // group text within 3px of an existing row's y value
      let bucketY = y;
      for (const existingY of rows.keys()) {
        if (Math.abs(existingY - y) <= 3) {
          bucketY = existingY;
          break;
        }
      }
      if (!rows.has(bucketY)) rows.set(bucketY, []);
      rows.get(bucketY).push({ x, str: item.str });
    }

    const sortedYs = Array.from(rows.keys()).sort((a, b) => b - a);
    for (const y of sortedYs) {
      const tokens = rows.get(y).sort((a, b) => a.x - b.x);
      const text = tokens.map((t) => t.str).join(" ").replace(/\s+/g, " ").trim();
      if (text) lines.push(text);
    }
  }

  if (textItems === 0) {
    throw new Error(
      "This PDF has no readable text — it's a picture of the table (like a screenshot), so the numbers can't be read reliably. Save or export the report to PDF straight from the source instead."
    );
  }
  return lines;
}

// A data row starts with a 5-6 digit item number. The EVV Move numbers sit at
// the far right of the row, so they're read from the end of the line — that
// keeps stray digits in the description or date columns from interfering.
//
// The export's right-hand columns are  EVV Move Qty | EVV Move Pallets, and
// sometimes a trailing Pallet Qty (units per pallet) after them. When that
// trailing column is there, Move Qty ÷ Pallet Qty = Move Pallets, which is
// how the layout is detected (and how a misread row gets caught).
function parseNeedsLines(lines) {
  const rows = [];
  for (const line of lines) {
    const m = line.match(/^(\d{5,6})\s+(.*)$/);
    if (!m) continue;
    const nums = [...m[2].matchAll(/\d[\d,]*/g)].map((n) => Number(n[0].replace(/,/g, "")));
    if (nums.length >= 2) rows.push({ item: m[1], nums });
  }

  const addsUp = (nums) => {
    if (nums.length < 3) return false;
    const [qty, pallets, perPallet] = nums.slice(-3);
    return perPallet > 0 && Math.abs(qty / perPallet - pallets) <= 1;
  };
  const hasPalletQtyColumn = rows.filter((r) => addsUp(r.nums)).length >= rows.length / 2;

  const needs = [];
  const flagged = []; // rows whose numbers didn't line up — worth a second look
  for (const r of rows) {
    const movePallets = hasPalletQtyColumn ? r.nums[r.nums.length - 2] : r.nums[r.nums.length - 1];
    if (!Number.isFinite(movePallets) || movePallets <= 0) continue;

    const implausible = movePallets > 100; // a trailer holds ~26 spots, so this is a misread
    if (implausible || (hasPalletQtyColumn && !addsUp(r.nums))) flagged.push(r.item);
    if (implausible) continue;

    needs.push({ item: r.item, description: "", movePallets });
  }

  // Keep the export's own ordering (highest EVV Move first = build priority).
  needs.sort((a, b) => b.movePallets - a.movePallets);
  return { needs, flagged };
}

async function parseNeedsPdf(file) {
  return parseNeedsLines(await extractPdfLines(file));
}

// The same needs list saved as Excel (or CSV). Columns are found by their headers:
// ITEM, DESCRIPTION, EVV Move Pallets, and when Move Pallets isn't there, EVV Move Qty ÷ Pallet Qty.
// A sheet without recognizable headers is read row by row like the PDF's lines.
function parseNeedsRows(rows) {
  const norm = (v) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  let h = -1, col = {};
  for (let r = 0; r < Math.min(rows.length, 25) && h < 0; r++) {
    const cells = rows[r].map(norm);
    const find = (re) => cells.findIndex((c) => re.test(c));
    const item = find(/^item\b|^item ?(#|no|number)/);
    const movePallets = find(/move.*pallet/);
    const moveQty = find(/move.*(qty|quantity)/);
    const perPallet = cells.findIndex((c, i) => i !== movePallets && /pallet ?(qty|quantity)|per pallet/.test(c));
    if (item >= 0 && (movePallets >= 0 || (moveQty >= 0 && perPallet >= 0))) {
      h = r; col = { item, movePallets, moveQty, perPallet, desc: find(/desc/) };
    }
  }
  if (h < 0) {
    // No headers found: treat each row as a line of text, the same way the PDF is read.
    return parseNeedsLines(rows.map((r) => r.map((v) => String(v ?? "").trim()).filter(Boolean).join(" ")));
  }
  const num = (v) => Number(String(v ?? "").replace(/[^\d.]/g, ""));
  const needs = [], flagged = [];
  for (const row of rows.slice(h + 1)) {
    const item = String(row[col.item] ?? "").trim().match(/^\d{5,6}/);
    if (!item) continue;
    let movePallets = col.movePallets >= 0 ? num(row[col.movePallets]) : NaN;
    if (!(movePallets > 0) && col.moveQty >= 0 && col.perPallet >= 0) {
      const q = num(row[col.moveQty]), per = num(row[col.perPallet]);
      if (q > 0 && per > 0) movePallets = Math.ceil(q / per);
    }
    if (!Number.isFinite(movePallets) || movePallets <= 0) continue;
    movePallets = Math.round(movePallets);
    if (movePallets > 100) { flagged.push(item[0]); continue; }   // more than a few trucks' worth: likely the wrong column
    needs.push({ item: item[0], description: col.desc >= 0 ? String(row[col.desc] ?? "").trim() : "", movePallets });
  }
  needs.sort((a, b) => b.movePallets - a.movePallets);
  return { needs, flagged };
}

async function parseNeedsWorkbookFile(file) {
  const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
  let best = { needs: [], flagged: [] };
  for (const name of wb.SheetNames) {
    const res = parseNeedsRows(XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: false }));
    if (res.needs.length > best.needs.length) best = res;
  }
  return best;
}

// Warehouses are tried in this order when picking which single warehouse to
// build the load from — EAB and WS2 before WSI. Between EAB and WS2 there
// was no stated preference, so EAB is tried first here; swap the order below
// if WS2 should go first.
// Which warehouse to pull from first: the order in the settings file (truckOrder), or the order the sites are listed.
const WAREHOUSE_ORDER = TK.truckOrder || Object.values(TK.offsite || {});

// ---------------------------------------------------------------------------
// Truck building — loads never mix warehouses, and a skid can only be on one
// truck. A skid is "spoken for" once it's on a BOL generated today, or on
// another warehouse's truck that's still being built. Those skids come out of
// the needs list and out of that warehouse's available count, so the same
// item never lands on two trucks unless the need is bigger than what the first
// warehouse had.
// ---------------------------------------------------------------------------
const EMPTY_LINES = [];

function todayStr() {
  return new Date().toLocaleDateString("en-US");
}

const fmtNum = (n) => Number(n).toLocaleString("en-US");

// Skids already on today's BOLs — overall, and per warehouse.
function summarizeBooked(loads) {
  const byItem = {};
  const byItemWh = {};
  for (const load of loads) {
    for (const it of load.items || []) {
      const n = Number(it.skids) || 0;
      byItem[it.item] = (byItem[it.item] || 0) + n;
      const key = `${it.item}|${load.warehouse}`;
      byItemWh[key] = (byItemWh[key] || 0) + n;
    }
  }
  return { byItem, byItemWh };
}

// Skids a warehouse still has: its count in the inventory file, minus what's
// already gone out on today's BOLs from that warehouse.
function stockAt(availability, booked, item, warehouse) {
  const count = availability?.get(item)?.byWarehouse?.[warehouse]?.length || 0;
  return Math.max(0, count - (booked.byItemWh[`${item}|${warehouse}`] || 0));
}

// Skids of an item sitting on the OTHER warehouses' in-progress trucks.
function skidsOnOtherTrucks(trucks, item, warehouse) {
  let total = 0;
  for (const [wh, lines] of Object.entries(trucks)) {
    if (wh === warehouse) continue;
    for (const l of lines) if (l.item === item) total += l.skids;
  }
  return total;
}

// What's still needed of an item for the truck being built at `warehouse`
// (before counting what's already on that truck): the EVV Move number, minus
// skids on today's BOLs, minus skids on the other warehouses' trucks.
function remainingNeed(need, booked, trucks, warehouse) {
  return Math.max(
    0,
    need.movePallets - (booked.byItem[need.item] || 0) - skidsOnOtherTrucks(trucks, need.item, warehouse)
  );
}

// Adds skids of an item to a truck, merging into its existing line if it has one.
function addSkidsToLines(lines, { item, description, warehouse, qty, doubleStack, manual }) {
  if (lines.some((l) => l.item === item)) {
    return lines.map((l) => {
      if (l.item !== item) return l;
      const skids = l.skids + qty;
      const updated = { ...l, skids };
      if (l.weightIsEstimate || !l.weight) {
        const est = estimateWeight(item, skids);
        updated.weight = est ?? "";
        updated.weightIsEstimate = est != null;
      }
      return updated;
    });
  }
  const est = estimateWeight(item, qty);
  return [
    ...lines,
    {
      id: `${item}-${warehouse}`,
      item,
      description,
      warehouse,
      skids: qty,
      doubleStack,
      manual: !!manual,
      weight: est ?? "",
      weightIsEstimate: est != null,
    },
  ];
}

// Optional auto-fill: walks the needs list in order (highest EVV Move first)
// and adds what's still needed, limited by what this warehouse has left and
// the trailer's remaining spots. Anything already on the truck is kept.
function fillTruck({ needs, availability, booked, trucks, warehouse, lines, target = TARGET_SKIDS }) {
  let result = lines;
  let spots = result.reduce((s, l) => s + spotsForSkids(l.item, l.skids), 0);

  for (const need of needs) {
    if (spots >= target) break;
    const onTruck = result.find((l) => l.item === need.item)?.skids || 0;
    const want = remainingNeed(need, booked, trucks, warehouse) - onTruck;
    if (want <= 0) continue;
    const room = stockAt(availability, booked, need.item, warehouse) - onTruck;
    if (room <= 0) continue;

    const doubleStack = isDoubleStackable(need.item);
    const spotsLeft = target - spots;
    const bySpots = doubleStack ? Math.floor(spotsLeft * 2) : Math.floor(spotsLeft);
    const qty = Math.min(want, room, bySpots);
    if (qty <= 0) continue;

    result = addSkidsToLines(result, {
      item: need.item,
      description: availability.get(need.item)?.description || need.description || "",
      warehouse,
      qty,
      doubleStack,
    });
    spots += spotsForSkids(need.item, qty);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function TruckLoadBuilder() {
  const [availability, setAvailability] = useState(null); // Map
  const [needs, setNeeds] = useState(null); // array
  const [needsFlagged, setNeedsFlagged] = useState([]); // item numbers whose pallet count looked off
  const [selectedWarehouse, setSelectedWarehouse] = useState(null);
  const [trucks, setTrucks] = useState({}); // warehouse -> line items being built
  const [forms, setForms] = useState({}); // warehouse -> typed-over carrier / SCAC / BOL number
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loadingAvail, setLoadingAvail] = useState(false);
  const [loadingNeeds, setLoadingNeeds] = useState(false);
  const [generatingBol, setGeneratingBol] = useState(false);

  const [signatureNames, setSignatureNames] = useState(() => {
    try {
      const saved = localStorage.getItem("truckLoadBuilder.signatureNames");
      return saved ? JSON.parse(saved) : DEFAULT_SIGNATURE_NAMES;
    } catch {
      return DEFAULT_SIGNATURE_NAMES;
    }
  });
  const [selectedSignature, setSelectedSignature] = useState(DEFAULT_SIGNATURE_NAMES[0] || "");
  const [newSignatureName, setNewSignatureName] = useState("");
  const [padFor, setPadFor] = useState(null);
  const [sigVersion, setSigVersion] = useState(0);

  const [loadHistory, setLoadHistory] = useState(() => {
    try {
      const saved = localStorage.getItem("truckLoadBuilder.loadHistory");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const saveHistory = (updated) => {
    try {
      localStorage.setItem("truckLoadBuilder.loadHistory", JSON.stringify(updated));
    } catch {
      // localStorage unavailable — history just won't persist across reloads
    }
  };

  const logFinalizedLoad = (record) => {
    setLoadHistory((prev) => {
      const updated = [record, ...prev].slice(0, 200); // keep the log from growing forever
      saveHistory(updated);
      return updated;
    });
  };

  // Putting a BOL back: its skids return to the needs list and to that
  // warehouse's available count.
  const releaseLoad = async (record) => {
    const ok = await window.toolkitConfirm(
      `Release BOL ${record.bolNumber} (${record.warehouse}, ${record.totalSkids} skids)? Its skids go back into the needs list and ${record.warehouse}'s available count.`
    );
    if (!ok) return;
    setLoadHistory((prev) => {
      const updated = prev.filter((h) => h !== record);
      saveHistory(updated);
      return updated;
    });
  };

  // Same BOL number generated more than once today is almost always a
  // mistake (duplicate booking, or the load changed but the number wasn't
  // regenerated) — not a hard block, since a legitimate re-print is
  // possible, just a confirmation before it happens silently.
  const findTodaysDuplicate = (candidateBolNumber) =>
    loadHistory.find((h) => h.bolNumber === candidateBolNumber && h.date === todayStr());

  const addSignatureName = () => {
    const name = newSignatureName.trim();
    if (!name || signatureNames.includes(name)) return;
    const updated = [...signatureNames, name];
    setSignatureNames(updated);
    setSelectedSignature(name);
    setNewSignatureName("");
    try {
      localStorage.setItem("truckLoadBuilder.signatureNames", JSON.stringify(updated));
    } catch {
      // localStorage unavailable — the list just won't persist across reloads
    }
  };

  // ---- derived state -------------------------------------------------------
  const warehousesPresent = useMemo(
    () =>
      !availability
        ? []
        : (() => {
            const found = new Set();
            for (const entry of availability.values()) for (const [wh, l] of Object.entries(entry.byWarehouse)) if (l.length) found.add(wh);
            const ordered = WAREHOUSE_ORDER.filter((wh) => found.has(wh));
            return [...ordered, ...[...found].filter((wh) => !ordered.includes(wh) && wh !== "Unknown").sort()];
          })(),
    [availability]
  );
  const active =
    selectedWarehouse && warehousesPresent.includes(selectedWarehouse)
      ? selectedWarehouse
      : warehousesPresent[0] || null;
  const lineItems = (active && trucks[active]) || EMPTY_LINES;

  const todaysLoads = useMemo(() => loadHistory.filter((h) => h.date === todayStr()), [loadHistory]);
  const booked = useMemo(() => summarizeBooked(todaysLoads), [todaysLoads]);

  const skidsUsed = lineItems.reduce((sum, li) => sum + li.skids, 0);
  const spotsUsed = lineItems.reduce((sum, li) => sum + spotsForSkids(li.item, li.skids), 0);
  const spotsLeft = Math.max(0, TARGET_SKIDS - spotsUsed);
  // Running total: adds every line that has a weight, and counts the ones that don't.
  const weighedLines = lineItems.filter((li) => Number(li.weight) > 0);
  const totalWeight = weighedLines.length ? weighedLines.reduce((sum, li) => sum + Number(li.weight), 0) : null;
  const unweighed = lineItems.length - weighedLines.length;

  // One row per item on the needs list, with what's still unassigned for the
  // truck currently being built.
  const pool = useMemo(() => {
    if (!needs || !availability || !active) return [];
    return needs.map((n) => {
      const here = lineItems.find((l) => l.item === n.item)?.skids || 0;
      const bookedAll = booked.byItem[n.item] || 0;
      const elsewhere = skidsOnOtherTrucks(trucks, n.item, active);
      const remaining = remainingNeed(n, booked, trucks, active);
      const stock = {};
      for (const wh of warehousesPresent) stock[wh] = stockAt(availability, booked, n.item, wh);
      return {
        ...n,
        description: availability.get(n.item)?.description || n.description || "",
        inInventory: availability.has(n.item),
        here,
        bookedAll,
        elsewhere,
        remaining,
        unassigned: Math.max(0, remaining - here),
        stock,
      };
    });
  }, [needs, availability, active, lineItems, booked, trucks, warehousesPresent]);

  const needByItem = useMemo(() => new Map(pool.map((r) => [r.item, r])), [pool]);
  const stillNeeded = pool.filter((r) => r.unassigned > 0);
  const coveredElsewhere = pool.filter(
    (r) => r.unassigned === 0 && r.here === 0 && r.bookedAll + r.elsewhere > 0
  );

  // BOL form: carrier / SCAC / BOL number follow the truck unless typed over.
  const form = (active && forms[active]) || {};
  const carrierName = form.carrierName ?? carrierForWarehouse(active);
  const scac = form.scac ?? "";
  const bolNumber = form.bolNumber ?? generateBolNumber(lineItems);
  const setFormField = (field, value) =>
    setForms((prev) => ({ ...prev, [active]: { ...(prev[active] || {}), [field]: value } }));

  // ---- truck actions ---------------------------------------------------------
  const setLines = (updater) => {
    if (!active) return;
    setTrucks((prev) => ({ ...prev, [active]: updater(prev[active] || EMPTY_LINES) }));
  };

  const selectWarehouse = (wh) => {
    setNotice(null);
    setSelectedWarehouse(wh);
  };

  const addToTruck = (row, qty) => {
    if (qty <= 0) return;
    setNotice(null);
    setLines((prev) =>
      addSkidsToLines(prev, {
        item: row.item,
        description: row.description,
        warehouse: active,
        qty,
        doubleStack: isDoubleStackable(row.item),
      })
    );
  };

  // A part that isn't on the needs list, added by hand.
  const addOtherPart = ({ item, description, qty }) => {
    const it = String(item).trim();
    if (!it || !(qty > 0)) return;
    setNotice(null);
    setLines((prev) =>
      addSkidsToLines(prev, {
        item: it,
        description: description || availability?.get(it)?.description || "",
        warehouse: active,
        qty,
        doubleStack: isDoubleStackable(it),
        manual: true,
      })
    );
  };

  const autoFill = () => {
    if (!needs || !availability) return;
    setNotice(null);
    setLines((prev) => fillTruck({ needs, availability, booked, trucks, warehouse: active, lines: prev }));
  };

  const clearTruck = () => {
    setNotice(null);
    setLines(() => EMPTY_LINES);
  };

  // Switch double-stacking for a part: half a trailer spot per skid when on.
  const toggleDoubleStack = (item) => {
    const on = !isDoubleStackable(item);
    setDoubleStack(item, on);
    setTrucks((prev) => Object.fromEntries(Object.entries(prev).map(([wh, lines]) => [wh, lines.map((l) => (l.item === item ? { ...l, doubleStack: on } : l))])));
  };

  const removeLineItem = (id) => {
    setLines((prev) => prev.filter((li) => li.id !== id));
  };

  const setLineWeight = (id, weight) => {
    setLines((prev) => prev.map((li) => (li.id === id ? { ...li, weight, weightIsEstimate: false } : li)));
  };

  const adjustSkids = (id, delta) => {
    setLines((prev) =>
      prev.flatMap((li) => {
        if (li.id !== id) return [li];
        const stock = stockAt(availability, booked, li.item, active);
        const cap = li.manual ? Math.max(stock, 99) : stock; // a part added by hand can go past what the inventory file shows
        const next = Math.max(0, Math.min(cap, li.skids + delta));
        if (next === 0) return []; // taking off the last skid takes the line off the truck
        const updated = { ...li, skids: next };
        if (li.weightIsEstimate) {
          const est = estimateWeight(li.item, next);
          updated.weight = est ?? "";
        }
        return [updated];
      })
    );
  };

  const handleGenerateBol = async () => {
    if (!active || lineItems.length === 0) return;
    const duplicate = findTodaysDuplicate(bolNumber);
    if (duplicate) {
      const proceed = await window.toolkitConfirm(
        `BOL number ${bolNumber} was already generated today (${duplicate.warehouse}, ${duplicate.totalSkids} skids). Generate it again anyway?`
      );
      if (!proceed) return;
    }

    const warehouse = active;
    setGeneratingBol(true);
    try {
      await generateBOL({
        warehouse,
        lineItems,
        carrierName,
        scac,
        bolNumber,
        signatureName: selectedSignature,
      });
      logFinalizedLoad({
        date: todayStr(),
        timestamp: new Date().toISOString(),
        warehouse,
        bolNumber,
        carrierName,
        signatureName: selectedSignature,
        totalSkids: skidsUsed,
        totalSpots: Math.ceil(spotsUsed),
        items: lineItems.map((li) => ({ item: li.item, skids: li.skids, weight: li.weight })),
      });
      // The truck is done: clear it so the next one starts fresh. Its skids now
      // count as ordered via today's BOL log.
      setTrucks((prev) => ({ ...prev, [warehouse]: EMPTY_LINES }));
      setForms((prev) => {
        const { [warehouse]: _done, ...rest } = prev;
        return rest;
      });
      setNotice(
        `BOL ${bolNumber} downloaded — ${skidsUsed} skids from ${warehouse} now count as ordered. They're off the needs list and out of ${warehouse}'s available count.`
      );
    } catch (err) {
      setError(`Couldn't generate the BOL: ${err.message}`);
    } finally {
      setGeneratingBol(false);
    }
  };

  // ---- file uploads ----------------------------------------------------------
  const handleAvailabilityUpload = async (file) => {
    if (!file) return;
    setError(null);
    setLoadingAvail(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      setAvailability(parseAvailabilityWorkbook(wb));
    } catch (err) {
      setError(`Couldn't read that Excel file: ${err.message}`);
    } finally {
      setLoadingAvail(false);
    }
  };

  const handleNeedsUpload = async (file) => {
    if (!file) return;
    setError(null);
    setLoadingNeeds(true);
    try {
      const isSheet = /\.(xlsx|xlsm|xls|csv)$/i.test(file.name);
      const { needs: parsed, flagged } = isSheet ? await parseNeedsWorkbookFile(file) : await parseNeedsPdf(file);
      setNeedsFlagged(flagged);
      if (parsed.length === 0) {
        setNeeds(null);
        setError(
          isSheet
            ? "Read the spreadsheet but couldn't find an ITEM column with EVV Move pallets (or EVV Move Qty and Pallet Qty). Check that this is the Items Needing Replenishment export."
            : "Read the PDF's text but couldn't find any rows with an item number followed by an EVV Move pallet count. Check that this is the Items Needing Replenishment export."
        );
        return;
      }
      setNeeds(parsed);
    } catch (err) {
      setError(`Couldn't read that file: ${err.message}`);
    } finally {
      setLoadingNeeds(false);
    }
  };

  const banner = (kind) => ({
    background: `var(--${kind}-bg)`,
    color: kind === "red" ? "var(--red-light)" : kind === "green" ? "var(--green-light)" : "var(--amber-light)",
    padding: "10px 14px",
    borderRadius: 8,
    fontSize: 13,
    marginBottom: 16,
    border: `1px solid ${kind === "red" ? "#5a1515" : kind === "green" ? "var(--green)" : "#5a3d0a"}`,
  });

  return (
    <div style={{ fontFamily: "inherit" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <UploadCard
          header="Off Site Combined Inv"
          label="Offsite inventory (Excel)"
          hint="Combined WSI / WS2 / EAB export"
          accept=".xlsx,.xls"
          onFile={handleAvailabilityUpload}
          loading={loadingAvail}
          status={availability ? `${availability.size} parts loaded` : "No file uploaded yet"}
        />
        <UploadCard
          header="EVV DC Needs List"
          label="Needs list (PDF or Excel)"
          hint='"Items Needing Replenishment" export'
          accept=".pdf,.xlsx,.xlsm,.xls,.csv"
          onFile={handleNeedsUpload}
          loading={loadingNeeds}
          status={needs && needs.length ? `${needs.length} items needed` : "No file uploaded yet"}
        />
      </div>

      {error && <div style={banner("red")}>{error}</div>}

      {needsFlagged.length > 0 && (
        <div style={banner("amber")}>
          The EVV Move numbers for {needsFlagged.join(", ")} didn't line up with the rest of the row — double-check
          those pallet counts against the PDF before booking.
        </div>
      )}

      {notice && <div style={banner("green")}>{notice}</div>}

      {warehousesPresent.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          {warehousesPresent.map((wh) => {
            const lines = trucks[wh] || EMPTY_LINES;
            const spots = lines.reduce((s, l) => s + spotsForSkids(l.item, l.skids), 0);
            const skids = lines.reduce((s, l) => s + l.skids, 0);
            const full = spots >= TARGET_SKIDS;
            return (
              <button
                key={wh}
                onClick={() => selectWarehouse(wh)}
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  textAlign: "left",
                  borderRadius: 8,
                  border: wh === active ? "2px solid var(--accent)" : "1px solid var(--border-mid)",
                  background: "var(--bg-card)",
                  color: "var(--text-primary)",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 500 }}>{wh} truck</div>
                <div
                  style={{
                    fontSize: 12,
                    color: spots > TARGET_SKIDS ? "var(--red-light)" : full ? "var(--green-light)" : spots > 0 ? "var(--amber-light)" : "var(--text-muted)",
                  }}
                >
                  {Math.ceil(spots)} / {TARGET_SKIDS} spots{skids ? ` · ${skids} skids` : ""}
                  {full && spots <= TARGET_SKIDS ? " · full" : ""}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {spotsUsed > TARGET_SKIDS && (
        <div style={banner("red")}>
          Over trailer capacity — {Math.ceil(spotsUsed)} of {TARGET_SKIDS} spots on the {active} truck.
        </div>
      )}

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <StatCard label="Trailer spots" value={`${Math.ceil(spotsUsed)} / ${TARGET_SKIDS}`} />
        <StatCard label="Skids loaded" value={`${skidsUsed}`} />
        <StatCard
          label="Total weight"
          value={totalWeight != null ? `${fmtNum(totalWeight)} lbs` : "—"}
          warn={unweighed > 0}
        />
        <StatCard label="Warehouse" value={active || "—"} />
        <StatCard
          label="Still needed"
          value={
            !needs
              ? "—"
              : stillNeeded.length
                ? `${stillNeeded.length} item${stillNeeded.length === 1 ? "" : "s"}`
                : "None"
          }
          warn={stillNeeded.length > 0}
        />
      </div>

      {active && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
          <button onClick={autoFill} disabled={!needs || spotsLeft <= 0}>
            Auto-fill this truck
          </button>
          <button onClick={clearTruck} disabled={lineItems.length === 0}>
            Clear truck
          </button>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {needs
              ? `Build the ${active} truck from the "Still needed" list below, or auto-fill it.`
              : "Upload the EVV DC PDF to see what's needed."}
          </span>
        </div>
      )}

      {lineItems.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 24 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
              <th style={cellStyle}>Item</th>
              <th style={cellStyle}>Description</th>
              <th style={cellStyle}>From</th>
              <th style={cellStyle}>Need (EVV Move)</th>
              <th style={cellStyle}>Skids</th>
              <th style={cellStyle}>Spots</th>
              <th style={cellStyle}>Weight</th>
              <th style={cellStyle}></th>
            </tr>
          </thead>
          <tbody>
            {lineItems.map((li) => {
              const row = needByItem.get(li.item);
              const stock = stockAt(availability, booked, li.item, active);
              const overNeed = row && li.skids > row.remaining;
              return (
                <tr key={li.id}>
                  <td style={cellStyle}>{li.item}</td>
                  <td style={cellStyle}>
                    {li.description}
                    {!row && (
                      <span
                        style={{ marginLeft: 8, fontSize: 11, color: "var(--amber-light)", background: "var(--amber-bg)", padding: "2px 6px", borderRadius: 4 }}
                        title="Added by hand — not on the needs list"
                      >
                        not on list
                      </span>
                    )}
                    <button
                      onClick={() => toggleDoubleStack(li.item)}
                      title={li.doubleStack ? "Counts as half a trailer spot per skid. Click to turn off." : "Click if this part double-stacks (half a spot per skid)."}
                      style={{
                        marginLeft: 8, fontSize: 11, padding: "2px 7px", borderRadius: 4, cursor: "pointer",
                        border: li.doubleStack ? "1px solid transparent" : "1px dashed var(--border-mid)",
                        color: li.doubleStack ? "var(--green-light)" : "var(--text-muted)",
                        background: li.doubleStack ? "var(--green-bg)" : "transparent",
                      }}
                    >
                      {li.doubleStack ? "double-stacks ✓" : "double-stack?"}
                    </button>
                  </td>
                  <td style={cellStyle}>{li.warehouse}</td>
                  <td
                    style={{ ...cellStyle, color: overNeed ? "var(--amber-light)" : "inherit" }}
                    title={overNeed ? "More skids than are still needed" : undefined}
                  >
                    {row ? row.remaining : "—"}
                  </td>
                  <td style={cellStyle}>
                    <button onClick={() => adjustSkids(li.id, -1)}>-</button>
                    <span style={{ margin: "0 8px" }}>{li.skids}</span>
                    <button onClick={() => adjustSkids(li.id, 1)} disabled={!li.manual && li.skids >= stock}>
                      +
                    </button>
                    <span style={{ color: li.manual && li.skids > stock ? "var(--amber-light)" : "var(--text-muted)", marginLeft: 8 }}>
                      / {stock} avail{li.manual && li.skids > stock ? " in the file" : ""}
                    </span>
                  </td>
                  <td style={cellStyle}>{spotsForSkids(li.item, li.skids)}</td>
                  <td style={cellStyle}>
                    <input
                      type="number"
                      min="0"
                      value={li.weight || ""}
                      onChange={(e) => setLineWeight(li.id, e.target.value)}
                      placeholder="lbs"
                      style={{ width: 70 }}
                    />
                    {li.weightIsEstimate && isKnownWeight(li.item) && (
                      <span style={{ fontSize: 11, color: "var(--green-light)", marginLeft: 4 }} title="From your known skid weights list">known</span>
                    )}
                    {li.weightIsEstimate && !isKnownWeight(li.item) && (
                      <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 4 }} title="Estimated from past BOLs">est.</span>
                    )}
                    {UNRELIABLE_WEIGHT_ITEMS.has(String(li.item)) && (
                      <span
                        style={{
                          marginLeft: 4,
                          fontSize: 11,
                          color: "var(--amber-light)",
                          background: "var(--amber-bg)",
                          padding: "1px 5px",
                          borderRadius: 4,
                        }}
                        title="Weight has varied a lot for this part across past loads — double check it"
                      >
                        check
                      </span>
                    )}
                  </td>
                  <td style={{ ...cellStyle, textAlign: "right" }}>
                    <button onClick={() => removeLineItem(li.id)} aria-label="Remove">
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
            <tr style={{ fontWeight: 600 }}>
              <td style={cellStyle} colSpan={4}>
                Total
              </td>
              <td style={cellStyle}>{skidsUsed} skids</td>
              <td style={cellStyle}>{spotsUsed}</td>
              <td style={cellStyle}>
                {totalWeight != null ? `${fmtNum(totalWeight)} lbs` : "—"}
                {unweighed > 0 && (
                  <div style={{ fontSize: 11, fontWeight: 400, color: "var(--amber-light)" }}>
                    {unweighed} line{unweighed === 1 ? "" : "s"} not weighed
                  </div>
                )}
              </td>
              <td style={cellStyle}></td>
            </tr>
          </tbody>
        </table>
      )}

      {lineItems.length > 0 && (
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: "1rem 1.25rem",
            marginBottom: 24,
          }}
        >
          <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 10px" }}>
            Generate Bill of Lading for this load ({active})
          </p>
          <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
            <input
              placeholder="Carrier name"
              value={carrierName}
              onChange={(e) => setFormField("carrierName", e.target.value)}
            />
            <input placeholder="SCAC" value={scac} onChange={(e) => setFormField("scac", e.target.value)} />
            <input
              placeholder="BOL number (auto-filled, editable)"
              value={bolNumber}
              onChange={(e) => setFormField("bolNumber", e.target.value)}
            />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>Signature:</label>
            <select value={selectedSignature} onChange={(e) => setSelectedSignature(e.target.value)}>
              <option value="">(none selected)</option>
              {signatureNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <input
              placeholder="Add a name…"
              value={newSignatureName}
              onChange={(e) => setNewSignatureName(e.target.value)}
              style={{ width: 140 }}
            />
            <button onClick={addSignatureName}>Add</button>
            {selectedSignature && (
              <button onClick={() => setPadFor(selectedSignature)}>Draw signature</button>
            )}
          </div>
          {selectedSignature && (
            <div style={{ marginBottom: 12 }}>
              <SignaturePreview name={selectedSignature} version={sigVersion} />
            </div>
          )}
          {padFor && (
            <SignaturePad name={padFor} onClose={() => setPadFor(null)} onSaved={() => setSigVersion((v) => v + 1)} />
          )}
          <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 10px" }}>
            BOL totals: {skidsUsed} pallets ·{" "}
            {totalWeight != null ? `${fmtNum(totalWeight)} lbs` : "no weights yet"}
          </p>
          <button onClick={handleGenerateBol} disabled={generatingBol}>
            {generatingBol ? "Generating…" : "Download BOL (.docx)"}
          </button>
          {unweighed > 0 && (
            <span style={{ marginLeft: 12, fontSize: 12, color: "var(--amber-light)" }}>
              {unweighed} line{unweighed === 1 ? " has" : "s have"} no weight, so the total doesn't include {unweighed === 1 ? "it" : "them"}. Type a weight in the table to add it.
            </span>
          )}
        </div>
      )}

      {needs && availability && active && (
        <div style={{ marginBottom: 24 }}>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 8 }}>
            Still needed — add to the {active} truck
            {stillNeeded.length ? ` (${stillNeeded.length})` : ""}
          </p>
          {stillNeeded.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--green-light)" }}>
              Nothing left on the needs list — everything is on a truck or a BOL.
            </p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                  <th style={cellStyle}>Item</th>
                  <th style={cellStyle}>Description</th>
                  <th style={cellStyle}>Still need</th>
                  {warehousesPresent.map((wh) => (
                    <th
                      key={wh}
                      style={{ ...cellStyle, color: wh === active ? "var(--green-light)" : "var(--text-muted)" }}
                    >
                      {wh} has
                    </th>
                  ))}
                  <th style={cellStyle}></th>
                </tr>
              </thead>
              <tbody>
                {stillNeeded.map((r) => {
                  const room = Math.max(0, r.stock[active] - r.here);
                  const bySpots = isDoubleStackable(r.item) ? Math.floor(spotsLeft * 2) : Math.floor(spotsLeft);
                  const addQty = Math.min(r.unassigned, room, bySpots);
                  const why =
                    !r.inInventory
                      ? "Not in offsite inventory"
                      : room <= 0
                        ? `None available at ${active}`
                        : bySpots <= 0
                          ? "Truck is full"
                          : "";
                  return (
                    <tr key={r.item}>
                      <td style={cellStyle}>{r.item}</td>
                      <td style={cellStyle}>{r.description}</td>
                      <td style={cellStyle}>
                        {r.unassigned}
                        {r.here > 0 && (
                          <span style={{ color: "var(--text-muted)" }}> ({r.here} on truck)</span>
                        )}
                      </td>
                      {warehousesPresent.map((wh) => (
                        <td
                          key={wh}
                          style={{
                            ...cellStyle,
                            fontWeight: wh === active ? 600 : 400,
                            color: r.stock[wh] > 0 ? (wh === active ? "var(--green-light)" : "inherit") : "var(--text-muted)",
                          }}
                        >
                          {r.stock[wh] > 0 ? r.stock[wh] : "—"}
                        </td>
                      ))}
                      <td style={{ ...cellStyle, textAlign: "right" }}>
                        {addQty > 0 ? (
                          <button onClick={() => addToTruck(r, addQty)}>Add {addQty}</button>
                        ) : (
                          <span style={{ fontSize: 12, color: "var(--amber-light)" }}>{why}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {coveredElsewhere.length > 0 && (
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}>
              Already covered:{" "}
              {coveredElsewhere
                .map((r) => {
                  const parts = [];
                  if (r.bookedAll) parts.push(`${r.bookedAll} on today's BOLs`);
                  if (r.elsewhere) parts.push(`${r.elsewhere} on another truck`);
                  return `${r.item} (needed ${r.movePallets}: ${parts.join(", ")})`;
                })
                .join(" · ")}
            </p>
          )}
        </div>
      )}

      {availability && active && (
        <AddOtherPart
          warehouse={active}
          warehouses={warehousesPresent}
          needItems={new Set((needs || []).map((n) => n.item))}
          stockAt={(it, wh) => stockAt(availability, booked, it, wh)}
          availability={availability}
          stockFor={(it) => stockAt(availability, booked, it, active)}
          onTruck={(it) => lineItems.find((l) => l.item === it)?.skids || 0}
          onAdd={addOtherPart}
        />
      )}

      {loadHistory.length > 0 && (
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: "1rem 1.25rem",
            marginBottom: 24,
          }}
        >
          <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 4px" }}>
            Load history ({loadHistory.length})
          </p>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 10px" }}>
            BOLs from today count as already ordered. Release one to put its skids back on the needs list.
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                <th style={cellStyle}>Date</th>
                <th style={cellStyle}>Warehouse</th>
                <th style={cellStyle}>BOL #</th>
                <th style={cellStyle}>Skids</th>
                <th style={cellStyle}>Signed by</th>
                <th style={cellStyle}></th>
              </tr>
            </thead>
            <tbody>
              {loadHistory.slice(0, 20).map((h, i) => (
                <tr key={h.timestamp || i}>
                  <td style={cellStyle}>{h.date}</td>
                  <td style={cellStyle}>{h.warehouse}</td>
                  <td style={cellStyle}>{h.bolNumber}</td>
                  <td style={cellStyle}>{h.totalSkids}</td>
                  <td style={cellStyle}>{h.signatureName || "—"}</td>
                  <td style={{ ...cellStyle, textAlign: "right" }}>
                    {h.date === todayStr() && <button onClick={() => releaseLoad(h)}>Release</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loadHistory.length > 20 && (
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
              Showing the 20 most recent — {loadHistory.length} total logged.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const cellStyle = { padding: "8px 4px", borderBottom: "1px solid var(--border)" };

function UploadCard({ header, label, hint, accept, onFile, loading, status }) {
  const [drag, setDrag] = useState(false);
  const loaded = !!status && status !== "No file uploaded yet";

  const openBrowser = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = (ev) => onFile(ev.target.files?.[0]);
    input.click();
  };

  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: "1rem 1.25rem",
      }}
    >
      {header && (
        <p style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", margin: "0 0 6px" }}>
          {header}
        </p>
      )}
      <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 4px" }}>{label}</p>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 12px" }}>{hint}</p>
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const file = e.dataTransfer.files?.[0];
          if (file) onFile(file);
        }}
        onClick={() => !loading && openBrowser()}
        style={{
          border: `1.5px dashed ${loaded ? "var(--green)" : drag ? "var(--accent-light)" : "var(--border-mid)"}`,
          borderRadius: "var(--radius)",
          background: loaded ? "var(--green-bg)" : drag ? "var(--bg-card-hover)" : "var(--bg-input)",
          padding: "20px 16px",
          textAlign: "center",
          cursor: loading ? "default" : "pointer",
          userSelect: "none",
          transition: "all 0.15s",
        }}
      >
        <div style={{ fontSize: 20, marginBottom: 6, color: loaded ? "var(--green-light)" : "var(--text-muted)" }}>
          {loading ? "⏳" : loaded ? "✓" : "↑"}
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color: loaded ? "var(--green-light)" : "var(--text-primary)" }}>
          {loading ? "Reading file…" : loaded ? status : "Drop file here, or click to browse"}
        </div>
      </div>
    </div>
  );
}

const otherCell = { padding: "6px 8px", borderBottom: "1px solid var(--border)" };
// Add any part to the truck, on the needs list or not. Suggests parts this warehouse has, but takes any item number.
function AddOtherPart({ warehouse, warehouses, needItems, stockAt: stockAtWh, availability, stockFor, onTruck, onAdd }) {
  const [browse, setBrowse] = useState(false);
  const [q, setQ] = useState("");
  const [item, setItem] = useState("");
  const [desc, setDesc] = useState("");
  const [qty, setQty] = useState(1);
  const it = item.trim();
  const known = it ? availability.get(it) : null;
  const stock = it ? stockFor(it) : 0;
  const left = Math.max(0, stock - (it ? onTruck(it) : 0));
  const options = useMemo(
    () =>
      Array.from(availability.entries())
        .filter(([, e]) => (e.byWarehouse[warehouse]?.length || 0) > 0)
        .map(([k, e]) => ({ item: k, description: e.description || "" }))
        .sort((a, b) => a.item.localeCompare(b.item)),
    [availability, warehouse]
  );
  // Everything this warehouse has in the Off Site Combined Inv that isn't on the needs list.
  const others = useMemo(
    () =>
      options
        .filter((o) => !needItems.has(o.item))
        .map((o) => ({ ...o, left: Math.max(0, stockAtWh(o.item, warehouse) - onTruck(o.item)), onTruck: onTruck(o.item) }))
        .filter((o) => o.left > 0 || o.onTruck > 0),
    [options, needItems, warehouse, stockAtWh, onTruck]
  );
  const shown = q.trim()
    ? others.filter((o) => (o.item + " " + o.description).toLowerCase().includes(q.trim().toLowerCase()))
    : others;
  const elsewhere = it && known
    ? warehouses.filter((wh) => wh !== warehouse).map((wh) => [wh, stockAtWh(it, wh)]).filter(([, n]) => n > 0)
    : [];
  const submit = () => {
    if (!it || !(qty > 0)) return;
    onAdd({ item: it, description: desc.trim() || known?.description || "", qty: Number(qty) });
    setItem(""); setDesc(""); setQty(1);
  };
  const listId = `other-parts-${warehouse}`;
  return (
    <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: "1rem 1.25rem", marginBottom: 24 }}>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 10px" }}>
        Add a part that isn't on the needs list ({warehouse} truck)
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          list={listId}
          placeholder="Item number"
          value={item}
          onChange={(e) => { setItem(e.target.value); setDesc(""); }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          style={{ width: 140 }}
          aria-label="Item number"
        />
        <datalist id={listId}>
          {options.map((o) => (
            <option key={o.item} value={o.item}>{o.description}</option>
          ))}
        </datalist>
        <input
          placeholder={known?.description || "Description"}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          style={{ flex: "1 1 220px", minWidth: 160 }}
          aria-label="Description"
        />
        <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 6 }}>
          Skids
          <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 64 }} />
        </label>
        <button onClick={submit} disabled={!it || !(Number(qty) > 0)}>Add to truck</button>
      </div>
      {it && (
        <p style={{ fontSize: 12, margin: "8px 0 0", color: known && left >= Number(qty) ? "var(--text-muted)" : "var(--amber-light)" }}>
          {known
            ? `${known.description || "This part"} · ${left} skid${left === 1 ? "" : "s"} at ${warehouse} not already on the truck${left < Number(qty) ? " — the file shows fewer than you're adding, but it'll still go on" : ""}.`
            : `${it} isn't in the Off Site Combined Inv at all. It'll still go on the truck; add a description so the BOL reads right.`}
          {known && left === 0 && !elsewhere.length && ` ${warehouse} shows none in the file.`}
          {elsewhere.length > 0 && ` Also in the file at ${elsewhere.map(([wh, n]) => `${wh} (${n})`).join(", ")}.`}
        </p>
      )}
      <div style={{ marginTop: 12 }}>
        <button onClick={() => setBrowse((b) => !b)}>
          {browse ? "Hide" : "Show"} everything else at {warehouse} ({others.length} part{others.length === 1 ? "" : "s"} in the Off Site Combined Inv, not on the needs list)
        </button>
      </div>
      {browse && (
        <div style={{ marginTop: 10 }}>
          <input placeholder="Search item or description" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260, marginBottom: 8 }} aria-label="Search other parts" />
          {shown.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Nothing matches.</p>
          ) : (
            <div style={{ maxHeight: 360, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                    <th style={otherCell}>Item</th><th style={otherCell}>Description</th><th style={otherCell}>Skids left at {warehouse}</th><th style={otherCell}>On truck</th><th style={otherCell}></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((o) => (
                    <tr key={o.item}>
                      <td style={otherCell}>{o.item}</td>
                      <td style={otherCell}>{o.description}</td>
                      <td style={otherCell}>{o.left}</td>
                      <td style={otherCell}>{o.onTruck || "—"}</td>
                      <td style={{ ...otherCell, textAlign: "right" }}>
                        <button disabled={o.left <= 0} onClick={() => onAdd({ item: o.item, description: o.description, qty: 1 })}>+ 1 skid</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, warn }) {
  return (
    <div
      style={{
        flex: 1,
        background: "var(--bg-input)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "1rem",
        textAlign: "center",
      }}
    >
      <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 4px" }}>{label}</p>
      <p
        style={{
          fontSize: 22,
          fontWeight: 500,
          margin: 0,
          color: warn ? "var(--amber-light)" : "var(--text-primary)",
        }}
      >
        {value}
      </p>
    </div>
  );
}
