'use strict';
const PDFDocument = require('pdfkit');
const path        = require('path');
const fs          = require('fs');

// ─── Constants ────────────────────────────────────────────────────────────────
const PANEL_KWH_DAY = 2.725;
const PANEL_M2      = 2.584;    // 2279 × 1134 mm per panel → m²

// Colores del diseño SOLHARM
const GREEN      = '#2d6b1f';   // verde oscuro: barra ANÁLISIS, OBJETIVO, PROPUESTA, COTIZACIÓN, PRECIO, PAGOS, labels ANUAL/MENSUAL/DIARIO
const GREEN2     = '#4a8c2a';   // verde medio: sub-header "Sistema:"
const G_LIGHT    = '#b8d89b';   // verde claro: fila COSTO TOTAL DE CONTADO
const YELLOW     = '#FFFF00';   // amarillo brillante: headers CONSUMO DE KWH / CONSUMO PROMEDIO
const BORDER     = '#aaaaaa';   // gris: bordes de celdas

// Page geometry (US Letter)
const PW = 612, PH = 792;
const ML = 30, MR = 30, MT = 28;
const CW = PW - ML - MR;  // 552 pt

const RH      = 13;   // standard row height
const HDR     = 14;   // section header height
const HDR_BIG = 16;   // main title / COTIZACIÓN GENERAL height

// ─── Drawing primitives ───────────────────────────────────────────────────────

function fillCell(doc, x, y, w, h, bg) {
  if (bg && bg !== 'white' && bg !== '#ffffff') {
    doc.rect(x, y, w, h).fillColor(bg).fill();
  }
  doc.rect(x, y, w, h).strokeColor(BORDER).lineWidth(0.5).stroke();
}

/** Single-line cell — text vertically centred. */
function cell(doc, x, y, w, h, text, opts = {}) {
  const { bg = 'white', color = '#000', bold = false,
          sz = 8, align = 'left' } = opts;
  fillCell(doc, x, y, w, h, bg);
  if (text !== null && text !== undefined && String(text) !== '') {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(sz).fillColor(color);
    const lh = sz * 1.15;
    doc.text(String(text), x + 3, y + (h - lh) / 2 + 1,
      { width: w - 6, align, lineBreak: false });
  }
}

/** Multi-line cell — text starts at top + 3 pt. */
function multiCell(doc, x, y, w, h, text, opts = {}) {
  const { bg = 'white', color = '#333', bold = false, sz = 7.5 } = opts;
  fillCell(doc, x, y, w, h, bg);
  if (text) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(sz).fillColor(color);
    doc.text(String(text), x + 3, y + 3, { width: w - 6 });
  }
}

/** Coloured header bar (green or yellow). */
function hdr(doc, x, y, w, h, text, opts = {}) {
  const { sz = 9, bg = GREEN, color = 'white', align = 'center' } = opts;
  doc.rect(x, y, w, h).fillColor(bg).fill();
  doc.rect(x, y, w, h).strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.font('Helvetica-Bold').fontSize(sz).fillColor(color);
  doc.text(text, x + 3, y + (h - sz * 1.15) / 2 + 1,
    { width: w - 6, align, lineBreak: false });
}

// ─── Currency ─────────────────────────────────────────────────────────────────
function mxn(n) {
  return `$ ${Number(n).toLocaleString('es-MX',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── Auto-height row (returns h used) ─────────────────────────────────────────
function autoRow(doc, x, y, w, text, opts = {}) {
  const { sz = 7.5, bold = false, bg = 'white', color = '#000', align = 'left' } = opts;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(sz);
  const th = doc.heightOfString(text || '', { width: w - 6 });
  const h  = Math.max(RH, th + 4);
  fillCell(doc, x, y, w, h, bg);
  if (text) {
    doc.fillColor(color);
    const ty = th <= sz * 1.2 ? y + (h - sz * 1.15) / 2 + 1 : y + 3;
    doc.text(text, x + 3, ty, { width: w - 6, align });
  }
  return h;
}

// ─── PDF builder ──────────────────────────────────────────────────────────────
function buildPdf(doc, {
  nombre, direccion, tarifa,
  periodos, promedio_kwh, tipo,
  panels, price
}) {
  // ── Derived values ────────────────────────────────────────────────────────
  const totalKwh  = periodos.reduce((s, p) => s + Number(p.kwh), 0);
  const annualKwh = tipo === 'bimestral'
    ? totalKwh * (6 / periodos.length)
    : totalKwh * (12 / periodos.length);

  const monthlyKwh = annualKwh / 12;
  const dailyKwh   = annualKwh / 365;

  const annualProd  = panels * PANEL_KWH_DAY * 365;
  const monthlyProd = annualProd / 12;
  const dailyProd   = panels * PANEL_KWH_DAY;

  const enganche    = Math.round(price * 0.50);
  const instalacion = Math.round(price * 0.45);
  const medidor     = Math.round(price * 0.05);

  let y = MT;

  // ══════════════════════════════════════════════════════════════════════════
  // HEADER — client info (left) + SOLHARM logo (right)
  // ══════════════════════════════════════════════════════════════════════════
  const infoW = 255, lblW = 68, valW = infoW - lblW;

  [['Nombre:', nombre || ''],
   ['Dirección:', direccion || ''],
   ['Tarifa:', tarifa || '']].forEach(([lbl, val]) => {
    doc.font('Helvetica').fontSize(8);
    const valH = doc.heightOfString(String(val), { width: valW - 6 });
    const rh = Math.max(RH, valH + 4);
    // Label (always short — vertically centred)
    fillCell(doc, ML, y, lblW, rh, 'white');
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000');
    doc.text(String(lbl), ML + 3, y + (rh - 8 * 1.15) / 2 + 1,
      { width: lblW - 6, lineBreak: false });
    // Value (may wrap — top-aligned when multi-line)
    fillCell(doc, ML + lblW, y, valW, rh, 'white');
    doc.font('Helvetica').fontSize(8).fillColor('#000');
    const valTy = valH <= 8 * 1.2 ? y + (rh - 8 * 1.15) / 2 + 1 : y + 3;
    doc.text(String(val), ML + lblW + 3, valTy, { width: valW - 6 });
    y += rh;
  });
  const afterInfo = y;

  // Logo — imagen PNG con fondo transparente (incluye "SÓLO POR TI")
  const logoX    = ML + infoW + 10;
  const logoAreaW = PW - MR - logoX;   // ancho disponible ≈ 287 pt
  const logoFile = process.env.SOLHARM_LOGO_PATH
    ? path.resolve(process.env.SOLHARM_LOGO_PATH)
    : path.join(__dirname, 'logo_solharm_recortado.png');

  if (fs.existsSync(logoFile)) {
    // fit mantiene la proporción original; align:'right' lo pega al borde derecho
    doc.image(logoFile, logoX, MT, { fit: [logoAreaW, 40], align: 'right', valign: 'top' });
  }

  y = afterInfo + 5;

  // ══════════════════════════════════════════════════════════════════════════
  // MAIN TITLE  (verde oscuro, texto blanco — diseño SOLHARM)
  // ══════════════════════════════════════════════════════════════════════════
  const periodLabel = tipo === 'bimestral' ? `ULTIMOS ${periodos.length} BIMESTRES` : 'ULTIMOS 12 MESES';
  hdr(doc, ML, y, CW, HDR_BIG,
    `ANÁLISIS DE LA FACTURACIÓN DE ENERGÍA - ${periodLabel}`,
    { sz: 10, bg: GREEN, color: 'white' });
  y += HDR_BIG + 3;

  // ══════════════════════════════════════════════════════════════════════════
  // ANALYSIS SECTION
  // ══════════════════════════════════════════════════════════════════════════
  const leftW  = 188;
  const rightX = ML + leftW + 4;
  const rightW = CW - leftW - 4;   // ≈ 360

  // ── Left sub-column widths ────────────────────────────────────────────────
  //   col1 = kWh values (right-aligned numbers, narrow)
  //   col2 = CONSUMO PROMEDIO (also narrow)
  //   We add the period name to col1 via the format "Ene-Feb  984"
  const col1 = 110;   // period label + kWh number
  const col2 = leftW - col1;  // 78

  const blockStartY = y;
  let lY = y, rY = y;

  // ── Column headers (yellow, 2-line — matches reference) ──────────────────
  const LCH = 22;   // left-column header height (taller for 2-line text)
  for (const [x, w, txt] of [
    [ML,        col1, 'CONSUMO\nDE KWH'],
    [ML + col1, col2, 'CONSUMO\nPROMEDIO'],
  ]) {
    doc.rect(x, lY, w, LCH).fillColor(YELLOW).fill();
    doc.rect(x, lY, w, LCH).strokeColor('#000').lineWidth(1.5).stroke();
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000');
    doc.text(txt, x + 3, lY + 4, { width: w - 6, align: 'center' });
  }
  lY += LCH;

  // ── CONSUMO PROMEDIO column: alternating label / value rows ─────────────
  const promedioRows = [
    { label: 'ANUAL' },
    { value: Math.round(annualKwh).toLocaleString('es-MX') },
    { label: 'MENSUAL' },
    { value: monthlyKwh.toFixed(1) },
    { label: 'DIARIO' },
    { value: dailyKwh.toFixed(2) },
    { label: 'PRECIO ESTIMADO' },
    { value: '2.6267' },
    { label: 'PRECIO ANUAL' },
    { value: mxn(annualKwh * 2.6267) },
  ];
  while (promedioRows.length < periodos.length) promedioRows.push({ value: '' });

  // ── Period rows ───────────────────────────────────────────────────────────
  const totalRows = Math.max(promedioRows.length, periodos.length);
  for (let i = 0; i < totalRows; i++) {
    const p = periodos[i];
    fillCell(doc, ML, lY, col1, RH, 'white');
    if (p) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
      doc.text(Number(p.kwh).toLocaleString('es-MX'), ML + 3, lY + (RH - 9 * 1.15) / 2 + 1,
        { width: col1 - 6, align: 'right', lineBreak: false });
    }

    const pd = promedioRows[i] || { value: '' };
    if (pd.label) {
      cell(doc, ML + col1, lY, col2, RH, pd.label, { bold: true, bg: '#e0e0e0', color: '#000', sz: 7.5, align: 'center' });
    } else {
      cell(doc, ML + col1, lY, col2, RH, pd.value || '', { align: 'right', sz: 8 });
    }
    lY += RH;
  }

  // ── Right: OBJETIVO ────────────────────────────────────────────────────────
  hdr(doc, rightX, rY, rightW, HDR, 'OBJETIVO');
  rY += HDR;
  cell(doc, rightX, rY, rightW, RH, 'Generación de Energía:', { bold: true, sz: 8 });
  rY += RH;

  const lbl1 = 65, val1 = 85, unit1 = rightW - lbl1 - val1;
  [['Anual:',   annualProd.toFixed(2),  'KWH/AÑO'],
   ['Mensual:', monthlyProd.toFixed(1), 'KWH/MES'],
   ['Diaria:',  dailyProd.toFixed(2),   'KWH/DIA']].forEach(([l, v, u]) => {
    cell(doc, rightX,              rY, lbl1,  RH, l, { bold: true, sz: 8 });
    cell(doc, rightX + lbl1,       rY, val1,  RH, v, { bold: true, align: 'right', sz: 8 });
    cell(doc, rightX + lbl1 + val1, rY, unit1, RH, u, { color: '#444', sz: 8 });
    rY += RH;
  });

  rY += 3;

  // ── Right: PROPUESTA TÉCNICA ───────────────────────────────────────────────
  hdr(doc, rightX, rY, rightW, HDR, 'PROPUESTA TÉCNICA');
  rY += HDR;
  hdr(doc, rightX, rY, rightW, RH, 'Sistema:', { sz: 8, bg: GREEN2 });
  rY += RH;

  const numW = 26, descW = rightW - numW;

  const propRows = [
    [String(panels),
     'Suministro e instalación de Paneles Solares Monocristalino. ' +
     '12 Años de Garantía en Producto. 25 Años de Garantía del fabricante al 85% del pot. ' +
     'Máx. Real según prueba estándar. Potencia Máx (Wp): 585. Tensión máx. Sist. (V): ' +
     '1500. Dimensiones: 2279* 1134* 35. Peso (kg): 28.6'],
    ['1',
     'Suministro e instalación de inversor Growatt 10 Años de Garantía en Producto. ' +
     'Potencia Nominal Equivalente.'],
    ['1',
     'Suministro e instalación del sistema con estructura de aluminio anodizado marca ' +
     'certificada, para instalación sobre techo de concreto o lamina. Mano de Obra. ' +
     'Gestión completa ante CFE. Instalación de Monitoreo.'],
  ];

  propRows.forEach(([num, desc]) => {
    doc.font('Helvetica').fontSize(7.5);
    const th   = doc.heightOfString(desc, { width: descW - 6 });
    const rowH = Math.max(RH * 2, th + 6);
    fillCell(doc, rightX, rY, numW, rowH, 'white');
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000');
    doc.text(num, rightX, rY + (rowH - 12) / 2,
      { width: numW, align: 'center', lineBreak: false });
    multiCell(doc, rightX + numW, rY, descW, rowH, desc, { sz: 7.5 });
    rY += rowH;
  });

  const area = Math.round(panels * PANEL_M2);
  cell(doc, rightX,            rY, numW * 2,       RH, 'ÁREA:', { bold: true, sz: 7.5 });
  cell(doc, rightX + numW * 2, rY, descW - numW,   RH, `${area} M2`, { bold: true, sz: 7.5 });
  rY += RH;

  // Thick outer borders around consumo block (left) and objetivo/propuesta block (right)
  doc.rect(ML, blockStartY, leftW, lY - blockStartY).strokeColor('#000').lineWidth(1.5).stroke();
  doc.rect(rightX, blockStartY, rightW, rY - blockStartY).strokeColor('#000').lineWidth(1.5).stroke();

  y = Math.max(lY, rY) + 8;

  // ══════════════════════════════════════════════════════════════════════════
  // COTIZACIÓN GENERAL
  // ══════════════════════════════════════════════════════════════════════════
  hdr(doc, ML, y, CW, HDR_BIG, 'COTIZACIÓN GENERAL', { sz: 10 });
  y += HDR_BIG + 3;

  const half    = Math.floor(CW / 2) - 2;   // 274
  const halfRX  = ML + half + 4;
  const cotLblW = Math.floor(half * 0.44);
  const cotValW = half - cotLblW;

  let cY1 = y, cY2 = y;

  // Left: cotización details — labels bold, white bg (matches reference)
  [['COTIZACION:', 'Pesos Mexicanos'],
   ['TIEMPO DE ENTREGA:', '10 a 20 Dias'],
   ['LUGAR DE ENTREGA:', 'Sus Instalaciones'],
   ['FORMA DE PAGO:', 'En Pesos Mexicanos, pagados al Tipo de Cambio del Día según el DOF.'],
   ['TIPO DE CAMBIO USD', '$   19.50']].forEach(([lbl, val]) => {
    doc.font('Helvetica').fontSize(7.5);
    const th = doc.heightOfString(val, { width: cotValW - 6 });
    const rh = Math.max(RH, th + 4);
    cell(doc, ML, cY1, cotLblW, rh, lbl, { bold: true, sz: 7.5 });
    fillCell(doc, ML + cotLblW, cY1, cotValW, rh, 'white');
    doc.font('Helvetica').fontSize(7.5).fillColor('#000');
    const ty = th <= 7.5 * 1.2 ? cY1 + (rh - th) / 2 : cY1 + 3;
    doc.text(val, ML + cotLblW + 3, ty, { width: cotValW - 6 });
    cY1 += rh;
  });

  // Right: validez + subministro
  doc.font('Helvetica-Bold').fontSize(7.5);
  const validezH = Math.max(RH, doc.heightOfString('VALIDEZ DE\nCOTIZACIÓN:', { width: cotLblW - 6 }) + 4);
  fillCell(doc, halfRX, cY2, cotLblW, validezH, 'white');
  doc.fillColor('#000').text('VALIDEZ DE\nCOTIZACIÓN:', halfRX + 3, cY2 + 3, { width: cotLblW - 6 });
  cell(doc, halfRX + cotLblW, cY2, cotValW, validezH, '7 DIAS', { bold: true, sz: 7.5 });
  cY2 += validezH;

  const subTxt = 'En caso de no haber existencia de capacidad o marca especificada en esta ' +
    'cotización, Se considerarán equipos y capacidades equivalentes, asegurando el mismo ' +
    'numero de WATTS instalados y marcas de equipos equivalentes.';
  doc.font('Helvetica').fontSize(7);
  const subH = Math.max(RH * 4,
    doc.heightOfString(subTxt, { width: cotValW - 6 }) + 6);
  fillCell(doc, halfRX, cY2, cotLblW, subH, 'white');
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000');
  doc.text('SUBMINISTRO\nDE EQUIPOS:', halfRX + 3, cY2 + 3, { width: cotLblW - 6 });
  multiCell(doc, halfRX + cotLblW, cY2, cotValW, subH, subTxt, { sz: 7 });
  cY2 += subH;

  y = Math.max(cY1, cY2) + 4;

  // ══════════════════════════════════════════════════════════════════════════
  // PRECIO  +  PAGOS
  // ══════════════════════════════════════════════════════════════════════════
  hdr(doc, ML,     y, half,       13, 'PRECIO');
  hdr(doc, halfRX, y, CW - half - 4, 13, 'PAGOS');
  y += 13;

  // PRECIO table
  const pLbW = Math.floor(half * 0.62);
  const pVlW = half - pLbW;
  let pY = y;

  [['COSTO PROYECTO PANELES', mxn(price)],
   ['DIFERENCIA INVERSOR', ''],
   ['IVA', '$     -']].forEach(([lbl, val]) => {
    cell(doc, ML,        pY, pLbW, RH, lbl, { sz: 7.5 });
    cell(doc, ML + pLbW, pY, pVlW, RH, val, { bold: !!(val), align: 'right', sz: 7.5 });
    pY += RH;
  });
  cell(doc, ML,        pY, pLbW, RH, 'COSTO TOTAL DE CONTADO', { bold: true, bg: G_LIGHT, sz: 7.5 });
  cell(doc, ML + pLbW, pY, pVlW, RH, mxn(price),               { bold: true, align: 'right', bg: G_LIGHT, sz: 7.5 });
  pY += RH;

  // PAGOS table
  const pagosW   = CW - half - 4;
  const pagosAmt = Math.floor(pagosW * 0.32);
  const pagosD   = pagosW - pagosAmt;
  let gY = y;

  [[mxn(enganche),    'ENGANCHE 50%'],
   [mxn(instalacion), 'AL CONCLUIR LA INSTALACIÓN 45%'],
   [mxn(medidor),     'AL INICIAR LA PRODUCCIÓN DE ENERGIA 5%']].forEach(([amt, desc]) => {
    doc.font('Helvetica').fontSize(7.5);
    const th = doc.heightOfString(desc, { width: pagosD - 6 });
    const rh = Math.max(RH, th + 4);
    cell(doc, halfRX,            gY, pagosAmt, rh, amt,  { bold: true, align: 'right', sz: 7.5 });
    fillCell(doc, halfRX + pagosAmt, gY, pagosD, rh, 'white');
    doc.font('Helvetica').fontSize(7.5).fillColor('#000');
    doc.text(desc, halfRX + pagosAmt + 3,
      th <= 7.5 * 1.2 ? gY + (rh - th) / 2 : gY + 3,
      { width: pagosD - 6 });
    gY += rh;
  });

  y = Math.max(pY, gY) + 4;

  // ══════════════════════════════════════════════════════════════════════════
  // FOOTER — inside a bordered full-width row (matches reference)
  // ══════════════════════════════════════════════════════════════════════════
  const footerTxt = 'Sin más por el momento y esperando vernos favorecidos con su desición ' +
    'quedo a sus apreciables órdenes.';
  doc.font('Helvetica').fontSize(8);
  const ftH = Math.max(RH, doc.heightOfString(footerTxt, { width: CW - 10 }) + 6);
  fillCell(doc, ML, y, CW, ftH, 'white');
  doc.font('Helvetica').fontSize(8).fillColor('#333');
  doc.text(footerTxt, ML + 5, y + 4, { width: CW - 10 });
  y += ftH;

  // Signature row — right half has underline + name
  const sigRowH = 30;
  fillCell(doc, ML,      y, half + 4, sigRowH, 'white');
  fillCell(doc, halfRX,  y, CW - half - 4, sigRowH, 'white');
  const sigLineY = y + sigRowH - 14;
  doc.moveTo(halfRX + 10, sigLineY)
     .lineTo(ML + CW - MR + ML - 10, sigLineY)   // near right edge
     .strokeColor('#000').lineWidth(0.6).stroke();
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
  doc.text('HECTOR REYES', halfRX + 10, sigLineY + 3,
    { width: CW - half - 20, align: 'center', lineBreak: false });
}

// ─── Public API ───────────────────────────────────────────────────────────────
async function generateQuotePdf(data) {
  return new Promise((resolve, reject) => {
    const doc     = new PDFDocument({ size: 'LETTER', margin: 0, autoFirstPage: true });
    const buffers = [];
    doc.on('data',  b  => buffers.push(b));
    doc.on('end',   () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
    try { buildPdf(doc, data); } catch (e) { reject(e); }
    doc.end();
  });
}

module.exports = { generateQuotePdf };
