import { brandName } from "./settings.js";
import React from 'react'

// Same "explained reason" logic as the main app — a discrepancy explained
// with one of these reasons no longer counts against the reconciled %.
// "Missing Pallet" is deliberately excluded: it's still a real discrepancy.
// "Other" IS included since it's always paired with a typed-in explanation.
const EXPLAINED_REASONS = new Set([
  'Load is still on trailer',
  'Load has not been added to Inv',
  'Load has not been brought back to MET Inv',
  'Other',
])

function isLineAccounted(line, warehouse, exceptionCategories) {
  if (line.status === 'ok') return true
  const reasonKey = `${warehouse}-${line.part}`
  return EXPLAINED_REASONS.has(exceptionCategories[reasonKey])
}

export default function PrintReport({ reportName, date, summary, eabRec, wsiRec, ws2Rec, eabShipped, wsiShipped, ws2Shipped, eabReported, wsiReported, ws2Reported, overallPct, allIssues, exceptionReasons = {}, exceptionCategories = {}, eabLoaded = true, wsiLoaded = true, ws2Loaded = true, onClose }) {

  // Pages on the toolkit link can't open the print dialog, so the report is saved as a PDF instead.
  const handlePrint = () => window.toolkitPdfFromElement(document.getElementById('print-body'), `${(reportName||'pallet-audit-report').replace(/[^\w\- ]+/g,'').trim().replace(/\s+/g,'-')}.pdf`)

  const warehouseSections = [
    { name: 'EAB', lines: eabRec, shipped: eabShipped, reported: eabReported, loaded: eabLoaded },
    { name: 'WSI', lines: wsiRec, shipped: wsiShipped, reported: wsiReported, loaded: wsiLoaded },
    { name: 'WS2', lines: ws2Rec, shipped: ws2Shipped, reported: ws2Reported, loaded: ws2Loaded },
  ]

  const statusLabel = { ok: 'Match', missing: 'Missing', short: 'Short', over: 'Over', 'unmatched-warehouse': 'Not Shipped' }

  // Colors: green = good, yellow/orange = close, red = needs attention. Each warehouse has its own color.
  const C = { ink: '#0f172a', muted: '#64748b', line: '#e2e8f0', green: '#15803d', greenBg: '#dcfce7', dark: '#0a0d0a', brand: '#00a000', purple: '#7c3aed' }
  const WH = { EAB: '#15803d', WSI: '#7c3aed', WS2: '#0e7490' }
  const band = (p) => p >= 98 ? ['#15803d', '#dcfce7'] : p >= 85 ? ['#a16207', '#fef9c3'] : p >= 65 ? ['#c2410c', '#ffedd5'] : ['#b91c1c', '#fee2e2']
  const STATUS = { ok: ['#15803d', '#dcfce7'], missing: ['#b91c1c', '#fee2e2'], short: ['#c2410c', '#ffedd5'], over: ['#a16207', '#fef9c3'], 'unmatched-warehouse': ['#6d28d9', '#ede9fe'] }
  const Pill = ({ fg, bg, children, big }) => (
    <span style={{ display: 'inline-block', padding: big ? '6px 14px' : '2px 9px', borderRadius: 999, background: bg, color: fg, fontWeight: 800, fontSize: big ? 26 : 12, lineHeight: big ? 1.1 : 1.6, whiteSpace: 'nowrap' }}>{children}</span>
  )
  const H2 = ({ color = C.brand, children }) => (
    <h2 style={{ fontSize: 14, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.ink, margin: '0 0 12px', paddingLeft: 10, borderLeft: `5px solid ${color}` }}>{children}</h2>
  )

  return (
    <>
      {/* screen overlay */}
      <div className="print-overlay" style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
        zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '32px 16px', overflowY: 'auto'
      }}>
        <div style={{ background: '#fff', borderRadius: 10, width: '100%', maxWidth: 860, color: '#111', position: 'relative' }}>

          {/* screen-only toolbar */}
          <div className="no-print" style={{
            padding: '16px 24px', borderBottom: '1px solid #e5e7eb',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12
          }}>
            <span style={{ fontWeight: 700, fontSize: 15, color: '#111' }}>Report preview — {reportName}</span>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={onClose} style={{
                padding: '8px 18px', borderRadius: 6, border: '1px solid #d1d5db',
                background: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#374151'
              }}>Cancel</button>
              <button onClick={handlePrint} style={{
                padding: '8px 20px', borderRadius: 6, border: 'none',
                background: '#1d4ed8', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer'
              }}>Download PDF</button>
            </div>
          </div>

          {/* report body */}
          <div id="print-body" style={{ padding: '40px 48px', fontFamily: 'Arial, sans-serif' }}>

            {/* header */}
            <div style={{ background: C.dark, color: '#fff', borderRadius: 12, padding: '22px 26px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
              <div>
                <div style={{ fontSize: 11, color: '#9ae6b4', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 800, marginBottom: 6 }}>{brandName || 'Warehouse Toolkit'}</div>
                <h1 style={{ fontSize: 26, fontWeight: 800, color: '#fff', margin: 0, letterSpacing: '-0.02em' }}>Off Site Pallet Audit Report</h1>
                <div style={{ fontSize: 14, color: '#cbd5e1', marginTop: 6 }}>{reportName} · Generated {date}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <Pill fg={band(overallPct)[0]} bg={band(overallPct)[1]} big>{overallPct}%</Pill>
                <div style={{ fontSize: 12, color: '#cbd5e1', marginTop: 6 }}>Overall reconciled</div>
              </div>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: `linear-gradient(90deg, ${C.brand} 0 70%, ${C.purple} 70% 100%)`, marginBottom: 24 }} />

            {/* one card per warehouse */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 28 }}>
              {warehouseSections.map(w => {
                const matched = w.lines.filter(l => isLineAccounted(l, w.name, exceptionCategories)).length
                const pct = w.lines.length ? Math.round((matched / w.lines.length) * 100) : 0
                const issues = w.lines.filter(l => l.status !== 'ok').length
                const [fg, bg] = w.loaded ? band(pct) : ['#94a3b8', '#f1f5f9']
                return (
                  <div key={w.name} style={{ flex: 1, border: `1px solid ${C.line}`, borderTop: `6px solid ${WH[w.name] || C.brand}`, borderRadius: 10, padding: '14px 16px', background: '#fff' }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: WH[w.name] || C.ink, letterSpacing: '0.06em' }}>{w.name}</div>
                    {w.loaded ? (
                      <>
                        <div style={{ margin: '8px 0 6px' }}><Pill fg={fg} bg={bg}>{pct}% reconciled</Pill></div>
                        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
                          Main {w.shipped} · Off site {w.reported}<br />
                          <span style={{ color: issues ? '#b91c1c' : C.green, fontWeight: 700 }}>{issues ? `${issues} exception${issues === 1 ? '' : 's'}` : 'No exceptions'}</span>
                        </div>
                      </>
                    ) : <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 10, fontStyle: 'italic' }}>Not loaded</div>}
                  </div>
                )
              })}
            </div>

            {/* executive summary */}
            <H2>Executive Summary</H2>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32, fontSize: 14 }}>
              <thead>
                <tr style={{ background: C.green, color: '#fff' }}>
                  {['Warehouse', 'Main WHS Total', 'Off Site Qty', 'Variance', 'Total Accuracy', 'Exceptions'].map(h => (
                    <th key={h} style={{ padding: '9px 14px', textAlign: h === 'Warehouse' ? 'left' : 'right', fontWeight: 700, fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {warehouseSections.map((w, i) => {
                  const v = w.reported - w.shipped
                  const matched = w.lines.filter(l => isLineAccounted(l, w.name, exceptionCategories)).length
                  const pct = w.lines.length ? Math.round((matched / w.lines.length) * 100) : 0
                  const issues = w.lines.filter(l => l.status !== 'ok').length
                  if (!w.loaded) {
                    return (
                      <tr key={w.name} style={{ background: i % 2 === 0 ? '#f9fafb' : '#fff', borderBottom: '1px solid #e5e7eb', color: '#9ca3af' }}>
                        <td style={{ padding: '9px 14px', fontWeight: 700 }}>{w.name}</td>
                        <td colSpan={5} style={{ padding: '9px 14px', textAlign: 'center', fontStyle: 'italic' }}>Not loaded — no report uploaded for this warehouse</td>
                      </tr>
                    )
                  }
                  return (
                    <tr key={w.name} style={{ background: i % 2 === 0 ? '#f9fafb' : '#fff', borderBottom: '1px solid #e5e7eb' }}>
                      <td style={{ padding: '9px 14px', fontWeight: 800, color: WH[w.name] }}>{w.name}</td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: 'monospace' }}>{w.shipped}</td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: 'monospace' }}>{w.reported}</td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: 'monospace', color: v === 0 ? '#374151' : v > 0 ? '#b45309' : '#dc2626', fontWeight: 600 }}>
                        {v === 0 ? '—' : (v > 0 ? '+' : '') + v}
                      </td>
                      <td style={{ padding: '9px 14px', textAlign: 'right' }}><Pill fg={band(pct)[0]} bg={band(pct)[1]}>{pct}%</Pill></td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', color: issues > 0 ? '#dc2626' : '#15803d', fontWeight: 600 }}>{issues}</td>
                    </tr>
                  )
                })}
                {/* totals row */}
                <tr style={{ background: C.dark, color: '#fff', fontWeight: 700 }}>
                  <td style={{ padding: '9px 14px' }}>Total</td>
                  <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: 'monospace' }}>{eabShipped + wsiShipped + ws2Shipped}</td>
                  <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: 'monospace' }}>{eabReported + wsiReported + ws2Reported}</td>
                  <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: 'monospace' }}>
                    {(() => { const v = (eabReported+wsiReported+ws2Reported)-(eabShipped+wsiShipped+ws2Shipped); return v===0?'—':(v>0?'+':'')+v })()}
                  </td>
                  <td style={{ padding: '9px 14px', textAlign: 'right' }}>{overallPct}%</td>
                  <td style={{ padding: '9px 14px', textAlign: 'right' }}>{allIssues.length}</td>
                </tr>
              </tbody>
            </table>

            {/* exceptions */}
            {allIssues.length > 0 && (
              <>
                <H2 color="#dc2626">Exceptions Requiring Attention</H2>
                <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32, fontSize: 14 }}>
                  <thead>
                    <tr style={{ background: '#dc2626', color: '#fff' }}>
                      {['Warehouse', 'Part Number', 'Main Warehouse Count', 'Off Site Count', 'Variance', 'Status', 'Reason'].map(h => (
                        <th key={h} style={{ padding: '9px 14px', textAlign: h === 'Main Warehouse Count' || h === 'Off Site Count' || h === 'Variance' ? 'right' : 'left', fontWeight: 700, fontSize: 12 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {allIssues.map((issue, i) => {
                      const wh = eabRec.includes(issue) ? 'EAB' : wsiRec.includes(issue) ? 'WSI' : 'WS2'
                      const category = exceptionCategories[`${wh}-${issue.part}`] || ''
                      const note = exceptionReasons[`${wh}-${issue.part}`] || ''
                      const reasonDisplay = category && note ? `${category} — ${note}` : (category || note || '—')
                      return (
                        <tr key={i} style={{ background: i % 2 === 0 ? '#fef2f2' : '#fff', borderBottom: '1px solid #fecaca' }}>
                          <td style={{ padding: '9px 14px', fontWeight: 800, color: WH[wh] }}>{wh}</td>
                          <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontWeight: 700 }}>{issue.part}</td>
                          <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: 'monospace' }}>{issue.shippedQty}</td>
                          <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: 'monospace' }}>{issue.reportedQty}</td>
                          <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: issue.variance > 0 ? '#b45309' : '#dc2626' }}>
                            {(issue.variance > 0 ? '+' : '') + issue.variance}
                          </td>
                          <td style={{ padding: '9px 14px' }}>
                            <Pill fg={(STATUS[issue.status] || STATUS.short)[0]} bg={(STATUS[issue.status] || STATUS.short)[1]}>{statusLabel[issue.status] || issue.status}</Pill>
                          </td>
                          <td style={{ padding: '9px 14px', color: '#374151' }}>{reasonDisplay}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </>
            )}

            {allIssues.length === 0 && (
              <div style={{ textAlign: 'center', padding: '24px', background: C.greenBg, border: '1px solid #86efac', borderRadius: 8, marginBottom: 32, color: '#15803d', fontWeight: 700, fontSize: 15 }}>
                ✓ All pallets fully reconciled across all three warehouses.
              </div>
            )}

            {/* per-warehouse detail */}
            {warehouseSections.filter(w => w.loaded).map(w => (
              <div key={w.name} style={{ marginBottom: 32, pageBreakInside: 'avoid' }}>
                <H2 color={WH[w.name]}>{w.name} — Full Detail</H2>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: WH[w.name] || C.dark, color: '#fff' }}>
                      {['Part Number', 'Main Warehouse Count', 'Off Site Count', 'Variance', 'Status'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Part Number' || h === 'Status' ? 'left' : 'right', fontWeight: 700, fontSize: 12 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {w.lines.map((line, i) => (
                      <tr key={line.part} style={{ background: line.status !== 'ok' ? (STATUS[line.status] || STATUS.short)[1] : i % 2 === 0 ? '#f8fafc' : '#fff', borderBottom: '1px solid #e5e7eb' }}>
                        <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontWeight: 600 }}>{line.part}</td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', fontFamily: 'monospace' }}>{line.shippedQty}</td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', fontFamily: 'monospace' }}>{line.reportedQty}</td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: line.variance !== 0 ? 700 : 400, color: line.variance > 0 ? '#b45309' : line.variance < 0 ? '#dc2626' : '#9ca3af' }}>
                          {line.variance === 0 ? '—' : (line.variance > 0 ? '+' : '') + line.variance}
                        </td>
                        <td style={{ padding: '7px 12px' }}>
                          {line.status === 'ok'
                            ? <span style={{ color: C.green, fontWeight: 700 }}>✓ {statusLabel.ok}</span>
                            : <Pill fg={'#fff'} bg={(STATUS[line.status] || STATUS.short)[0]}>{statusLabel[line.status] || line.status}</Pill>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

            {/* footer */}
            <div style={{ borderTop: `3px solid ${C.brand}`, paddingTop: 14, marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#9ca3af' }}>
              <span>{brandName ? brandName + " · " : ""}Off Site Pallet Audit</span>
              <span>Generated {date} · Confidential</span>
            </div>

          </div>
        </div>
      </div>

      {/* print-only styles */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #print-body, #print-body * { visibility: visible; }
          #print-body { position: static; width: 100%; padding: 0; margin: 0; font-size: 12px; }
          .no-print { display: none !important; }
          .print-overlay { display: block !important; position: static !important; background: none !important; padding: 0 !important; }
          .print-overlay > div { position: static !important; max-width: none !important; border-radius: 0 !important; }
          @page { margin: 0.75in; size: letter; }
        }
      `}</style>
    </>
  )
}
