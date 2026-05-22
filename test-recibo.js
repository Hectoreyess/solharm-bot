require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PANEL_KWH_DAY = 2.725;
const PACKAGES = [
  { panels: 6,  price: 48300 },
  { panels: 8,  price: 60800 },
  { panels: 10, price: 73900 },
  { panels: 12, price: 84800 },
  { panels: 14, price: 98700 },
  { panels: 16, price: 111500 },
  { panels: 18, price: 122100 },
  { panels: 20, price: 132700 },
];

function mxn(n) {
  return `$${n.toLocaleString('es-MX')} MXN`;
}

function recommendPackage(avgKwh, tipo) {
  const dailyKwh = tipo === 'bimestral'
    ? (avgKwh * 6) / 365
    : avgKwh / 30.44;
  const rawPanels = dailyKwh / PANEL_KWH_DAY;
  const pkg = PACKAGES.find(p => p.panels > rawPanels) || PACKAGES[PACKAGES.length - 1];
  return { ...pkg, rawPanels, dailyKwh };
}

function mediaType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
  return map[ext] || 'image/jpeg';
}

function imageBlock(filePath) {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType(filePath),
      data: fs.readFileSync(filePath).toString('base64'),
    },
  };
}

const BILL_PROMPT =
  'REGLAS PARA DETECTAR EL TIPO:\n' +
  '- Bimestral (tipo="bimestral"): periodos con rangos como "Ene-Feb", "Mar-Abr", "May-Jun", etc.\n' +
  '  O bien, periodos salteados de 2 en 2 meses (Ene, Mar, May, Jul, Sep, Nov). CFE a veces solo muestra el primer mes del bimestre.\n' +
  '- Mensual (tipo="mensual"): periodos consecutivos (Ene, Feb, Mar, Abr...) o el recibo dice "mensual".\n' +
  '- Si ves 6 periodos que cubren un año saltando 2 meses, es SIEMPRE bimestral.\n\n' +
  'EXTRACCIÓN:\n' +
  '- Extrae el kWh de CADA periodo visible en el historial.\n' +
  '- Si algún número es dudoso, usa tu mejor estimación; NO devuelvas error por incertidumbre menor.\n' +
  '- Solo devuelve error si la imagen es ilegible, no es un recibo de CFE, o es imposible extraer cualquier kWh.\n\n' +
  'Responde ÚNICAMENTE con JSON válido:\n' +
  '{\n' +
  '  "tipo": "bimestral" | "mensual",\n' +
  '  "periodos": [ { "periodo": "ej: Ene-Feb 2024", "kwh": número } ],\n' +
  '  "promedio_kwh": número\n' +
  '}\n\n' +
  'Solo si es imposible extraer datos:\n' +
  '{ "tipo": "error", "mensaje": "razón concreta" }';

async function analyzeImages(filePaths) {
  const isTwoSided = filePaths.length === 2;

  const imageBlocks = filePaths.map(imageBlock);

  const introText = isTwoSided
    ? 'Aquí tienes el FRENTE y el REVERSO del mismo recibo de CFE. Analiza ambas imágenes juntas. El historial de consumo puede estar en cualquiera de las dos caras.\n\n'
    : 'Analiza este recibo de luz de CFE.\n\n';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: 'Eres un experto en facturas de electricidad de CFE México. Extraes datos de consumo eléctrico y los devuelves en JSON válido.',
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          ...imageBlocks,
          { type: 'text', text: introText + BILL_PROMPT },
        ],
      },
    ],
  });

  const raw   = response.content[0].text.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude no devolvió JSON válido:\n' + raw);
  return JSON.parse(match[0]);
}

function printDivider(char = '─', len = 50) {
  console.log(char.repeat(len));
}

function printReport(data, label) {
  const tipoLabel  = data.tipo === 'bimestral' ? 'Bimestral' : 'Mensual';
  const days       = data.tipo === 'bimestral' ? 61 : 30.44;
  const pkg        = recommendPackage(data.promedio_kwh, data.tipo);
  const produccion = Math.round(pkg.panels * PANEL_KWH_DAY * days);
  const adelanto   = Math.round(pkg.price * 0.50);
  const instalacion = Math.round(pkg.price * 0.45);
  const medidor    = Math.round(pkg.price * 0.05);

  printDivider('═');
  console.log('  SOLHARM — Análisis de Recibo CFE');
  printDivider('═');
  console.log(`  Archivo : ${label}`);
  console.log(`  Tipo    : ${tipoLabel}`);
  printDivider();

  console.log('\n  HISTORIAL DE CONSUMO\n');
  data.periodos.forEach(p => {
    const bar = '█'.repeat(Math.min(Math.round(p.kwh / 50), 48));
    console.log(`  ${String(p.periodo).padEnd(18)} ${String(p.kwh).padStart(6)} kWh  ${bar}`);
  });

  printDivider();
  console.log(`  ${'Promedio por ' + (data.tipo === 'bimestral' ? 'bimestre' : 'mes')}`.padEnd(22) +
    `${Math.round(data.promedio_kwh).toLocaleString('es-MX').padStart(6)} kWh`);
  console.log(`  ${'Consumo diario promedio'}`.padEnd(22) +
    `${pkg.dailyKwh.toFixed(2).padStart(6)} kWh/día`);
  console.log(`  ${'Paneles mínimos (cálculo)'}`.padEnd(22) +
    `${pkg.rawPanels.toFixed(2).padStart(6)} paneles`);

  printDivider('═');
  console.log('  ☀  RECOMENDACIÓN SOLHARM');
  printDivider('═');
  console.log(`  Paquete   : ${pkg.panels} paneles solares`);
  console.log(`  Producción: ~${produccion.toLocaleString('es-MX')} kWh por ${data.tipo === 'bimestral' ? 'bimestre' : 'mes'}`);
  console.log(`  Precio    : ${mxn(pkg.price)}`);

  printDivider();
  console.log('  ESQUEMA DE PAGO\n');
  console.log(`  50% adelanto al confirmar   ${mxn(adelanto)}`);
  console.log(`  45% al instalar paneles     ${mxn(instalacion)}`);
  console.log(`   5% al cambio de medidor    ${mxn(medidor)}`);

  printDivider();
  console.log('  TODOS LOS PAQUETES\n');
  PACKAGES.forEach(p => {
    const marker = p.panels === pkg.panels ? ' ◄ RECOMENDADO' : '';
    console.log(`  ${String(p.panels).padStart(2)} paneles  ${mxn(p.price)}${marker}`);
  });
  printDivider('═');
  console.log();
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('\n  Uso:');
    console.error('    node test-recibo.js <frente.jpg>');
    console.error('    node test-recibo.js <frente.jpg> <reverso.jpg>\n');
    process.exit(1);
  }

  const paths = args.map(a => path.resolve(a));
  paths.forEach(p => {
    if (!fs.existsSync(p)) {
      console.error(`\n  ❌ Archivo no encontrado: ${p}\n`);
      process.exit(1);
    }
  });

  const label = paths.map(p => path.basename(p)).join(' + ');
  console.log(`\n  Analizando ${label}...`);

  try {
    const data = await analyzeImages(paths);

    if (data.tipo === 'error') {
      console.error(`\n  ❌ No se pudo leer el recibo: ${data.mensaje}\n`);
      process.exit(1);
    }

    printReport(data, label);
  } catch (err) {
    console.error('\n  ❌ Error:', err.message, '\n');
    process.exit(1);
  }
}

main();
