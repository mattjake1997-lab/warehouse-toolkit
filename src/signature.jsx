import React, { useEffect, useRef, useState } from "react";

// Signatures for the BOL. Every name gets a handwritten-style signature in a
// script font; anyone can instead draw their own, which is kept in this browser.
// The BOL prints the signature as a picture with the name in plain print beside it.

const FONT = "Mrs Saint Delafield";
const INK = "#1b2a6b";
const DRAWN_KEY = "truckLoadBuilder.drawnSignatures";

export function loadDrawn() {
  try { return JSON.parse(localStorage.getItem(DRAWN_KEY) || "{}"); } catch { return {}; }
}
function saveDrawn(map) {
  try { localStorage.setItem(DRAWN_KEY, JSON.stringify(map)); } catch { /* not kept after reload */ }
}

async function fontReady() {
  try { await document.fonts.load(`80px "${FONT}"`); } catch { /* falls back to cursive */ }
}

// Cut a canvas down to its inked area, with a little padding.
function trim(canvas, pad = 8) {
  const ctx = canvas.getContext("2d");
  const { width: w, height: h } = canvas;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext("2d").drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

async function typedSignature(name) {
  await fontReady();
  const c = document.createElement("canvas");
  c.width = 1400; c.height = 300;
  const ctx = c.getContext("2d");
  ctx.fillStyle = INK;
  ctx.font = `150px "${FONT}", "Brush Script MT", cursive`;
  ctx.textBaseline = "middle";
  ctx.fillText(name, 40, 150);
  return trim(c, 12)?.toDataURL("image/png") || null;
}

/** The picture for a name's signature: the drawn one if there is one, else the script one. */
export async function signatureDataUrl(name) {
  if (!name) return null;
  const drawn = loadDrawn()[name];
  return drawn || typedSignature(name);
}

/** PNG bytes plus a print size (px at 96 dpi) for the BOL. */
export async function signatureForBol(name) {
  const url = await signatureDataUrl(name);
  if (!url) return null;
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const height = 44;
  const width = Math.min(260, Math.round((img.width / img.height) * height));
  const bin = atob(url.split(",")[1]);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  return { data, width, height: Math.round(width / (img.width / img.height)) };
}

/** A preview of the signature with the printed name beside it, as it appears on the BOL. */
export function SignaturePreview({ name, version }) {
  const [url, setUrl] = useState(null);
  useEffect(() => { let live = true; signatureDataUrl(name).then((u) => live && setUrl(u)); return () => { live = false; }; }, [name, version]);
  if (!name) return null;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 14, background: "#fbfaf6", borderRadius: 8, padding: "10px 14px", color: "#222", flexWrap: "wrap" }}>
      <div style={{ display: "grid", gap: 2 }}>
        <span style={{ fontSize: 11, color: "#666" }}>Shipper signature</span>
        <div style={{ borderBottom: "1px solid #444", minWidth: 180, minHeight: 46, display: "flex", alignItems: "flex-end" }}>
          {url && <img src={url} alt={`Signature of ${name}`} style={{ height: 42, width: "auto", maxWidth: 260 }} />}
        </div>
      </div>
      <div style={{ display: "grid", gap: 2 }}>
        <span style={{ fontSize: 11, color: "#666" }}>Printed name</span>
        <span style={{ fontSize: 15, borderBottom: "1px solid #444", paddingBottom: 2, minWidth: 140 }}>{name}</span>
      </div>
    </div>
  );
}

/** A pop-up pad to draw a signature with the mouse, a finger or a pen. */
export function SignaturePad({ name, onClose, onSaved }) {
  const ref = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);
  const [inked, setInked] = useState(false);
  const hasDrawn = !!loadDrawn()[name];

  useEffect(() => {
    const c = ref.current;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio; c.height = c.clientHeight * ratio;
    const ctx = c.getContext("2d");
    ctx.scale(ratio, ratio); ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = INK; ctx.lineWidth = 2.6;
  }, []);

  const pos = (e) => { const r = ref.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e) => { e.preventDefault(); ref.current.setPointerCapture(e.pointerId); drawing.current = true; last.current = pos(e); };
  const move = (e) => {
    if (!drawing.current) return;
    const p = pos(e), ctx = ref.current.getContext("2d");
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last.current = p; setInked(true);
  };
  const up = () => { drawing.current = false; };
  const clear = () => { const c = ref.current; c.getContext("2d").clearRect(0, 0, c.width, c.height); setInked(false); };
  const save = () => {
    const t = trim(ref.current, 10); if (!t) return;
    const map = loadDrawn(); map[name] = t.toDataURL("image/png"); saveDrawn(map); onSaved(); onClose();
  };
  const useTyped = () => { const map = loadDrawn(); delete map[name]; saveDrawn(map); onSaved(); onClose(); };

  return (
    <div role="dialog" aria-modal="true" aria-label={`Draw signature for ${name}`}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", display: "grid", placeItems: "center", zIndex: 50, padding: 16 }}
      onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div style={{ background: "var(--bg-card)", border: "1px solid var(--border-mid)", borderRadius: 12, padding: 18, width: "min(560px,100%)", display: "grid", gap: 12 }}>
        <div>
          <p style={{ margin: 0, fontWeight: 600, fontSize: 16 }}>Draw the signature for {name}</p>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>Sign in the box with your mouse, finger or pen. It's kept on this computer and used on every BOL signed by {name}.</p>
        </div>
        <canvas ref={ref} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}
          style={{ width: "100%", height: 170, background: "#fbfaf6", borderRadius: 8, touchAction: "none", cursor: "crosshair", borderBottom: "2px solid #999" }} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={clear}>Clear</button>
            {hasDrawn && <button onClick={useTyped}>Use the script signature instead</button>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose}>Cancel</button>
            <button onClick={save} disabled={!inked} style={{ background: "var(--accent)", color: "#001a00", borderColor: "var(--accent)" }}>Save signature</button>
          </div>
        </div>
      </div>
    </div>
  );
}
