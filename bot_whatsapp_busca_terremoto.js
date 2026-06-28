/**
 * Bot de atención 1:1 con Baileys (Node.js, SIN Meta) + PostgreSQL.
 *
 * Igual que la versión anterior, pero los datos salen de PostgreSQL en
 * vez de un objeto en memoria. PostgreSQL es la fuente de verdad: editas
 * la tabla y el bot se actualiza solo (refresca su caché cada 5 minutos).
 *
 * ⚠️  Sigue siendo NO oficial y va contra los ToS de WhatsApp. Usa un
 *     número DEDICADO y responde solo a quien escribe primero.
 *
 * ────────────────────────────────────────────────────────────────────
 * 1) INSTALACIÓN
 * ────────────────────────────────────────────────────────────────────
 *   npm init -y
 *   npm pkg set type=module
 *   npm install @whiskeysockets/baileys @hapi/boom pino qrcode-terminal pg
 *
 * ────────────────────────────────────────────────────────────────────
 * 3) EJECUCIÓN
 * ────────────────────────────────────────────────────────────────────
 *   export DATABASE_URL="postgres://usuario:clave@localhost:5432/mi_base"
 *   node bot-whatsapp-baileys-postgres.js
 *
 *   La primera vez aparece un QR en la terminal; escanéalo desde el
 *   número dedicado (WhatsApp > Dispositivos vinculados > Vincular).
 */

import 'dotenv/config';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import P from 'pino'
import qrcode from 'qrcode-terminal'
//import pg from 'pg'

//const { Pool } = pg

// ----------------------------------------------------------------------
// Conexión a PostgreSQL
// ----------------------------------------------------------------------
//const pool = new Pool({
//  connectionString: process.env.DATABASE_URL,
//  ssl: false,
//});
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

// Caché en memoria de las personas (fuente de verdad = PostgreSQL).
// Se recarga al inicio y cada 5 minutos.
let cache = []

async function cargarPersonas() {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM hospitales'
    )
    //cache = rows.map(r => ({ ...r, norm: normalizar(r.nombre) }))
    cache = rows.map(r => {
      const norm = normalizar(r.apellidos_y_nombres)
      return {
        ...r,
        norm,
        tokens: norm.split(/\s+/).filter(Boolean),   // nombre partido en palabras
        cedulaNorm: normalizarCedula(r.cedula || ''), // cedula solo con digitos
      }
    })
    console.log(`📇 ${cache.length} personas cargadas desde PostgreSQL`)
  } catch (err) {
    console.error('Error al consultar PostgreSQL:', err.message)
  }
}

// ----------------------------------------------------------------------
// Palabras de relleno (no son nombres)
// ----------------------------------------------------------------------
const RELLENO = new Set([
  'info','informacion','datos','dato','dame','dime','quiero','saber','sobre',
  'de','del','la','el','los','las','un','una','quien','es','cuentame','muestra',
  'muestrame','busca','buscar','necesito','ver','acerca','porfa','porfavor','por',
  'favor','gracias','hola','buenas','que','tienes','hay','alguien','persona','me',
  'puedes','podrias','dar','traeme','y','con','a','tu','su',
])

// ----------------------------------------------------------------------
// Comprensión de lenguaje natural (reglas + coincidencia difusa)
// ----------------------------------------------------------------------
function normalizar(texto) {
  return texto
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
}

// Deja solo digitos (y la 'k' del digito verificador de RUT, si aplica)
function normalizarCedula(texto) {
  return texto.toLowerCase().replace(/[^0-9k]/g, '')
}

// El usuario escribio una cedula? (solo numeros, con o sin puntos/guiones)
function pareceCedula(texto) {
  const limpio = texto.toLowerCase().replace(/[\s.\-]/g, '')
  return /^\d{5,}k?$/.test(limpio)
}

// Similitud 0..1 por distancia de Levenshtein (tolera typos)
function similitud(a, b) {
  if (a === b) return 1
  const m = a.length, n = b.length
  if (m === 0 || n === 0) return 0
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + costo)
    }
  }
  return 1 - dp[m][n] / Math.max(m, n)
}

/*function buscarPersona(texto, umbral = 0.75) {
  const palabras = normalizar(texto).split(/\s+/).filter(p => p && !RELLENO.has(p))
  let mejor = null, score = 0
  for (const p of palabras) {
    for (const persona of cache) {
      const r = similitud(p, persona.norm)
      if (r > score) { mejor = persona; score = r }
    }
  }
  return score >= umbral ? mejor : null
}*/


// ----------------------------------------------------------------------
// Busqueda por NOMBRE (por palabras, en cualquier orden, parcial)
// ----------------------------------------------------------------------
function tokenCalza(qt, nameTokens) {
  let best = 0
  for (const nt of nameTokens) {
    let s = 0
    if (nt === qt) s = 1
    else if (qt.length >= 3 && (nt.startsWith(qt) || qt.startsWith(nt))) s = 0.95
    else if (qt.length >= 3 && (nt.includes(qt) || qt.includes(nt)))    s = 0.9
    else s = similitud(qt, nt)
    if (s > best) best = s
  }
  return best
}
 
function buscarPorNombre(texto, umbralToken = 0.7) {
  const qTokens = normalizar(texto).split(/\s+/).filter(Boolean)
  if (qTokens.length === 0) return []
 
  const resultados = []
  for (const p of cache) {
    const scores = qTokens.map(qt => tokenCalza(qt, p.tokens))
    // Cada palabra escrita debe calzar con alguna palabra del nombre
    if (scores.every(s => s >= umbralToken)) {
      const score = scores.reduce((a, b) => a + b, 0) / scores.length
      resultados.push({ persona: p, score })
    }
  }
  resultados.sort((a, b) => b.score - a.score)
  return resultados.map(r => r.persona)
}
 
// ----------------------------------------------------------------------
// Busqueda por CEDULA (coincidencia exacta con el campo cedula)
// ----------------------------------------------------------------------
function buscarPorCedula(texto) {
  const q = normalizarCedula(texto)
  if (!q) return []
  return cache.filter(p => p.cedulaNorm === q)
}
 
// ----------------------------------------------------------------------
// Respuesta
// ----------------------------------------------------------------------
function ficha(p) {
  return (
    `----- Registro ----- \n` +
    `*Hospital:* ${p.hospital}\n` +
    `*Red social:* ${p.red_social_rrss}\n` +
    `*Fuente de información:* ${p.fuente_de_informacion}\n` +
    `*Cédula:* ${p.cedula ?? '—'}\n` +
    `*N. Historia:* ${p.numero_historia_lista}\n` +
    `*Apellidos y nombres:* ${p.apellidos_y_nombres}\n` +
    `*Direccion domicilio:* ${p.direccion_de_domicilio}\n` +
    `*Sexo:* ${p.sexo}\n` +
    `*Edad:* ${p.edad}\n` +
    `*Manera que llegó:* ${p.manera_que_llego}\n` +
    `*Naturaleza de la lesión:* ${p.naturaleza_de_la_lesion}\n` +
    `*Hora de entrada:* ${p.hora_de_entrada}\n` +
    `*Servicio / diagnóstico:* ${p.servicio_diagnostico}\n` +
    `*Información adicional:* ${p.informacion_adicional}\n` +
    `*Estado persona:* ${p.servicio_diagnostico}\n`
  )
}
 
function respuestaPara(texto) {
  if (cache.length === 0) {
    return 'En este momento no puedo acceder a los datos. Intenta de nuevo en un minuto.'
  }
 
  // Decide si buscar por cedula o por nombre segun lo que escribio el usuario
  const encontrados = pareceCedula(texto)
    ? buscarPorCedula(texto)
    : buscarPorNombre(texto)
 
  if (encontrados.length === 0) {
    return `No encontre coincidencias para "${texto.trim()}".\n` +
           'Puedes escribir un nombre (o parte de el) o un numero de cedula.'
  }
  if (encontrados.length === 1) {
    return ficha(encontrados[0])
  }
 
  const tope = encontrados.slice(0, 5)
  const extra = encontrados.length > 5
    ? `\n\n…y ${encontrados.length - 5} mas. Afina tu busqueda.`
    : ''
  return `Encontre ${encontrados.length} coincidencias:\n\n${tope.map(ficha).join('\n\n')}${extra}`
}
 
// ----------------------------------------------------------------------
// Baileys
// ----------------------------------------------------------------------
async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()
 
  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu('Bot'),
    logger: P({ level: 'silent' }),
  })
 
  sock.ev.on('creds.update', saveCreds)
 
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) qrcode.generate(qr, { small: true })
 
    if (connection === 'open') {
      console.log('⚡ Bot conectado a WhatsApp')
    } else if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      const reconectar = code !== DisconnectReason.loggedOut
      console.log('🔌 Conexion cerrada. Codigo:', code, '→ Reconectar:', reconectar)
      if (reconectar) iniciarBot()
    }
  })
 
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg?.message) return
 
    const jid = msg.key.remoteJid
    if (msg.key.fromMe) return
    if (jid.endsWith('@g.us')) return
    if (jid === 'status@broadcast') return
 
    const texto =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ''
    if (!texto) return
 
    await sock.sendMessage(jid, { text: respuestaPara(texto) })
  })
}
 
// ----------------------------------------------------------------------
// Arranque
// ----------------------------------------------------------------------
await cargarPersonas()
setInterval(cargarPersonas, 5 * 60 * 1000)
iniciarBot()