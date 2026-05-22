require('dotenv').config();
const readline = require('readline');
const Anthropic = require('@anthropic-ai/sdk');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const crypto   = require('crypto');
const { generateQuotePdf } = require('./quote');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Catálogo ─────────────────────────────────────────────────────────────────

const PANEL_KWH_DAY = 2.725;
const PACKAGES = [
  { panels: 6,  price: 48300  },
  { panels: 8,  price: 60800  },
  { panels: 10, price: 73900  },
  { panels: 12, price: 84800  },
  { panels: 14, price: 98700  },
  { panels: 16, price: 111500 },
  { panels: 18, price: 122100 },
  { panels: 20, price: 132700 },
];

function mxn(n) { return `$${n.toLocaleString('es-MX')} MXN`; }

function recommendPackage(avgKwh, tipo) {
  const dailyKwh = tipo === 'bimestral' ? (avgKwh * 6) / 365 : avgKwh / 30.44;
  const rawPanels = dailyKwh / PANEL_KWH_DAY;
  const pkg = PACKAGES.find(p => p.panels > rawPanels) || PACKAGES[PACKAGES.length - 1];
  return { ...pkg, rawPanels, dailyKwh };
}

// ─── Análisis de imágenes ─────────────────────────────────────────────────────

function resolveImagePath(input) {
  const trimmed = input.trim().replace(/^['"]|['"]$/g, '');
  const resolved = trimmed.startsWith('~')
    ? path.join(os.homedir(), trimmed.slice(1))
    : path.resolve(trimmed);
  const ext = path.extname(resolved).toLowerCase();
  const validExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  return validExts.includes(ext) && fs.existsSync(resolved) ? resolved : null;
}

function imageBlock(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: types[ext] || 'image/jpeg',
      data: fs.readFileSync(filePath).toString('base64'),
    },
  };
}

const BILL_PROMPT =
  'REGLAS PARA DETECTAR EL TIPO:\n' +
  '- Bimestral (tipo="bimestral"): periodos con rangos como "Ene-Feb", "Mar-Abr", etc.\n' +
  '  O periodos salteados de 2 en 2 meses (Ene, Mar, May, Jul, Sep, Nov). CFE a veces solo muestra el primer mes.\n' +
  '- Mensual (tipo="mensual"): periodos consecutivos (Ene, Feb, Mar, Abr...) o el recibo dice "mensual".\n' +
  '- Si ves 6 periodos cubriendo un año de 2 en 2 meses, es SIEMPRE bimestral.\n\n' +
  'EXTRACCIÓN:\n' +
  '- Extrae el kWh de CADA periodo visible en el historial.\n' +
  '- Extrae la TARIFA CFE (ej: "1D", "DAC", "2", "3"). Aparece en el encabezado o datos del cliente.\n' +
  '- Extrae el NOMBRE del titular tal como aparece en el recibo (ej: "GONZALEZ PALMA MARIA TERESA").\n' +
  '- Extrae la DIRECCIÓN o colonia/municipio del titular (ej: "Col. Los Alamos, Monclova, Coah").\n' +
  '- Si algún número es dudoso, usa tu mejor estimación; NO devuelvas error por incertidumbre menor.\n' +
  '- Solo devuelve error si la imagen es completamente ilegible, no es CFE, o es imposible extraer cualquier kWh.\n\n' +
  'Responde ÚNICAMENTE con JSON válido:\n' +
  '{ "tipo": "bimestral"|"mensual", "tarifa": "1D"|null, "nombre_cliente": "nombre o null", "direccion_cliente": "dirección o null", "periodos": [{"periodo":"...","kwh":número}], "promedio_kwh": número }\n\n' +
  'Solo si es IMPOSIBLE extraer datos:\n' +
  '{ "tipo": "error", "mensaje": "razón concreta" }';

async function analyzeImages(filePaths) {
  const intro = filePaths.length === 2
    ? 'Aquí tienes el FRENTE y el REVERSO del mismo recibo de CFE. Analiza ambas imágenes juntas.\n\n'
    : 'Analiza este recibo de luz de CFE.\n\n';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [{
      type: 'text',
      text: 'Eres un experto en facturas de electricidad de CFE México. Extraes datos de consumo eléctrico y los devuelves en JSON válido.',
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{
      role: 'user',
      content: [
        ...filePaths.map(imageBlock),
        { type: 'text', text: intro + BILL_PROMPT },
      ],
    }],
  });

  const raw   = response.content[0].text.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude no devolvió JSON válido');
  return JSON.parse(match[0]);
}

// ─── Terminal UI ──────────────────────────────────────────────────────────────

const C = {
  green:  '\x1b[32m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  gray:   '\x1b[90m',
  red:    '\x1b[31m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  reset:  '\x1b[0m',
};

function formatWhatsApp(text) {
  return text
    .replace(/\*(.*?)\*/g,  `${C.bold}$1${C.reset}`)
    .replace(/_(.*?)_/g,    `${C.dim}$1${C.reset}`)
    .replace(/━+/g,         `${C.gray}$&${C.reset}`);
}

function printBot(body) {
  const lines = body.split('\n');
  console.log(`\n${C.cyan}${C.bold}  ╔══ SOLHARM Bot ════════════════════════════╗${C.reset}`);
  lines.forEach(line => console.log(`${C.cyan}  ║${C.reset} ${formatWhatsApp(line)}`));
  console.log(`${C.cyan}${C.bold}  ╚════════════════════════════════════════════╝${C.reset}\n`);
}

function printSystem(msg) {
  console.log(`${C.gray}  ℹ  ${msg}${C.reset}`);
}

function printError(msg) {
  console.log(`${C.red}  ✗  ${msg}${C.reset}\n`);
}

function printUser(input, isPhoto) {
  const label = isPhoto ? `📎 ${path.basename(input)}` : input;
  console.log(`\n${C.green}${C.bold}  Tú:${C.reset} ${C.green}${label}${C.reset}`);
}

let spinnerTimer = null;
function startSpinner(msg) {
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0;
  spinnerTimer = setInterval(() => {
    process.stdout.write(`\r${C.yellow}  ${frames[i++ % frames.length]}  ${msg}${C.reset}`);
  }, 100);
}
function stopSpinner() {
  if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
}

// ─── Sesión ───────────────────────────────────────────────────────────────────

let session = { state: 'greeting' };

async function handleMessage(text, imagePath) {
  const lower = (text || '').toLowerCase().trim();
  const isPhoto = !!imagePath;

  const resetWords = ['hola', 'inicio', 'iniciar', 'reiniciar', 'nuevo', 'empezar', 'start', 'menu', 'menú', 'buenas', 'buenos'];
  if (resetWords.includes(lower) && session.state !== 'greeting') {
    session = { state: 'greeting' };
  }

  switch (session.state) {

    // ── 1. Saludo ─────────────────────────────────────────────────────────────
    case 'greeting': {
      await printBot(
        `¡Hola! 👋 Bienvenido/a a *SOLHARM Energía Solar* ☀️\n\n` +
        `Es un gusto atenderle. Somos especialistas en sistemas fotovoltaicos y con mucho gusto le ayudamos a encontrar el sistema ideal para su hogar o negocio.\n\n` +
        `Para prepararle una cotización *personalizada y completamente gratuita*, nos ayudaría mucho analizar su recibo de luz de CFE.\n\n` +
        `📸 *Paso 1 de 2 — Foto del FRENTE del recibo*\n` +
        `¿Podría compartirme la ruta de la foto de la parte frontal de su recibo? 😊`
      );
      session.state = 'waiting_front';
      break;
    }

    // ── 2. Esperando frente ───────────────────────────────────────────────────
    case 'waiting_front': {
      if (!isPhoto) {
        await printBot(
          `Con gusto le ayudo 😊 Para continuar, ¿podría indicarme la ruta de la foto del *frente* de su recibo de CFE? 📸\n\n` +
          `Ejemplo: ${C.dim}~/Desktop/recibo-frente.jpg${C.reset}`
        );
        break;
      }
      session.frontPath = imagePath;
      await printBot(
        `✅ ¡Gracias! Ya recibí el frente del recibo.\n\n` +
        `📸 *Paso 2 de 2 — Foto del REVERSO del recibo*\n` +
        `¿Me podría indicar también la ruta de la parte de atrás? Ahí suele estar el historial de consumo. 🙏`
      );
      session.state = 'waiting_back';
      break;
    }

    // ── 3. Esperando reverso y analizando ─────────────────────────────────────
    case 'waiting_back': {
      if (!isPhoto) {
        await printBot(
          `Sólo me falta la foto del *reverso* de su recibo para completar el análisis 📸\n\n` +
          `¿Podría indicarme la ruta cuando guste?`
        );
        break;
      }

      session.state = 'analyzing';
      startSpinner('Analizando su recibo con IA...');

      try {
        const data = await analyzeImages([session.frontPath, imagePath]);
        stopSpinner();

        if (data.tipo === 'error') {
          await printBot(
            `Le pido una disculpa, no me fue posible extraer los datos del recibo 🙏\n\n` +
            `_${data.mensaje}_\n\n` +
            `Escriba *reiniciar* para intentarlo de nuevo con fotos más claras.`
          );
          session.state = 'waiting_front';
          break;
        }

        session.billData = data;
        const pkg = recommendPackage(data.promedio_kwh, data.tipo);
        session.recommendation = pkg;

        const tipoLabel  = data.tipo === 'bimestral' ? 'bimestre' : 'mes';
        const days       = data.tipo === 'bimestral' ? 61 : 30.44;
        const produccion = Math.round(pkg.panels * PANEL_KWH_DAY * days);
        const historial  = data.periodos
          .map(p => `   • ${p.periodo}: *${Number(p.kwh).toLocaleString('es-MX')} kWh*`)
          .join('\n');

        await printBot(
          `✅ *Análisis completado*\n\n` +
          `📋 *Historial de consumo (${data.tipo}):*\n${historial}\n\n` +
          `📊 Promedio: *${Math.round(data.promedio_kwh).toLocaleString('es-MX')} kWh* por ${tipoLabel}\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `☀️ *PROPUESTA SOLHARM PARA USTED*\n\n` +
          `🔆 *Paquete de ${pkg.panels} paneles solares*\n` +
          `⚡ Producción estimada: ~${produccion.toLocaleString('es-MX')} kWh por ${tipoLabel}\n` +
          `💰 Inversión: *${mxn(pkg.price)}*\n\n` +
          `Este sistema produciría *más* de lo que consume actualmente, llevando su factura de CFE prácticamente a *$0* 🎉`
        );
        await printBot(
          `Una pregunta adicional que nos ayuda a afinar su propuesta 😊\n\n` +
          `🔌 ¿Tiene planeado agregar aparatos eléctricos en el futuro? Por ejemplo: *minisplits, calentador de agua eléctrico, vehículo eléctrico* u otros equipos de mayor consumo.\n\n` +
          `¿*Sí* o *No*?`
        );
        session.state = 'asking_growth';

      } catch (err) {
        stopSpinner();
        printError(`Error al analizar: ${err.message}`);
        await printBot(`Le pido disculpa, ocurrió un problema al procesar las fotos 🙏\n\nEscriba *reiniciar* para intentarlo de nuevo.`);
        session.state = 'waiting_front';
      }
      break;
    }

    case 'analyzing': {
      printSystem('Espera, todavía estoy analizando el recibo...');
      break;
    }

    // ── 5. Pregunta sobre crecimiento ─────────────────────────────────────────
    case 'asking_growth': {
      const yes = /s[ií]|claro|sip|por supuesto|planeamos|plan|tengo|queremos|quiero|piens|tal vez|quizá|posible/.test(lower);
      const no  = /no\b|nop|por ahora no|de momento no|actualmente no|ninguno|ningún/.test(lower);

      if (yes) {
        session.wantsGrowth = true;
        await printBot(
          `¡Perfecto, qué bueno saberlo! 😊 Eso es algo muy importante que tomaremos en cuenta.\n\n` +
          `Para generarle su *cotización formal en PDF*, ¿me podría decir su *nombre completo*?`
        );
        session.state = 'waiting_nombre';
      } else if (no) {
        session.wantsGrowth = false;
        await printBot(
          `Entendido, muchas gracias 🙏\n\n` +
          `Para generarle su *cotización formal en PDF*, ¿me podría decir su *nombre completo*?`
        );
        session.state = 'waiting_nombre';
      } else {
        await printBot(
          `Disculpe, ¿podría indicarme si tiene planeado agregar aparatos como minisplits o calentadores en el futuro?\n\n` +
          `Solo responda *Sí* o *No* 😊`
        );
      }
      break;
    }

    // ── 6. Nombre del cliente ─────────────────────────────────────────────────
    case 'waiting_nombre': {
      const useBillName = /recibo|factura|ya sale|ya aparece|ya viene|el mismo|la misma|ahí (sale|viene|está|aparece)|lo que dice|el que (sale|aparece|viene)/i.test(text || '');
      if (useBillName && session.billData?.nombre_cliente) {
        session.clientName = session.billData.nombre_cliente;
        await printBot(
          `¡Perfecto! Usaré el nombre del recibo: *${session.clientName}* 😊\n\n` +
          `¿Y su dirección o municipio? (o escriba *"recibo"* si quiere usar la del recibo)`
        );
        session.state = 'waiting_direccion';
        break;
      }
      if (!text || text.length < 2) {
        await printBot(`¿Podría indicarme su nombre completo, por favor? 😊`);
        break;
      }
      session.clientName = text.trim()
        .split(' ')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
      await printBot(
        `Muchas gracias, ${session.clientName.split(' ')[0]} 😊\n\n` +
        `¿Y su dirección o municipio? (ej: Col. Guadalupe, Monclova, Coahuila)\n` +
        `O escriba *"recibo"* si quiere usar la dirección que aparece en el recibo.`
      );
      session.state = 'waiting_direccion';
      break;
    }

    // ── 7. Dirección + generar PDF ────────────────────────────────────────────
    case 'waiting_direccion': {
      const useBillAddr = /recibo|factura|ya sale|ya aparece|ya viene|el mismo|la misma|ahí (sale|viene|está|aparece)|lo que dice|el que (sale|aparece|viene)/i.test(text || '');
      if (useBillAddr && session.billData?.direccion_cliente) {
        session.clientAddress = session.billData.direccion_cliente;
      } else if (!text || text.length < 2) {
        await printBot(`¿Podría indicarme su dirección o municipio? 😊`);
        break;
      } else {
        session.clientAddress = text.trim();
      }

      startSpinner('Generando su cotización en PDF...');

      try {
        const billData = session.billData || {};
        const rec      = session.recommendation;
        const pdfData  = {
          nombre:       session.clientName,
          direccion:    session.clientAddress,
          tarifa:       billData.tarifa || '',
          periodos:     billData.periodos || [],
          promedio_kwh: billData.promedio_kwh || 0,
          tipo:         billData.tipo || 'mensual',
          panels:       rec.panels,
          price:        rec.price,
        };

        const pdfBuffer  = await generateQuotePdf(pdfData);
        const filename   = `cotizacion-${crypto.randomBytes(6).toString('hex')}.pdf`;
        const filepath   = path.join('/tmp', filename);
        fs.writeFileSync(filepath, pdfBuffer);
        stopSpinner();

        await printBot(
          `✅ *¡Su cotización está lista!* 📄\n\n` +
          `Archivo guardado en:\n_${filepath}_\n\n` +
          `_Válida por 7 días a partir de hoy._`
        );

        // Abrir el PDF automáticamente
        require('child_process').exec(`open "${filepath}"`);
        printSystem('Abriendo el PDF...');

        if (session.wantsGrowth) {
          await printBot(
            `Le recomendamos agendar una reunión en nuestras oficinas *SOLHARM* en la *Col. Tecnológico*, ` +
            `donde uno de nuestros asesores preparará una propuesta completa considerando todos los equipos que planea agregar 🤝\n\n` +
            `📅 ¿Qué día y horario le quedaría bien?\n` +
            `¿Prefiere por la *mañana* (9:00–13:00) o por la *tarde* (14:00–18:00)?`
          );
          session.state = 'scheduling';
        } else {
          await printBot(
            `Si en algún momento desea ampliar su sistema, con gusto lo ajustamos. ` +
            `También le invitamos a visitarnos en la *Col. Tecnológico* cuando guste 😊\n\n` +
            `¿Hay algo más en lo que pueda orientarle?\n` +
            `💳 *Pagos*  ·  🔧 *Instalación*  ·  📅 *Reunión en oficinas*`
          );
          session.state = 'followup';
        }
      } catch (err) {
        stopSpinner();
        printError(`Error al generar PDF: ${err.message}`);
        await printBot(`Su cotización ha quedado registrada. Un asesor se la enviará directamente 📄`);
        session.state = 'followup';
      }
      break;
    }

    // ── 8. Seguimiento ────────────────────────────────────────────────────────
    case 'followup': {
      const rec = session.recommendation;

      if (/pago|financ|precio|costo|cuánt|cuant|adelanto|cuota|crédito|credito|meses|abono/.test(lower)) {
        const adelanto    = Math.round(rec.price * 0.50);
        const instalacion = Math.round(rec.price * 0.45);
        const medidor     = Math.round(rec.price * 0.05);
        await printBot(
          `💳 *Esquema de pagos SOLHARM*\n\n` +
          `Para su paquete de *${rec.panels} paneles* — ${mxn(rec.price)}, el pago se divide en tres etapas:\n\n` +
          `1️⃣ *50% — Adelanto al confirmar su pedido*\n   ${mxn(adelanto)}\n\n` +
          `2️⃣ *45% — Al momento de instalar los paneles*\n   ${mxn(instalacion)}\n\n` +
          `3️⃣ *5% — Al cambio de medidor por CFE*\n   ${mxn(medidor)}\n\n` +
          `Si gusta, con mucho gusto le recibimos en nuestras oficinas para platicar con más detalle 🤝`
        );

      } else if (/instal|tiempo|cuándo|cuando|demor|tarda|medidor|proceso|días|dias|semana/.test(lower)) {
        await printBot(
          `🔧 *Proceso de instalación SOLHARM*\n\n` +
          `⚡ *Instalación del sistema solar: 1 día*\n` +
          `Nuestro equipo realiza la instalación completa en un solo día hábil.\n\n` +
          `⏳ *Cambio de medidor CFE: 2 a 2.5 meses*\n` +
          `Una vez instalados los paneles, iniciamos el trámite ante CFE para el medidor bidireccional. ` +
          `Este proceso depende directamente de CFE y toma entre 2 y 2.5 meses aproximadamente.\n\n` +
          `⚠️ *Importante:* el sistema comienza a funcionar hasta que CFE realice el cambio de medidor bidireccional.\n\n` +
          `¿Le gustaría venir a nuestras oficinas para platicar con más detalle? Con gusto le atendemos 😊`
        );

      } else if (/visit|agenda|cita|fecha|hora|técnic|tecnic|gratis|ofic|asesor|reuni/.test(lower)) {
        await printBot(
          `📅 *Reunión en oficinas SOLHARM*\n\n` +
          `¡Qué gusto! Le invitamos a nuestras oficinas en la *Col. Tecnológico*, donde un asesor le explicará su propuesta con toda la calma del mundo.\n\n` +
          `La reunión es completamente *gratuita y sin ningún compromiso* 🤝\n\n` +
          `¿Podría indicarme su disponibilidad?\n` +
          `📆 ¿Qué *fecha* le vendría bien? (ej: martes 20 de mayo)\n` +
          `🕐 ¿Prefiere *mañana* (9:00–13:00) o *tarde* (14:00–18:00)?`
        );
        session.state = 'scheduling';

      } else if (/paquete|opcion|opción|todos|panel|otro|lista/.test(lower)) {
        const list = PACKAGES
          .map(p => `${p.panels === rec?.panels ? '👉' : '  '} *${p.panels} paneles* — ${mxn(p.price)}`)
          .join('\n');
        await printBot(
          `☀️ *Paquetes disponibles SOLHARM*\n\n${list}\n\n` +
          `El paquete señalado con 👉 es el recomendado según su consumo.`
        );

      } else {
        await printBot(
          `Con gusto le oriento ☀️ Puede preguntarme sobre:\n\n` +
          `💳 *"pagos"* — Esquema de pago en 3 etapas\n` +
          `🔧 *"instalación"* — Tiempos y proceso\n` +
          `☀️ *"paquetes"* — Ver todos los paquetes disponibles\n` +
          `📅 *"reunión"* — Visítenos en oficinas (Col. Tecnológico)\n\n` +
          `O escriba *reiniciar* para analizar otro recibo.`
        );
      }
      break;
    }

    // ── 9. Agendando reunión ──────────────────────────────────────────────────
    case 'scheduling': {
      await printBot(
        `✅ *¡Muchas gracias! Su cita ha quedado registrada.*\n\n` +
        `📋 Preferencia: _${text}_\n\n` +
        `Uno de nuestros asesores de *SOLHARM* (Col. Tecnológico) se pondrá en contacto con usted en las próximas horas para confirmar la reunión. 🤝☀️\n\n` +
        `¡Gracias por su confianza! Estamos a sus órdenes para cualquier duda. 🌞`
      );
      session.state = 'done';
      break;
    }

    // ── 10. Conversación terminada ────────────────────────────────────────────
    case 'done': {
      await printBot(
        `¡Hola de nuevo! 😊 Es un gusto saludarle.\n\n` +
        `Escriba *hola* cuando guste para iniciar una nueva consulta con *SOLHARM Energía Solar* ☀️`
      );
      break;
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.clear();
  console.log(`${C.yellow}${C.bold}`);
  console.log(`  ╔══════════════════════════════════════════════╗`);
  console.log(`  ║    SOLHARM — Simulador de WhatsApp           ║`);
  console.log(`  ║    Escribe como si fueras un cliente         ║`);
  console.log(`  ╚══════════════════════════════════════════════╝`);
  console.log(`${C.reset}`);
  console.log(`${C.gray}  Para enviar una foto: escribe la ruta del archivo (ej: ~/Desktop/recibo.jpg)`);
  console.log(`  Para salir: Ctrl+C o escribe /salir${C.reset}\n`);

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    terminal: true,
  });

  await handleMessage('hola', null);

  let busy = false;

  const prompt = () => process.stdout.write(`${C.green}${C.bold}  Tú: ${C.reset}`);

  prompt();

  rl.on('line', async (rawInput) => {
    const input = rawInput.trim();
    if (!input) { prompt(); return; }
    if (input === '/salir' || input === '/exit') {
      console.log(`\n${C.gray}  Hasta luego. 👋${C.reset}\n`);
      process.exit(0);
    }
    if (busy) { printSystem('Un momento, estoy procesando...'); prompt(); return; }

    busy = true;
    rl.pause();

    const imagePath = resolveImagePath(input);
    printUser(input, !!imagePath);
    if (imagePath) printSystem(`Imagen reconocida: ${imagePath}`);

    try {
      await handleMessage(imagePath ? null : input, imagePath);
    } catch (err) {
      stopSpinner();
      printError(`Error inesperado: ${err.message}`);
    }

    busy = false;
    rl.resume();
    prompt();
  });

  rl.on('close', () => {
    console.log(`\n${C.gray}  Hasta luego. 👋${C.reset}\n`);
    process.exit(0);
  });
}

main().catch(err => {
  console.error(`${C.red}Error al iniciar:${C.reset}`, err.message);
  process.exit(1);
});
