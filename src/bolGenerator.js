import {
  Document,
  Packer,
  Table,
  TableRow,
  TableCell,
  Paragraph,
  TextRun,
  WidthType,
  VerticalAlign,
  AlignmentType,
  BorderStyle,
  ImageRun,
} from "docx";
import { signatureForBol } from "./signature.jsx";
import { saveAs } from "file-saver";
import { sites } from "./settings.js";

// ---------------------------------------------------------------------------
// Known warehouse addresses — used to fill Ship From / Ship To automatically.
// ---------------------------------------------------------------------------
// From the settings file: each site's name and address. The main warehouse is stored under MAIN.
const WAREHOUSE_ADDRESSES = Object.fromEntries(
  sites.map((s) => [s.main ? "MAIN" : s.code, [s.bolName || s.code, s.address || ""].filter(Boolean).join("\n")])
);

const THIN_BORDER = { style: BorderStyle.SINGLE, size: 2, color: "000000" };
const CELL_BORDERS = {
  top: THIN_BORDER,
  bottom: THIN_BORDER,
  left: THIN_BORDER,
  right: THIN_BORDER,
};

function labelCell(label, opts = {}) {
  return new TableCell({
    borders: CELL_BORDERS,
    width: opts.width,
    columnSpan: opts.columnSpan,
    rowSpan: opts.rowSpan,
    verticalAlign: VerticalAlign.TOP,
    children: [
      new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 18 })] }),
    ],
  });
}

function valueCell(text, opts = {}) {
  const lines = String(text ?? "").split("\n");
  return new TableCell({
    borders: CELL_BORDERS,
    width: opts.width,
    columnSpan: opts.columnSpan,
    rowSpan: opts.rowSpan,
    verticalAlign: VerticalAlign.TOP,
    children: lines.map(
      (line) => new Paragraph({ children: [new TextRun({ text: line, size: 20 })] })
    ),
  });
}

const fmtNum = (n) => Number(n).toLocaleString("en-US");

// Same as labeledValueCell, but the value sits on its own line in large bold
// type — used for the BOL number and carrier name so they can be read at a
// glance on the printed page.
function labeledBigValueCell(label, value, opts = {}) {
  return new TableCell({
    borders: CELL_BORDERS,
    width: opts.width,
    columnSpan: opts.columnSpan,
    rowSpan: opts.rowSpan,
    verticalAlign: VerticalAlign.TOP,
    children: [
      new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 18 })] }),
      new Paragraph({ children: [new TextRun({ text: String(value ?? ""), bold: true, size: 40 })] }),
    ],
  });
}

function labeledValueCell(label, value, opts = {}) {
  return new TableCell({
    borders: CELL_BORDERS,
    width: opts.width,
    columnSpan: opts.columnSpan,
    rowSpan: opts.rowSpan,
    verticalAlign: VerticalAlign.TOP,
    children: [
      new Paragraph({
        children: [
          new TextRun({ text: `${label} `, bold: true, size: 18 }),
          new TextRun({ text: String(value ?? ""), size: 20 }),
        ],
      }),
    ],
  });
}

// Carrier is set by which warehouse the load comes from (settings file: each site's "carrier").
const CARRIER_BY_WAREHOUSE = Object.fromEntries(sites.filter((s) => s.carrier).map((s) => [s.code, s.carrier]));

export function carrierForWarehouse(warehouse) {
  return CARRIER_BY_WAREHOUSE[warehouse] || "";
}

/**
 * Generates a BOL number from today's date plus the last 3 digits of the
 * first 1-2 line items on the load — e.g. Aug 12, 2026 with items 100153
 * and 100092 on the load produces "81226153092"
 * (month "8" + day "12" + year "26" + "153" + "092").
 */
export function generateBolNumber(lineItems, date = new Date()) {
  const month = date.getMonth() + 1; // no leading zero, matches the example
  const day = String(date.getDate()).padStart(2, "0");
  const year = String(date.getFullYear()).slice(-2);
  const datePart = `${month}${day}${year}`;
  const itemDigits = (lineItems || [])
    .slice(0, 2)
    .map((li) => String(li.item).slice(-3))
    .join("");
  return `${datePart}${itemDigits}`;
}

/**
 * Builds a shippable Bill of Lading document (see generateBOL to download it).
 *
 * @param {Object} params
 * @param {string} params.warehouse - "EAB" | "WSI" | "WS2"
 * @param {Array}  params.lineItems - [{ item, description, skids, weight }]
 * @param {string} params.carrierName
 * @param {string} params.scac
 * @param {string} params.bolNumber
 * @param {string} [params.date] - defaults to today
 * @param {string} [params.specialInstructions] - defaults to standard text
 */
export function buildBolDocument({
  warehouse,
  lineItems,
  carrierName,
  scac,
  bolNumber,
  date,
  specialInstructions,
  signatureName,
  signatureImage,
}) {
  const shipFrom = WAREHOUSE_ADDRESSES[warehouse] || warehouse;
  const shipTo = WAREHOUSE_ADDRESSES.MAIN || "";
  const displayDate = date || new Date().toLocaleDateString("en-US");
  const grandTotal = lineItems.reduce((sum, li) => sum + Number(li.skids || 0), 0);
  // Total weight adds up every line that has a weight. The builder warns when a
  // line is missing one, before the BOL is made.
  const weighed = lineItems.filter((li) => Number(li.weight) > 0);
  const grandWeight = weighed.length ? weighed.reduce((sum, li) => sum + Number(li.weight), 0) : null;
  const instructions = specialInstructions || "Special Instructions: (deliver between 8-3)";

  const headerRow = new TableRow({
    children: [
      labelCell("Date", { width: { size: 15, type: WidthType.PERCENTAGE } }),
      valueCell(displayDate, { width: { size: 25, type: WidthType.PERCENTAGE } }),
      new TableCell({
        borders: CELL_BORDERS,
        width: { size: 60, type: WidthType.PERCENTAGE },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: "Bill of Lading — Short Form — Not Negotiable",
                bold: true,
                size: 22,
              }),
            ],
          }),
        ],
      }),
    ],
  });

  const shipFromToRow = new TableRow({
    children: [
      valueCell(`Ship From\n\n${shipFrom}`, { columnSpan: 2 }),
      labeledBigValueCell("Bill of Lading Number:", bolNumber),
    ],
  });

  const shipToRow = new TableRow({
    children: [
      valueCell(`Ship To\n\n${shipTo}`, { columnSpan: 2 }),
      labeledBigValueCell("Carrier Name:", carrierName),
    ],
  });

  const scacRow = new TableRow({
    children: [
      valueCell("Third Party Freight Charges Bill To\n\n(none)", { columnSpan: 2 }),
      labeledValueCell("SCAC:", scac),
    ],
  });

  const instructionsRow = new TableRow({
    children: [valueCell(instructions, { columnSpan: 3 })],
  });

  const itemsHeaderRow = new TableRow({
    children: [
      labelCell("Part Number", { width: { size: 40, type: WidthType.PERCENTAGE } }),
      labelCell("# of Pallets", { width: { size: 20, type: WidthType.PERCENTAGE } }),
      labelCell("Weight", { width: { size: 20, type: WidthType.PERCENTAGE } }),
      labelCell("Pallet/Slip (circle one)", { width: { size: 20, type: WidthType.PERCENTAGE } }),
    ],
  });

  const itemRows = lineItems.map(
    (li) =>
      new TableRow({
        children: [
          valueCell(`${li.item}${li.description ? " — " + li.description : ""}`),
          valueCell(String(li.skids)),
          valueCell(Number(li.weight) > 0 ? fmtNum(li.weight) : ""), // left blank for hand-fill if not provided
          valueCell("Pallet / Slip"),
        ],
      })
  );

  const grandTotalRow = new TableRow({
    children: [
      labelCell("Grand Total"),
      valueCell(String(grandTotal)),
      valueCell(grandWeight != null ? fmtNum(grandWeight) : ""),
      valueCell(""),
    ],
  });

  const itemsTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [itemsHeaderRow, ...itemRows, grandTotalRow],
  });

  // Carrier Information — Handling Unit Qty/Type is always the total pallet
  // count and "Skid"; Weight is the load's total weight (TBD only when no line has a weight).
  const carrierInfoHeaderRow = new TableRow({
    children: [
      labelCell("Handling Unit Qty"),
      labelCell("Handling Unit Type"),
      labelCell("Weight"),
    ],
  });
  const carrierInfoValueRow = new TableRow({
    children: [
      valueCell(String(grandTotal)),
      valueCell("Skid"),
      valueCell(grandWeight != null ? `${fmtNum(grandWeight)} lbs` : "TBD"),
    ],
  });
  const carrierInfoTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [carrierInfoHeaderRow, carrierInfoValueRow],
  });

  const headerTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, shipFromToRow, shipToRow, scacRow, instructionsRow],
  });

  const footer = [
    new Paragraph({ spacing: { before: 200 }, children: [
      new TextRun({
        text:
          "Received, subject to individually determined rates or contracts that have been agreed upon in writing between the carrier and shipper, if applicable, otherwise to the rates, classifications, and rules that have been established by the carrier and are available to the shipper, on request, and to all applicable state and federal regulations.",
        size: 16,
        italics: true,
      }),
    ]}),
    new Paragraph({ spacing: { before: 300 }, children: [
      new TextRun({ text: "Shipper Signature: ", size: 20 }),
      signatureImage
        ? new ImageRun({ type: "png", data: signatureImage.data, transformation: { width: signatureImage.width, height: signatureImage.height } })
        : new TextRun({ text: "_______________________________", size: 20 }),
      new TextRun({ text: "     Printed Name: ", size: 20 }),
      new TextRun({ text: signatureName || "____________________", size: 20 }),
      new TextRun({ text: "     Date: ", size: 20 }),
      new TextRun({ text: signatureName ? displayDate : "__________", size: 20 }),
    ]}),
    new Paragraph({ spacing: { before: 300 }, children: [
      new TextRun({ text: "Carrier Signature/Pickup Date: _______________________________", size: 20 }),
    ]}),
  ];

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: {
              // US Letter, in twips (1/1440 inch) — docx defaults to A4,
              // which prints wrong on standard US printers/paper.
              width: 12240,
              height: 15840,
            },
            margin: {
              top: 720, // 0.5"
              bottom: 720,
              left: 720,
              right: 720,
            },
          },
        },
        children: [
          headerTable,
          new Paragraph({ text: "" }),
          itemsTable,
          new Paragraph({ text: "" }),
          carrierInfoTable,
          ...footer,
        ],
      },
    ],
  });

  return doc;
}

/** Builds the Bill of Lading and downloads it as a .docx. Same params as buildBolDocument. */
export async function generateBOL(params) {
  let signatureImage = null;
  try { signatureImage = params.signatureName ? await signatureForBol(params.signatureName) : null; } catch { signatureImage = null; }
  const doc = buildBolDocument({ ...params, signatureImage });
  const blob = await Packer.toBlob(doc);
  const filename = `BOL_${params.warehouse}_${params.bolNumber || "draft"}.docx`;
  saveAs(blob, filename);
}
