require('dotenv').config();
const express   = require('express');
const twilio    = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const axios     = require('axios');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const { generateQuotePdf } = require('./quote');

const QUOTES_DIR = path.join(__dirname, 'quotes');
if (!fs.existsSync(QUOTES_DIR)) fs.mkdirSync(QUOTES_DIR);

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/quotes', express.static(QUOTES_DIR));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Catálogo de paquetes ────────────────────────────────────────────────────

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

// ─── Sesiones en memoria ─────────────────────────────────────────────────────

const sessions = new Map();

function getSession(from) {
  if (!sessions.has(from)) sessions.set(from, { state: 'greeting' });
  return sessions.get(from);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mxn(amount) {
  return `$${amount.toLocaleString('es-MX')} MXN`;
}

function recommendPackage(avgKwh, tipo) {
  // Bimestral: 6 bimestres = 1 año → consumo diario = promedio_bimestral * 6 / 365
  // Mensual: consumo diario = promedio_mensual / 30.44
  const dailyKwh = tipo === 'bimestral'
    ? (avgKwh * 6) / 365
    : avgKwh / 30.44;
  const rawPanels = dailyKwh / PANEL_KWH_DAY;
  const pkg = PACKAGES.find(p => p.panels > rawPanels) || PACKAGES[PACKAGES.length - 1];
  return { ...pkg, rawPanels, dailyKwh };
}

// ─── Análisis de recibo con Claude Vision ────────────────────────────────────

async function downloadImage(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN },
    timeout: 20000,
  });
  return {
    base64: Buffer.from(res.data).toString('base64'),
    mediaType: (res.headers['content-type'] || 'image/jpeg').split(';')[0],
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
  '- Extrae la TARIFA CFE (ejemplos: "1D", "DAC", "2", "3"). Aparece generalmente en el encabezado o datos del cliente del recibo.\n' +
  '- Extrae el NOMBRE del titular tal como aparece en el recibo (ej: "GONZALEZ PALMA MARIA TERESA").\n' +
  '- Extrae la DIRECCIÓN o colonia/municipio del titular (ej: "Col. Los Alamos, Monclova, Coah").\n' +
  '- Si algún número es dudoso, usa tu mejor estimación; NO devuelvas error por incertidumbre menor.\n' +
  '- Solo devuelve error si la imagen es completamente ilegible, no es un recibo de CFE, o es imposible extraer cualquier kWh.\n\n' +
  'Responde ÚNICAMENTE con JSON válido:\n' +
  '{\n' +
  '  "tipo": "bimestral" | "mensual",\n' +
  '  "tarifa": "tarifa CFE (ej: 1D, DAC, 2, 3) o null si no se ve",\n' +
  '  "nombre_cliente": "nombre del titular o null",\n' +
  '  "direccion_cliente": "colonia y municipio o null",\n' +
  '  "periodos": [ { "periodo": "ej: Ene-Feb 2024", "kwh": número } ],\n' +
  '  "promedio_kwh": número\n' +
  '}\n\n' +
  'Solo si es IMPOSIBLE extraer datos:\n' +
  '{ "tipo": "error", "mensaje": "razón concreta" }';

async function analyzeBill(frontUrl, backUrl = null) {
  const isTwoSided = !!backUrl;

  // Descargar imágenes
  const images = await Promise.all(
    [frontUrl, backUrl].filter(Boolean).map(downloadImage)
  );

  const imageBlocks = images.map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
  }));

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

  const raw = response.content[0].text.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude no devolvió JSON válido');
  return JSON.parse(match[0]);
}

// ─── Envío de mensajes ────────────────────────────────────────────────────────

async function send(to, body) {
  await twilioClient.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    to,
    body,
  });
}

// ─── Lógica de conversación ───────────────────────────────────────────────────

async function handleIncoming(from, bodyText, mediaUrl) {
  const session = getSession(from);
  const text = (bodyText || '').toLowerCase().trim();

  // Reinicio en cualquier momento
  const resetWords = ['hola', 'inicio', 'iniciar', 'reiniciar', 'nuevo', 'empezar', 'start', 'menu', 'menú', 'buenas', 'buenos'];
  if (resetWords.includes(text) && session.state !== 'greeting') {
    sessions.set(from, { state: 'greeting' });
    session.state = 'greeting';
  }

  switch (session.state) {

    // ── 1. Saludo inicial ──────────────────────────────────────────────────
    case 'greeting': {
      await send(from,
        `¡Hola! 👋 Bienvenido/a a *SOLHARM Energía Solar* ☀️\n\n` +
        `Es un gusto atenderle. Somos especialistas en sistemas fotovoltaicos y con mucho gusto le ayudamos a encontrar el sistema ideal para su hogar o negocio.\n\n` +
        `Para prepararle una cotización *personalizada y completamente gratuita*, nos ayudaría mucho analizar su recibo de luz de CFE.\n\n` +
        `📸 *Paso 1 de 2 — Foto del FRENTE del recibo*\n` +
        `¿Podría compartirme una foto de la parte frontal de su recibo? 😊`
      );
      session.state = 'waiting_front';
      break;
    }

    // ── 2. Esperando foto del frente ──────────────────────────────────────
    case 'waiting_front': {
      if (!mediaUrl) {
        await send(from,
          `Con gusto le ayudo 😊 Para continuar, ¿podría compartirme una foto del *frente* de su recibo de CFE? 📸\n\n` +
          `Con eso podré calcular su cotización personalizada.`
        );
        break;
      }
      session.frontUrl = mediaUrl;
      await send(from,
        `✅ ¡Gracias! Ya recibí el frente del recibo.\n\n` +
        `📸 *Paso 2 de 2 — Foto del REVERSO del recibo*\n` +
        `¿Me podría compartir también una foto de la parte de atrás? Ahí suele estar el historial de consumo que necesitamos. 🙏`
      );
      session.state = 'waiting_back';
      break;
    }

    // ── 3. Esperando foto del reverso ─────────────────────────────────────
    case 'waiting_back': {
      if (!mediaUrl) {
        await send(from,
          `Sólo me falta la foto del *reverso* de su recibo para completar el análisis 📸\n\n` +
          `¿Podría compartírmela cuando guste?`
        );
        break;
      }

      session.state = 'analyzing';
      await send(from, `📊 Perfecto, muchas gracias. Estoy analizando su consumo eléctrico... ⏳\n\nEsto tomará solo unos segundos, por favor espere un momento.`);

      try {
        const data = await analyzeBill(session.frontUrl, mediaUrl);

        if (data.tipo === 'error') {
          await send(from,
            `Le pido una disculpa, no me fue posible extraer los datos de consumo del recibo 🙏\n\n` +
            `_${data.mensaje}_\n\n` +
            `¿Podría intentarlo de nuevo con fotos un poco más claras? Escriba *reiniciar* cuando esté listo/a.`
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

        const historial = data.periodos
          .map(p => `   • ${p.periodo}: *${Number(p.kwh).toLocaleString('es-MX')} kWh*`)
          .join('\n');

        await send(from,
          `✅ *Análisis completado*\n\n` +
          `📋 *Historial de consumo (${data.tipo}):*\n${historial}\n\n` +
          `📊 Promedio: *${Math.round(data.promedio_kwh).toLocaleString('es-MX')} kWh* por ${tipoLabel}\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `☀️ *PROPUESTA SOLHARM PARA USTED*\n\n` +
          `🔆 *Paquete de ${pkg.panels} paneles solares*\n` +
          `⚡ Producción estimada: ~${produccion.toLocaleString('es-MX')} kWh por ${tipoLabel}\n` +
          `💰 Inversión: *${mxn(pkg.price)}*\n\n` +
          `Este sistema produciría *más* de lo que consume actualmente, lo que llevaría su factura de CFE prácticamente a *$0* 🎉`
        );
        await send(from,
          `Una pregunta adicional que nos ayuda a afinar mejor su propuesta 😊\n\n` +
          `🔌 ¿Tiene planeado agregar aparatos eléctricos en el futuro? Por ejemplo: *minisplits, calentador de agua eléctrico, vehículo eléctrico* u otros equipos de mayor consumo.\n\n` +
          `¿*Sí* o *No*?`
        );
        session.state = 'asking_growth';

      } catch (err) {
        console.error('[analyzeBill error]', err.message);
        await send(from,
          `Le pido una disculpa, ocurrió un problema al procesar las fotos 🙏\n\n` +
          `Por favor escriba *reiniciar* para intentarlo de nuevo.`
        );
        session.state = 'waiting_front';
      }
      break;
    }

    // ── 4. Mensaje durante análisis ───────────────────────────────────────
    case 'analyzing': {
      await send(from, `⏳ Todavía estoy procesando su recibo, por favor espere un momento más...`);
      break;
    }

    // ── 5. Pregunta sobre crecimiento futuro ──────────────────────────────
    case 'asking_growth': {
      const yes = /s[ií]|claro|sip|por supuesto|planeamos|plan|tengo|queremos|quiero|piens|tal vez|quizá|posible/.test(text);
      const no  = /no\b|nop|por ahora no|de momento no|actualmente no|ninguno|ningún/.test(text);

      if (yes) {
        session.wantsGrowth = true;
        await send(from,
          `¡Perfecto, qué bueno saberlo! 😊 Eso es algo muy importante que tomaremos en cuenta al preparar su propuesta.\n\n` +
          `Para generarle su *cotización formal en PDF*, ¿me podría decir su nombre completo?`
        );
        session.state = 'waiting_nombre';
      } else if (no) {
        session.wantsGrowth = false;
        await send(from,
          `Entendido, muchas gracias 🙏\n\n` +
          `Para generarle su *cotización formal en PDF*, ¿me podría decir su nombre completo?`
        );
        session.state = 'waiting_nombre';
      } else {
        await send(from,
          `Disculpe, ¿podría indicarme si tiene planeado agregar aparatos eléctricos como minisplits o calentadores en el futuro?\n\n` +
          `Solo responda *Sí* o *No* 😊`
        );
      }
      break;
    }

    // ── 6. Recopilando nombre del cliente ─────────────────────────────────
    case 'waiting_nombre': {
      const useBillName = /recibo|factura|ya sale|ya aparece|ya viene|el mismo|la misma|ahí (sale|viene|está|aparece)|lo que dice|el que (sale|aparece|viene)/i.test(bodyText || '');
      if (useBillName && session.billData?.nombre_cliente) {
        session.clientName = session.billData.nombre_cliente;
        const firstName = session.clientName.split(' ').pop(); // last word = first name in Mexican format
        await send(from,
          `¡Perfecto! Usaré el nombre del recibo: *${session.clientName}* 😊\n\n` +
          `¿Y su dirección o municipio? (o escriba *"recibo"* si quiere usar la del recibo)`
        );
        session.state = 'waiting_direccion';
        break;
      }
      if (!bodyText || bodyText.trim().length < 2) {
        await send(from, `¿Podría indicarme su nombre completo, por favor? 😊`);
        break;
      }
      session.clientName = bodyText.trim();
      await send(from,
        `Muchas gracias, ${session.clientName.split(' ')[0]} 😊\n\n` +
        `¿Y su dirección o municipio? (ej: Col. Guadalupe, Monclova, Coahuila)\n` +
        `O escriba *"recibo"* si quiere usar la dirección que aparece en el recibo.`
      );
      session.state = 'waiting_direccion';
      break;
    }

    // ── 7. Recopilando dirección y generando PDF ───────────────────────────
    case 'waiting_direccion': {
      const useBillAddr = /recibo|factura|ya sale|ya aparece|ya viene|el mismo|la misma|ahí (sale|viene|está|aparece)|lo que dice|el que (sale|aparece|viene)/i.test(bodyText || '');
      if (useBillAddr && session.billData?.direccion_cliente) {
        session.clientAddress = session.billData.direccion_cliente;
      } else if (!bodyText || bodyText.trim().length < 2) {
        await send(from, `¿Podría indicarme su dirección o municipio? 😊`);
        break;
      } else {
        session.clientAddress = bodyText.trim();
      }

      await send(from, `⏳ Un momento por favor, estoy generando su cotización en PDF...`);

      // Generate PDF asynchronously (don't block the response)
      setImmediate(async () => {
        try {
          const billData = session.billData || {};
          const rec      = session.recommendation;
          const pdfData  = {
            nombre:      session.clientName,
            direccion:   session.clientAddress,
            tarifa:      billData.tarifa || '',
            periodos:    billData.periodos || [],
            promedio_kwh: billData.promedio_kwh || 0,
            tipo:        billData.tipo || 'mensual',
            panels:      rec.panels,
            price:       rec.price,
          };

          const pdfBuffer  = await generateQuotePdf(pdfData);
          const filename   = `cotizacion-${crypto.randomBytes(6).toString('hex')}.pdf`;
          const filepath   = path.join(QUOTES_DIR, filename);
          fs.writeFileSync(filepath, pdfBuffer);

          const publicUrl = process.env.PUBLIC_URL;
          if (publicUrl) {
            const pdfUrl = `${publicUrl.replace(/\/$/, '')}/quotes/${filename}`;
            await send(from,
              `✅ *¡Su cotización está lista!* 📄\n\n` +
              `Aquí tiene su propuesta formal SOLHARM:\n${pdfUrl}\n\n` +
              `_Válida por 7 días a partir de hoy._`
            );
          } else {
            await send(from,
              `✅ *¡Su cotización ha sido generada!*\n\n` +
              `Uno de nuestros asesores se la hará llegar a la brevedad. 📄`
            );
            console.log(`[PDF] Guardado en: ${filepath}`);
          }
        } catch (err) {
          console.error('[PDF error]', err.message);
          await send(from,
            `✅ Su cotización ha quedado registrada. Un asesor se la enviará directamente 📄`
          );
        }

        // After PDF: invite to office if wantsGrowth, else go to followup menu
        if (session.wantsGrowth) {
          await send(from,
            `Le recomendamos agendar una reunión en nuestras oficinas *SOLHARM* en la *Col. Tecnológico*, ` +
            `donde uno de nuestros asesores hará una cotización completa considerando todos los equipos que planea agregar 🤝\n\n` +
            `📅 ¿Qué día y horario le quedaría bien?\n` +
            `¿Prefiere por la *mañana* (9:00–13:00) o por la *tarde* (14:00–18:00)?`
          );
          session.state = 'scheduling';
        } else {
          await send(from,
            `Si en algún momento desea ampliar su sistema, con gusto lo ajustamos. ` +
            `También le invitamos a visitarnos en la *Col. Tecnológico* cuando guste 😊\n\n` +
            `¿Hay algo más en lo que pueda orientarle?\n` +
            `💳 *Pagos*  ·  🔧 *Instalación*  ·  📅 *Reunión en oficinas*`
          );
          session.state = 'followup';
        }
      });

      break;
    }

    // ── 8. Seguimiento post-recomendación ─────────────────────────────────
    case 'followup': {
      const rec = session.recommendation;

      if (/pago|financ|precio|costo|cuánt|cuant|adelanto|cuota|crédito|credito|meses|abono/.test(text)) {

        const adelanto    = Math.round(rec.price * 0.50);
        const instalacion = Math.round(rec.price * 0.45);
        const medidor     = Math.round(rec.price * 0.05);

        await send(from,
          `💳 *Esquema de pagos SOLHARM*\n\n` +
          `Para su paquete de *${rec.panels} paneles* — ${mxn(rec.price)}, el pago se divide en tres etapas muy cómodas:\n\n` +
          `1️⃣ *50% — Adelanto al confirmar su pedido*\n   ${mxn(adelanto)}\n\n` +
          `2️⃣ *45% — Al momento de instalar los paneles*\n   ${mxn(instalacion)}\n\n` +
          `3️⃣ *5% — Al cambio de medidor por CFE*\n   ${mxn(medidor)}\n\n` +
          `Si gusta, con mucho gusto le recibimos en nuestras oficinas para platicar con más detalle sobre su propuesta 🤝`
        );

      } else if (/instal|tiempo|cuándo|cuando|demor|tarda|medidor|proceso|días|dias|semana/.test(text)) {

        await send(from,
          `🔧 *Proceso de instalación SOLHARM*\n\n` +
          `⚡ *Instalación del sistema solar: 1 día*\n` +
          `Nuestro equipo realiza la instalación completa en un solo día hábil, con todo el cuidado que su hogar merece.\n\n` +
          `⏳ *Cambio de medidor CFE: 2 a 2.5 meses*\n` +
          `Una vez instalados los paneles, iniciamos el trámite ante CFE para el medidor bidireccional. ` +
          `Este proceso depende directamente de CFE y toma entre 2 y 2.5 meses aproximadamente.\n\n` +
          `⚠️ *Importante:* el sistema comienza a funcionar hasta que CFE realice el cambio de medidor bidireccional. ` +
          `No es posible utilizarlo antes de ese momento.\n\n` +
          `¿Le gustaría venir a nuestras oficinas para platicar con más detalle? Con gusto le atendemos 😊`
        );

      } else if (/visit|agenda|cita|fecha|hora|técnic|tecnic|gratis|ofic|asesor|reuni/.test(text)) {

        await send(from,
          `📅 *Reunión en oficinas SOLHARM*\n\n` +
          `¡Qué gusto! Le invitamos cordialmente a nuestras oficinas en la *Col. Tecnológico*, donde uno de nuestros asesores le explicará su propuesta personalizada con toda la calma del mundo.\n\n` +
          `La reunión es completamente *gratuita y sin ningún compromiso* 🤝\n\n` +
          `¿Podría indicarme su disponibilidad?\n` +
          `📆 ¿Qué *fecha* le vendría bien? (ej: martes 20 de mayo)\n` +
          `🕐 ¿Prefiere por la *mañana* (9:00–13:00) o por la *tarde* (14:00–18:00)?`
        );
        session.state = 'scheduling';

      } else if (/paquete|opcion|opción|todos|panel|otro|lista/.test(text)) {

        const list = PACKAGES
          .map(p => `${p.panels === rec?.panels ? '👉' : '  '} *${p.panels} paneles* — ${mxn(p.price)}`)
          .join('\n');

        await send(from,
          `☀️ *Paquetes disponibles SOLHARM*\n\n${list}\n\n` +
          `El paquete señalado con 👉 es el que le recomendamos según su consumo.\n\n` +
          `¿Puedo orientarle sobre *pagos*, *instalación* o le gustaría *reunirse con un asesor*?`
        );

      } else {

        await send(from,
          `Con gusto le oriento ☀️ Puede preguntarme sobre:\n\n` +
          `💳 *"pagos"* — Esquema de pago en 3 cómodas etapas\n` +
          `🔧 *"instalación"* — Tiempos y proceso\n` +
          `☀️ *"paquetes"* — Ver todos los paquetes disponibles\n` +
          `📅 *"reunión"* — Visítenos en nuestras oficinas (Col. Tecnológico)\n\n` +
          `O si lo prefiere, escriba *reiniciar* para analizar otro recibo.`
        );
      }
      break;
    }

    // ── 6. Agendando reunión ───────────────────────────────────────────────
    case 'scheduling': {
      await send(from,
        `✅ *¡Muchas gracias! Su cita ha quedado registrada.*\n\n` +
        `📋 Preferencia: _${bodyText}_\n\n` +
        `Uno de nuestros asesores de *SOLHARM* (Col. Tecnológico) se pondrá en contacto con usted en las próximas horas para confirmar la reunión. 🤝☀️\n\n` +
        `¡Gracias por su confianza! Estamos a sus órdenes para cualquier duda. 🌞`
      );
      session.state = 'done';
      break;
    }

    // ── 7. Conversación finalizada ────────────────────────────────────────
    case 'done': {
      await send(from,
        `¡Hola de nuevo! 😊 Es un gusto saludarle.\n\n` +
        `¿En qué más puedo ayudarle? Escriba *hola* cuando guste para iniciar una nueva consulta con *SOLHARM Energía Solar* ☀️`
      );
      break;
    }

    default: {
      sessions.set(from, { state: 'greeting' });
      await handleIncoming(from, bodyText, mediaUrl);
    }
  }
}

// ─── Rutas ────────────────────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  res.status(200).end();

  const from     = req.body.From;
  const body     = req.body.Body;
  const mediaUrl = req.body.MediaUrl0;

  if (!from) return;

  try {
    await handleIncoming(from, body, mediaUrl);
  } catch (err) {
    console.error('[webhook error]', err);
  }
});

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'SOLHARM WhatsApp Bot' })
);

// ─── Servidor ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🌞 SOLHARM Bot escuchando en puerto ${PORT}`)
);
