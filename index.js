require('dotenv').config();
const express   = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios     = require('axios');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const { generateQuotePdf } = require('./quote');

const QUOTES_DIR = path.join(__dirname, 'quotes');
if (!fs.existsSync(QUOTES_DIR)) fs.mkdirSync(QUOTES_DIR);

const app = express();
app.use(express.json());
app.use('/quotes', express.static(QUOTES_DIR));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;

// ─── Catálogo de paquetes ─────────────────────────────────────────────────────

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

// ─── Sesiones en memoria ──────────────────────────────────────────────────────

const sessions = new Map();
function getSession(from) {
  if (!sessions.has(from)) sessions.set(from, { state: 'greeting' });
  return sessions.get(from);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mxn(amount) {
  return `$${amount.toLocaleString('es-MX')} MXN`;
}

function calcAvgKwh(periodos, tipo) {
  const yearSize = tipo === 'bimestral' ? 6 : 12;
  const relevant = periodos.length > yearSize ? periodos.slice(-yearSize) : periodos;
  const avg = relevant.reduce((s, p) => s + Number(p.kwh), 0) / relevant.length;
  return { avg, relevant };
}

function recommendPackage(avgKwh, tipo) {
  const dailyKwh = tipo === 'bimestral' ? (avgKwh * 6) / 365 : avgKwh / 30.44;
  const rawPanels = dailyKwh / PANEL_KWH_DAY;
  const panels = Math.ceil((rawPanels + 0.3) / 2) * 2;
  const pkg = PACKAGES.find(p => p.panels >= panels) || PACKAGES[PACKAGES.length - 1];
  return { ...pkg, rawPanels, dailyKwh };
}

// ─── Envío de mensajes Meta ───────────────────────────────────────────────────

async function send(to, body) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

// ─── Descarga de imágenes Meta ────────────────────────────────────────────────

async function downloadMetaImage(mediaId) {
  const infoRes = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
  const imageRes = await axios.get(infoRes.data.url, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  return {
    base64: Buffer.from(imageRes.data).toString('base64'),
    mediaType: infoRes.data.mime_type || 'image/jpeg',
  };
}
// ─── Reintento automático ─────────────────────────────────────────────────────

async function withRetry(fn, maxRetries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isOverloaded = err?.error?.type === 'overloaded_error' || 
                           err?.message?.includes('overloaded') ||
                           err?.status === 529;
      if (isOverloaded && attempt < maxRetries) {
        console.log(`[retry] Intento ${attempt} fallido por sobrecarga, reintentando en ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs * attempt));
      } else {
        throw err;
      }
    }
  }
}
// ─── Análisis de recibo con Claude Vision ─────────────────────────────────────

const BILL_PROMPT =
  'REGLAS PARA DETECTAR EL TIPO:\n' +
  '- Bimestral (tipo="bimestral"): periodos con rangos como "Ene-Feb", "Mar-Abr", "May-Jun", etc.\n' +
  '- Mensual (tipo="mensual"): periodos consecutivos (Ene, Feb, Mar, Abr...) o el recibo dice "mensual".\n' +
  '- Si ves 6 periodos que cubren un año saltando 2 meses, es SIEMPRE bimestral.\n\n' +
  'EXTRACCIÓN:\n' +
  '- Extrae el kWh de CADA periodo visible en el historial.\n' +
  '- Ordena el arreglo "periodos" de MÁS ANTIGUO a MÁS RECIENTE (índice 0 = el más viejo).\n' +
  '- Extrae la TARIFA CFE (ejemplos: "1D", "DAC", "2", "3").\n' +
  '- Extrae el NOMBRE del titular tal como aparece en el recibo.\n' +
  '- Extrae la DIRECCIÓN o colonia/municipio del titular.\n' +
  '- Solo devuelve error si la imagen es completamente ilegible.\n\n' +
  'Responde ÚNICAMENTE con JSON válido:\n' +
  '{\n' +
  '  "tipo": "bimestral" | "mensual",\n' +
  '  "tarifa": "tarifa CFE o null",\n' +
  '  "nombre_cliente": "nombre del titular o null",\n' +
  '  "direccion_cliente": "colonia y municipio o null",\n' +
  '  "periodos": [ { "periodo": "ej: Ene-Feb 2024", "kwh": número } ],\n' +
  '  "promedio_kwh": número\n' +
  '}\n\n' +
  'Solo si es IMPOSIBLE extraer datos:\n' +
  '{ "tipo": "error", "mensaje": "razón concreta" }';

async function analyzeBill(frontMediaId, backMediaId = null) {
  const images = await Promise.all(
    [frontMediaId, backMediaId].filter(Boolean).map(downloadMetaImage)
  );
  const imageBlocks = images.map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
  }));
  const introText = backMediaId
    ? 'Aquí tienes el FRENTE y el REVERSO del mismo recibo de CFE. Analiza ambas imágenes juntas.\n\n'
    : 'Analiza este recibo de luz de CFE.\n\n';

 const response = await withRetry(() => anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [{ type: 'text', text: 'Eres un experto en facturas de electricidad de CFE México. Extraes datos de consumo eléctrico y los devuelves en JSON válido.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: introText + BILL_PROMPT }] }],
  }));

  const raw = response.content[0].text.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude no devolvió JSON válido');
  return JSON.parse(match[0]);
}

// ─── Preguntas frecuentes ─────────────────────────────────────────────────────

const FAQS = [
  { pattern: /cuánto cuesta|cuanto cuesta|precio.*instal|costo.*instal|cuánto val[eo]|cuanto val[eo]|cuánto cobran|cuanto cobran/i,
    answer: '💰 *¿Cuánto cuesta instalar paneles?*\n\nDepende del consumo. Los sistemas van de *$48,300 a $180,000 MXN* ya instalados. Con su recibo de CFE calculamos el precio exacto. 😊' },
  { pattern: /recupera.*inver|tiempo.*recuper|cuándo.*recuper|cuando.*recuper|retorno.*inver/i,
    answer: '📈 *¿En cuánto tiempo se recupera la inversión?*\n\nNormalmente en *2 años* dependiendo de lo que pague de CFE. Después de eso, la energía es prácticamente gratuita. ☀️' },
  { pattern: /cuántos panel|cuantos panel|cuántos necesit|cuantos necesit/i,
    answer: '🔆 *¿Cuántos paneles necesito?*\n\nSe calcula con su recibo de CFE. Con el historial de consumo le decimos exactamente cuántos necesita. 📸' },
  { pattern: /baj.*recibo|baj.*factura|reducen.*recibo|cuánto bajan|cuanto bajan/i,
    answer: '⚡ *¿Bajan mucho el recibo?*\n\nSí, normalmente entre *80% y 99%*. La mayoría de nuestros clientes pagan muy poco o casi nada de CFE. 🎉' },
  { pattern: /nublad|día.*nublad|dias.*nublad/i,
    answer: '☁️ *¿Funcionan aunque esté nublado?*\n\nSí, siguen produciendo energía, solo que un poco menos que en día completamente soleado. 😊' },
  { pattern: /se va la luz|apagón|apagon|corte.*luz|luz.*se va|sin luz/i,
    answer: '🔌 *¿Qué pasa si se va la luz?*\n\nLos sistemas conectados a CFE se apagan por seguridad. Para tener luz en apagones necesitaría baterías o sistema híbrido. 🔋' },
  { pattern: /de noche|panel.*noche|produc.*noche|energía.*noche|energia.*noche/i,
    answer: '🌙 *¿Funcionan de noche?*\n\nNo producen de noche, pero puede usar energía en baterías o la red de CFE durante las horas sin sol. 😊' },
  { pattern: /cuántos años duran|cuantos años duran|vida útil|vida util|cuánto duran|cuanto duran/i,
    answer: '⏳ *¿Cuántos años duran?*\n\nAproximadamente *25 a 30 años*. Son muy duraderos y siguen funcionando por décadas. ☀️' },
  { pattern: /mantenimiento|limpieza.*panel|limpiar.*panel/i,
    answer: '🔧 *¿Qué mantenimiento necesitan?*\n\nPrincipalmente *limpieza cada 4 a 6 meses* y revisión básica del sistema. Muy sencillo y económico. 😊' },
  { pattern: /granizo|lluvia.*daño|daño.*lluvia|resist.*lluvia|resist.*granizo/i,
    answer: '🌧️ *¿Se dañan con granizo o lluvia?*\n\nNo, están diseñados para soportar climas extremos y granizo moderado. Son muy resistentes. 💪' },
  { pattern: /garantía|garantia/i,
    answer: '📋 *¿Qué garantía tienen?*\n\nNormalmente entre *10 y 25 años* dependiendo de la marca. Cubrimos paneles y equipo de inversión. 😊' },
  { pattern: /qué marca|que marca|cuál.*marca|cual.*marca/i,
    answer: '🏷️ *¿Qué marcas manejan?*\n\nTrabajamos con marcas reconocidas con garantía y certificaciones internacionales. Le asesoramos sobre la mejor opción. 😊' },
  { pattern: /espacio.*techo|techo.*espacio|cuánto espacio|cuanto espacio/i,
    answer: '📐 *¿Cuánto espacio necesito en el techo?*\n\nAproximadamente *2 m² por panel*. Para 10 paneles, unos 20 m² de techo disponible. 😊' },
  { pattern: /minisplit|aire acondicionado|aire.*acondicion/i,
    answer: '❄️ *¿Sirven para minisplit y clima?*\n\nSí, ayudan mucho a reducir el gasto del aire acondicionado. ☀️' },
  { pattern: /toda (la )?casa|toda mi casa|cubrir.*casa|casa completa/i,
    answer: '🏠 *¿Puedo conectar toda mi casa?*\n\nSí, el sistema puede diseñarse para cubrir todo su consumo eléctrico. 😊' },
  { pattern: /permiso.*cfe|cfe.*permiso|trámite.*cfe|tramite.*cfe|necesito permiso|ustedes.*trámite|ustedes.*tramite|hacen.*trámite|hacen.*tramite/i,
    answer: '📋 *Trámites con CFE*\n\nSí, se tramita el medidor bidireccional. *Nosotros nos encargamos de todo el proceso*, usted no tiene que hacer nada. 🤝' },
  { pattern: /cuánto tarda.*instal|cuanto tarda.*instal|días.*instal|tiempo.*instal/i,
    answer: '⏱️ *¿Cuánto tarda la instalación?*\n\nLa instalación toma *1 a 3 días*. El trámite del medidor con CFE toma 2 a 2.5 meses adicionales. 😊' },
  { pattern: /negocio|comercial|empresa|industria/i,
    answer: '🏢 *¿Hacen instalaciones en negocios?*\n\nSí, instalamos en *casas, negocios e industrias*. Con gusto le preparamos una propuesta. 😊' },
  { pattern: /financiamiento|financiam|anticipo.*plazo|pago.*plazo/i,
    answer: '💳 *¿Tienen financiamiento?*\n\nSí, *50% de anticipo y el resto en hasta 6 pagos mensuales*. Damos facilidades para que empiece a ahorrar cuanto antes. 😊' },
  { pattern: /agregar.*panel|añadir.*panel|más panel|ampliar.*sistema|expandir/i,
    answer: '🔆 *¿Puedo agregar más paneles después?*\n\nSí, en la mayoría de los casos el sistema se puede ampliar fácilmente. 😊' },
  { pattern: /techo.*aguanta|aguanta.*techo|peso.*panel|panel.*peso/i,
    answer: '🏗️ *¿Mi techo aguanta el peso?*\n\nGeneralmente sí. Los paneles son más ligeros de lo que la gente cree, y hacemos evaluación antes de instalar. 😊' },
  { pattern: /batería|bateria/i,
    answer: '🔋 *¿Y las baterías?*\n\nSolo se incluyen si el cliente las solicita. Las recomendamos cuando se necesitan de verdad, ya que elevan el costo. El precio varía según la capacidad requerida. 😊' },
  { pattern: /monitorear|monitoreo|ver.*celular|app.*panel|consumo.*celular/i,
    answer: '📱 *¿Puedo monitorear desde el celular?*\n\nSí, puede ver producción y consumo en tiempo real desde una app en su teléfono. 😊' },
  { pattern: /vend.*casa|mudanz|me mudo|valor.*propiedad|valor.*casa/i,
    answer: '🏠 *¿Qué pasa si vendo mi casa o me mudo?*\n\nPodemos desmontar e instalar en su nueva casa. Además, los paneles *aumentan el valor de la propiedad*. 😊' },
  { pattern: /panel.*deja.*funcionar|panel.*falla\b|panel.*no funciona/i,
    answer: '🔧 *¿Qué pasa si un panel deja de funcionar?*\n\nSe revisa y se aplica la garantía si corresponde. Nuestro equipo le apoya en todo el proceso. 😊' },
  { pattern: /lámina|lamina|techo.*metal\b|techo metálico/i,
    answer: '🏚️ *¿Se pueden instalar en techo de lámina?*\n\nSí, existen estructuras especiales para techos de lámina o cualquier tipo de techo. 😊' },
  { pattern: /cuándo empiez.*ahorr|cuando empiez.*ahorr|desde cuándo ahorr|primer.*recibo.*ahorr/i,
    answer: '💰 *¿Desde cuándo empiezan a ahorrar?*\n\n¡Desde el primer recibo después de la conexión con CFE! El ahorro se refleja inmediatamente. 🎉' },
  { pattern: /rentad|en renta|alquiler|casa rentada/i,
    answer: '🏠 *¿Y si mi casa es rentada?*\n\nSí se pueden instalar. En caso de mudanza también hacemos el cambio a la nueva ubicación. 😊' },
];

function detectarFAQ(text) {
  for (const faq of FAQS) {
    if (faq.pattern.test(text)) return faq.answer;
  }
  return null;
}

const BLOCKING_STATES = ['menu', 'menu_nombre_cita', 'waiting_front', 'waiting_back', 'asking_growth', 'waiting_nombre', 'waiting_direccion', 'scheduling'];

function mensajeRetoma(state) {
  switch (state) {
    case 'menu_nombre_cita':    return '¿Me podría compartir su nombre para agendar la cita? 😊';
    case 'waiting_front':       return '📸 Cuando guste, comparta la foto del *frente* de su recibo de CFE para continuar 😊';
    case 'waiting_back':        return '📸 Cuando guste, también necesito la foto del *reverso* del recibo para completar el análisis 😊';
    case 'asking_growth':       return '¿Tiene planeado agregar aparatos eléctricos en el futuro (minisplits, calentador, etc.)? Solo responda *Sí* o *No* 😊';
    case 'waiting_nombre':      return '¿Me podría decir su *nombre completo* para generarle la cotización? 😊';
    case 'waiting_direccion':   return '¿Me podría indicar su *dirección o municipio*? 😊';
    case 'scheduling':          return '¿Qué *día y horario* le viene bien para la visita? (ej: "martes a las 3pm") 😊';
    default:                    return null;
  }
}

// ─── Menú principal ───────────────────────────────────────────────────────────

const OPCIONES_TEXT =
  `¿Qué le gustaría hacer? Responda con el número:\n\n` +
  `1️⃣ Cotización gratis (analizamos su recibo de luz) 📸\n\n` +
  `_Después también puede agendar una cita, hablar con un asesor o resolver dudas._\n\n` +
  `2️⃣ Agendar una visita en nuestras oficinas 📅\n\n` +
  `_Después también puede cotizar, hablar con un asesor o resolver dudas._\n\n` +
  `3️⃣ Hablar con un asesor de ventas 💬\n` +
  `4️⃣ Tengo una duda ❓`;

async function mostrarMenu(from, esSaludo = false) {
  if (!esSaludo) await new Promise(r => setTimeout(r, 2000));
  const session = getSession(from);
  const encabezado = esSaludo
    ? `¡Hola! 👋 Bienvenido/a a *SOLHARM Energía Solar* ☀️\n\nCon gusto le ayudamos a ahorrar en su recibo de luz.\n\n`
    : `¿Le puedo ayudar en algo más? 😊\n\n`;
  await send(from, encabezado + OPCIONES_TEXT);
  session.state = 'menu';
}

// ─── Lógica de conversación ───────────────────────────────────────────────────

async function handleIncoming(from, bodyText, mediaId) {
  const session = getSession(from);
  const text = (bodyText || '').toLowerCase().trim();

  const resetWords = ['hola', 'inicio', 'iniciar', 'reiniciar', 'nuevo', 'empezar', 'start', 'menu', 'menú', 'buenas', 'buenos'];
  if (resetWords.includes(text) && session.state !== 'greeting') {
    sessions.set(from, { state: 'greeting' });
    session.state = 'greeting';
  }

  // FAQ: responder preguntas en cualquier momento del flujo sin trabar el proceso
  if (!mediaId && BLOCKING_STATES.includes(session.state)) {
    const faqAnswer = detectarFAQ(text);
    if (faqAnswer) {
      const invitacion = ['waiting_front', 'waiting_back'].includes(session.state)
        ? '\n\n📸 Si gusta, puede compartirme una foto de su recibo de CFE y le hago una cotización personalizada 😊'
        : '';
      await send(from, faqAnswer + invitacion);
      return;
    }
    if (/\bduda\b|tengo (una )?pregunta|quisiera preguntar|quería (preguntar|consultar)|quiero preguntar|me (puede|podría|pueden) (ayudar|asesorar|orientar|dar información)/i.test(text)) {
      await send(from, '¡Claro! 😊 Con gusto le ayudo. ¿Cuál es su duda?');
      return;
    }
  }

  switch (session.state) {

    case 'greeting': {
      await mostrarMenu(from, true);
      break;
    }

    case 'menu': {
      if (/^1/.test(text)) {
        await send(from,
          `📸 *Paso 1 de 2 — Foto del FRENTE del recibo*\n\n` +
          `¿Podría compartirme una foto de la parte frontal de su recibo de CFE? 😊`
        );
        session.state = 'waiting_front';
      } else if (/^2/.test(text)) {
        if (session.clientName) {
          await send(from,
            `📅 ¡Con gusto, ${session.clientName}! Le esperamos en nuestras *oficinas en Monclova*. La reunión es *gratuita y sin compromiso* 🤝\n\n` +
            `¿Qué *día y horario* le viene bien? (ej: "martes a las 3pm", "mañana a las 10am")\n\n` +
            `🕐 *Nuestro horario de atención:*\n` +
            `Lunes a Viernes: 9:00 am a 7:00 pm\n` +
            `Sábados: 9:00 am a 1:30 pm\n` +
            `Domingos: cerrado`
          );
          session.state = 'scheduling';
        } else {
          await send(from, `¿Me podría compartir su nombre para agendar la cita? 😊`);
          session.state = 'menu_nombre_cita';
        }
      } else if (/^[34]/.test(text)) {
        await send(from, `Esta opción estará disponible muy pronto 😊`);
      } else {
        await send(from,
          `Por favor responda con el número de la opción:\n\n` +
          `1️⃣ Cotización gratis 📸\n` +
          `2️⃣ Agendar una visita 📅\n` +
          `3️⃣ Hablar con un asesor 💬\n` +
          `4️⃣ Tengo una duda ❓`
        );
      }
      break;
    }

    case 'menu_nombre_cita': {
      if (!bodyText || bodyText.trim().length < 2) {
        await send(from, `¿Podría indicarme su nombre, por favor? 😊`);
        break;
      }
      session.clientName = bodyText.trim();
      await send(from,
        `📅 ¡Con gusto, ${session.clientName}! Le esperamos en nuestras *oficinas en Monclova*. La reunión es *gratuita y sin compromiso* 🤝\n\n` +
        `¿Qué *día y horario* le viene bien? (ej: "martes a las 3pm", "mañana a las 10am")\n\n` +
        `🕐 *Nuestro horario de atención:*\n` +
        `Lunes a Viernes: 9:00 am a 7:00 pm\n` +
        `Sábados: 9:00 am a 1:30 pm\n` +
        `Domingos: cerrado`
      );
      session.state = 'scheduling';
      break;
    }

    case 'waiting_front': {
      if (!mediaId) {
        await send(from, `Con gusto le ayudo 😊 Para continuar, ¿podría compartirme una foto del *frente* de su recibo de CFE? 📸`);
        break;
      }
      session.frontMediaId = mediaId;
      await send(from,
        `✅ ¡Gracias! Ya recibí el frente del recibo.\n\n` +
        `📸 *Paso 2 de 2 — Foto del REVERSO del recibo*\n` +
        `¿Me podría compartir también una foto de la parte de atrás? Ahí suele estar el historial de consumo. 🙏`
      );
      session.state = 'waiting_back';
      break;
    }

    case 'waiting_back': {
      if (!mediaId) {
        await send(from, `Sólo me falta la foto del *reverso* de su recibo para completar el análisis 📸`);
        break;
      }
      session.state = 'analyzing';
      await send(from, `📊 Perfecto, muchas gracias. Estoy analizando su consumo eléctrico... ⏳\n\nEsto tomará solo unos segundos.`);

      try {
        const data = await analyzeBill(session.frontMediaId, mediaId);

        if (data.tipo === 'error') {
          await send(from,
            `Le pido una disculpa, no me fue posible extraer los datos del recibo 🙏\n\n_${data.mensaje}_\n\n` +
            `¿Podría intentarlo de nuevo con fotos más claras? Escriba *reiniciar* cuando esté listo/a.`
          );
          session.state = 'waiting_front';
          break;
        }

        session.billData = data;
        const { avg: avgKwh, relevant: relevantPeriodos } = calcAvgKwh(data.periodos, data.tipo);
        const pkg = recommendPackage(avgKwh, data.tipo);
        session.recommendation = pkg;

        const tipoLabel  = data.tipo === 'bimestral' ? 'bimestre' : 'mes';
        const days       = data.tipo === 'bimestral' ? 61 : 30.44;
        const produccion = Math.round(pkg.panels * PANEL_KWH_DAY * days);
        const historial  = data.periodos.map(p => `   • ${p.periodo}: *${Number(p.kwh).toLocaleString('es-MX')} kWh*`).join('\n');

        await send(from,
          `✅ *Análisis completado*\n\n` +
          `📋 *Historial de consumo (${data.tipo}):*\n${historial}\n\n` +
          `📊 Promedio: *${Math.round(avgKwh).toLocaleString('es-MX')} kWh* por ${tipoLabel}\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `☀️ *PROPUESTA SOLHARM PARA USTED*\n\n` +
          `🔆 *Paquete de ${pkg.panels} paneles solares*\n` +
          `⚡ Producción estimada: ~${produccion.toLocaleString('es-MX')} kWh por ${tipoLabel}\n` +
          `💰 Inversión: *${mxn(pkg.price)}*\n\n` +
          `Este sistema produciría *más* de lo que consume actualmente, llevando su factura de CFE prácticamente a *$0* 🎉`
        );
        await send(from,
          `Una pregunta adicional 😊\n\n` +
          `🔌 ¿Tiene planeado agregar aparatos eléctricos en el futuro? Por ejemplo: *minisplits, calentador eléctrico, vehículo eléctrico*.\n\n` +
          `¿*Sí* o *No*?`
        );
        session.state = 'asking_growth';

      } catch (err) {
        console.error('[analyzeBill error]', err.message);
        await send(from, `Le pido una disculpa, ocurrió un problema al procesar las fotos 🙏\n\nEscriba *reiniciar* para intentarlo de nuevo.`);
        session.state = 'waiting_front';
      }
      break;
    }

    case 'analyzing': {
      await send(from, `⏳ Todavía estoy procesando su recibo, por favor espere un momento más...`);
      break;
    }

    case 'asking_growth': {
      const yes = /s[ií]|claro|sip|por supuesto|planeamos|plan|tengo|queremos|quiero|piens|tal vez|quizá|posible/.test(text);
      const no  = /no\b|nop|por ahora no|de momento no|actualmente no|ninguno|ningún/.test(text);
      if (yes) {
        session.wantsGrowth = true;
        await send(from, `¡Perfecto! 😊 Para generarle su *cotización formal en PDF*, ¿me podría decir su nombre completo?`);
        session.state = 'waiting_nombre';
      } else if (no) {
        session.wantsGrowth = false;
        await send(from, `Entendido 🙏 Para generarle su *cotización formal en PDF*, ¿me podría decir su nombre completo?`);
        session.state = 'waiting_nombre';
      } else {
        await send(from, `¿Podría indicarme si tiene planeado agregar aparatos como minisplits o calentadores?\n\nSolo responda *Sí* o *No* 😊`);
      }
      break;
    }

    case 'waiting_nombre': {
      const useBillName = /recibo|factura|ya sale|ya aparece|ya viene|el mismo|la misma|ahí (sale|viene|está|aparece)|lo que dice/i.test(bodyText || '');
      if (useBillName && session.billData?.nombre_cliente) {
        session.clientName = session.billData.nombre_cliente;
        await send(from, `¡Perfecto! Usaré el nombre del recibo: *${session.clientName}* 😊\n\n¿Y su dirección o municipio?`);
        session.state = 'waiting_direccion';
        break;
      }
      if (!bodyText || bodyText.trim().length < 2) {
        await send(from, `¿Podría indicarme su nombre completo, por favor? 😊`);
        break;
      }
      session.clientName = bodyText.trim();
      await send(from, `Muchas gracias 😊\n\n¿Y su dirección o municipio? (ej: Col. Guadalupe, Monclova, Coahuila)\nO escriba *"recibo"* para usar la del recibo.`);
      session.state = 'waiting_direccion';
      break;
    }

    case 'waiting_direccion': {
      const useBillAddr = /recibo|factura|ya sale|ya aparece|ya viene|el mismo|la misma|ahí (sale|viene|está|aparece)|lo que dice/i.test(bodyText || '');
      if (useBillAddr && session.billData?.direccion_cliente) {
        session.clientAddress = session.billData.direccion_cliente;
      } else if (!bodyText || bodyText.trim().length < 2) {
        await send(from, `¿Podría indicarme su dirección o municipio? 😊`);
        break;
      } else {
        session.clientAddress = bodyText.trim();
      }

      await send(from, `⏳ Un momento, estoy generando su cotización en PDF...`);

      setImmediate(async () => {
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

          const pdfBuffer = await generateQuotePdf(pdfData);
          const filename  = `cotizacion-${crypto.randomBytes(6).toString('hex')}.pdf`;
          const filepath  = path.join(QUOTES_DIR, filename);
          fs.writeFileSync(filepath, pdfBuffer);

          const publicUrl = process.env.PUBLIC_URL;
          if (publicUrl) {
            const pdfUrl = `${publicUrl.replace(/\/$/, '')}/quotes/${filename}`;
            await send(from, `✅ *¡Su cotización está lista!* 📄\n\n${pdfUrl}\n\n_Válida por 7 días._`);
          } else {
            await send(from, `✅ *¡Su cotización ha sido generada!*\n\nUn asesor se la hará llegar a la brevedad. 📄`);
          }
        } catch (err) {
          console.error('[PDF error]', err.message);
          await send(from, `✅ Su cotización ha quedado registrada. Un asesor se la enviará directamente 📄`);
        }

        if (session.wantsGrowth) {
          await send(from,
            `Le recomendamos agendar una reunión en *nuestras oficinas en Monclova* donde un asesor hará una propuesta completa considerando todos los equipos que planea agregar 🤝\n\n` +
            `📅 ¿Qué día y horario le quedaría bien? ¿Prefiere *mañana* (9:00–13:00) o *tarde* (14:00–18:00)?`
          );
          session.state = 'scheduling';
        } else {
          await mostrarMenu(from);
        }
      });
      break;
    }

    case 'followup': {
      const rec = session.recommendation;
      if (/pago|financ|precio|costo|cuánt|cuant|adelanto|cuota|crédito|credito|meses|abono/.test(text)) {
        const adelanto    = Math.round(rec.price * 0.50);
        const instalacion = Math.round(rec.price * 0.45);
        const medidor     = Math.round(rec.price * 0.05);
        await send(from,
          `💳 *Esquema de pagos SOLHARM*\n\n` +
          `Paquete de *${rec.panels} paneles* — ${mxn(rec.price)}:\n\n` +
          `1️⃣ *50% adelanto:* ${mxn(adelanto)}\n` +
          `2️⃣ *45% al instalar:* ${mxn(instalacion)}\n` +
          `3️⃣ *5% al cambio de medidor:* ${mxn(medidor)}`
        );
      } else if (/instal|tiempo|cuándo|cuando|demor|tarda|medidor|proceso|días|dias|semana/.test(text)) {
        await send(from,
          `🔧 *Proceso de instalación SOLHARM*\n\n` +
          `⚡ Instalación: *1 día*\n` +
          `⏳ Cambio de medidor CFE: *2 a 2.5 meses*\n\n` +
          `⚠️ El sistema funciona hasta que CFE cambie el medidor bidireccional.`
        );
      } else if (/visit|agenda|cita|fecha|hora|técnic|tecnic|gratis|ofic|asesor|reuni/.test(text)) {
        await send(from,
          `📅 ¡Con gusto! Le esperamos en nuestras *oficinas en Monclova*. La reunión es *gratuita y sin compromiso* 🤝\n\n` +
          `¿Qué *fecha* le vendría bien y prefiere *mañana* o *tarde*?`
        );
        session.state = 'scheduling';
      } else if (/paquete|opcion|opción|todos|panel|otro|lista/.test(text)) {
        const list = PACKAGES.map(p => `${p.panels === rec?.panels ? '👉' : '  '} *${p.panels} paneles* — ${mxn(p.price)}`).join('\n');
        await send(from, `☀️ *Paquetes SOLHARM*\n\n${list}\n\n👉 = recomendado para usted`);
      } else {
        const faqAnswer = detectarFAQ(text);
        if (faqAnswer) {
          await send(from, faqAnswer);
        } else {
          await send(from,
            `Con gusto le oriento ☀️\n\n` +
            `💳 *"pagos"* · 🔧 *"instalación"* · ☀️ *"paquetes"* · 📅 *"reunión"*\n\n` +
            `O escriba *reiniciar* para analizar otro recibo.`
          );
        }
      }
      break;
    }

    case 'scheduling': {
      const fechaIntento = parseDateTime(bodyText || '');
      console.log('[SCHEDULING] entré al case, agendando cita');

      if (!fechaIntento) {
        await send(from,
          `No entendí bien la fecha y hora 😊 ¿Podría indicarme algo como:\n\n` +
          `"martes a las 3pm"\n"mañana a las 10am"\n"viernes 11:30am"`
        );
        break;
      }

      if (!esDentroDeHorario(fechaIntento)) {
        await send(from,
          `Lo siento, ese horario está fuera de nuestro horario de atención 😊\n\n` +
          `📅 *Horario SOLHARM:*\n` +
          `Lunes a viernes: 9:00am — 7:00pm\n` +
          `Sábados: 9:00am — 1:30pm\n` +
          `Domingos: Cerrado\n\n` +
          `¿Qué otro horario le viene bien?`
        );
        break;
      }

      const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
      const diaNotif   = dias[fechaIntento.getDay()];
      const fechaNotif = fechaIntento.toLocaleDateString('es-MX', { day: 'numeric', month: 'long' });
      const horaNotif  = fechaIntento.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true });

      // ── 1. Google Calendar (solo verificar + agendar) ─────────────────────
      let citaAgendada = false;

      try {
        const disponible = await verificarDisponibilidad(fechaIntento);

        if (!disponible) {
          const siguiente = new Date(fechaIntento.getTime() + 60 * 60 * 1000);
          const anterior  = new Date(fechaIntento.getTime() - 60 * 60 * 1000);
          const fmtAlt    = (d) => d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true });
          await send(from,
            `Lo siento, ese horario ya está reservado 😊\n\n` +
            `¿Le parece bien a las *${fmtAlt(anterior)}* o a las *${fmtAlt(siguiente)}*?`
          );
          break;
        }

        await agendarCita(fechaIntento, session.clientName, from);
        citaAgendada = true;

      } catch (err) {
        console.error('[Calendar error]', err.message, err.response?.data);
        await send(from,
          `✅ *¡Su cita ha quedado registrada!*\n\n` +
          `Un asesor confirmará los detalles a la brevedad 🤝`
        );
        await mostrarMenu(from);
      }

      // ── 2. Confirmación al cliente (fuera del try del calendario) ─────────
      if (citaAgendada) {
        await send(from,
          `✅ *¡Cita agendada exitosamente!*\n\n` +
          `📅 *${diaNotif} ${fechaNotif} a las ${horaNotif}*\n` +
          `👤 ${session.clientName}\n\n` +
          `📍 Calle Arquímedes 1313, Tecnológico, 25716, Monclova, Coah., México\n` +
          `🗺️ Cómo llegar: https://www.google.com/maps/search/?api=1&query=26.9226112,-101.4363564\n\n` +
          `¡Gracias por su confianza!`
        );
        await mostrarMenu(from);
      }

      // ── 3. Notificación al dueño (independiente de todo lo anterior) ──────
      console.log('[SCHEDULING] citaAgendada =', citaAgendada);
      if (citaAgendada) {
        try {
          const NUMERO_PAPA = '528666388384';
          await axios.post(
            `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
            {
              messaging_product: 'whatsapp',
              to: NUMERO_PAPA,
              type: 'template',
              template: {
                name: 'aviso_nueva_cita',
                language: { code: 'es_MX' },
                components: [{
                  type: 'body',
                  parameters: [
                    { type: 'text', text: `${diaNotif} ${fechaNotif}` },
                    { type: 'text', text: horaNotif },
                    { type: 'text', text: session.clientName },
                  ],
                }],
              },
            },
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
          );
          console.log('[Notif dueño] plantilla enviada OK');
        } catch (err) {
          console.error('[Notif dueño error]', err.message, err.response?.data);
        }
      }

      break;
    }
    case 'done': {
      const faqAnswer = detectarFAQ(text);
      if (faqAnswer) {
        await send(from, faqAnswer);
      } else {
        await send(from, `¡Hola de nuevo! 😊 Escriba *hola* para iniciar una nueva consulta con *SOLHARM Energía Solar* ☀️`);
      }
      break;
    }

    default: {
      sessions.set(from, { state: 'greeting' });
      await handleIncoming(from, bodyText, mediaId);
    }
  }
}
// ─── Google Calendar OAuth ────────────────────────────────────────────────────

const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Cargar tokens si existen en variables de entorno
if (process.env.GOOGLE_TOKENS) {
  oauth2Client.setCredentials(JSON.parse(process.env.GOOGLE_TOKENS));
}

app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    console.log('GOOGLE_TOKENS=' + JSON.stringify(tokens));
    res.send('✅ Autorización exitosa. Copia el token de los logs de Railway y agrégalo como variable GOOGLE_TOKENS.');
  } catch (err) {
    res.send('❌ Error: ' + err.message);
  }
});// ─── Google Calendar funciones ────────────────────────────────────────────────

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const HORARIO = {
  lunes: { inicio: 9, fin: 19 },
  martes: { inicio: 9, fin: 19 },
  miércoles: { inicio: 9, fin: 19 },
  jueves: { inicio: 9, fin: 19 },
  viernes: { inicio: 9, fin: 19 },
  sábado: { inicio: 9, fin: 13.5 },
  domingo: null,
};

function parseDateTime(texto) {
  const dias = { lunes:1, martes:2, miércoles:3, jueves:4, viernes:5, sábado:6, sabado:6, domingo:0, domigo:0 };
  const meses = { enero:0, febrero:1, marzo:2, abril:3, mayo:4, junio:5, julio:6, agosto:7, septiembre:8, octubre:9, noviembre:10, diciembre:11 };
  
  const t = texto.toLowerCase();
  const ahora = new Date();
  let fecha = null;
  let hora = null;

  // Detectar hora (2pm, 14:00, 2:30pm, etc)
  const horaMatch = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (horaMatch) {
    let h = parseInt(horaMatch[1]);
    const m = parseInt(horaMatch[2] || '0');
    const ampm = horaMatch[3];
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    hora = { h, m };
  }

  // Detectar día de la semana
  for (const [dia, num] of Object.entries(dias)) {
    if (t.includes(dia)) {
      const hoy = ahora.getDay();
      let diff = num - hoy;
      if (diff <= 0) diff += 7;
      fecha = new Date(ahora);
      fecha.setDate(ahora.getDate() + diff);
      break;
    }
  }

  // Detectar "mañana" o "hoy"
  if (t.includes('mañana')) {
    fecha = new Date(ahora);
    fecha.setDate(ahora.getDate() + 1);
  } else if (t.includes('hoy')) {
    fecha = new Date(ahora);
  }

  if (!fecha || !hora) return null;

  fecha.setHours(hora.h, hora.m, 0, 0);
  return fecha;
}

function esDentroDeHorario(fecha) {
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const dia = dias[fecha.getDay()];
  const horario = HORARIO[dia];
  if (!horario) return false;
  const horaDecimal = fecha.getHours() + fecha.getMinutes() / 60;
  return horaDecimal >= horario.inicio && horaDecimal + 1 <= horario.fin;
}

async function verificarDisponibilidad(inicio) {
  const fin = new Date(inicio.getTime() + 60 * 60 * 1000);
  const res = await google.calendar({version:'v3', auth: oauth2Client}).events.list({
    calendarId: CALENDAR_ID,
    timeMin: inicio.toISOString(),
    timeMax: fin.toISOString(),
    singleEvents: true,
  });
  return res.data.items.length === 0;
}

async function agendarCita(inicio, nombre, telefono) {
  const fin = new Date(inicio.getTime() + 60 * 60 * 1000);
  const event = {
    summary: `Cita SOLHARM — ${nombre}`,
    description: `Cliente: ${nombre}\nTeléfono: ${telefono}`,
    start: { dateTime: inicio.toISOString(), timeZone: 'America/Monterrey' },
    end: { dateTime: fin.toISOString(), timeZone: 'America/Monterrey' },
  };
  await google.calendar({version:'v3', auth: oauth2Client}).events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event,
  });
}
// ─── Rutas ────────────────────────────────────────────────────────────────────

// Verificación del webhook (Meta lo llama una vez para verificar)
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Recepción de mensajes
app.post('/webhook', async (req, res) => {
  res.status(200).end();
  try {
    const entry   = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const message = value?.messages?.[0];
    if (!message) return;

    const from      = message.from;
    const bodyText  = message.text?.body || '';
    const mediaId   = message.image?.id || message.document?.id || null;

    await handleIncoming(from, bodyText, mediaId);
  } catch (err) {
    console.error('[webhook error]', err);
  }
});

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'SOLHARM WhatsApp Bot - Meta API' })
);

// ─── Servidor ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🌞 SOLHARM Bot (Meta API) escuchando en puerto ${PORT}`)
);