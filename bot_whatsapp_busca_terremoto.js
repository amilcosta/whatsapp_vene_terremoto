/**
 * Bot de atencion 1:1 con Baileys (Node.js, SIN Meta) + PostgreSQL.
 * SIN CACHE: consulta la base en cada mensaje.
 *
 * - Busqueda por NOMBRE  -> columna apellidos_y_nombres (parcial, en
 *   cualquier orden, ignorando tildes y mayusculas).
 * - Busqueda por CEDULA  -> columna cedula (coincidencia exacta).
 * - La respuesta muestra todas las columnas de la ficha.
 * - Bienvenida solo en el primer mensaje de cada usuario.
 *
 * ADVERTENCIA: NO oficial, va contra los ToS de WhatsApp. Usa numero DEDICADO.
 *
 * ────────────────────────────────────────────────────────────────────
 * PREPARAR LA BASE (una sola vez)
 * ────────────────────────────────────────────────────────────────────
 *   CREATE EXTENSION IF NOT EXISTS unaccent;
 *
 * INSTALACION
 *   npm install @whiskeysockets/baileys @hapi/boom pino qrcode-terminal pg
 *
 * EJECUCION
 *   export DATABASE_URL="postgres://usuario:clave@localhost:5432/mi_base"
 *   node bot-whatsapp-baileys-postgres.js
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
import pg from 'pg'

const { Pool } = pg

// ----------------------------------------------------------------------
// PostgreSQL
// ----------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ssl: { rejectUnauthorized: false },   // descomenta si tu PG exige SSL
})

// Columnas que se traen en cada consulta.
// apellidos_y_nombres se renombra a "nombre" para usarlo como titulo.
const SELECT_CAMPOS = `
  hospital,
  red_social_rrss,
  fuente_de_informacion,
  cedula,
  numero_historia_lista,
  apellidos_y_nombres AS nombre,
  direccion_de_domicilio,
  sexo,
  edad,
  manera_que_llego,
  naturaleza_de_la_lesion,
  hora_de_entrada,
  servicio_diagnostico,
  informacion_adicional,
  estado
`

// Cuantas fichas completas por mensaje cuando hay varios resultados.
const LOTE = 5

// ----------------------------------------------------------------------
// Bienvenida (solo el primer mensaje de cada usuario)
// ----------------------------------------------------------------------
const yaSaludados = new Set()   // en memoria: se reinicia si reinicias el bot

const MENSAJE_BIENVENIDA =
  '👋 ¡Hola! Soy el bot de consulta de personas.\n\n' +
  'Puedes buscar de dos formas:\n' +
  '• Escribiendo el *nombre* (o parte de él), por ejemplo: Pineda\n' +
  '• Escribiendo el *número de cédula*, por ejemplo: 12345678\n\n' +
  'Envíame un nombre o una cédula para empezar.'

// ----------------------------------------------------------------------
// Helpers de cedula
// ----------------------------------------------------------------------
function normalizarCedula(texto) {
  return texto.toLowerCase().replace(/[^0-9k]/g, '')
}

function pareceCedula(texto) {
  const limpio = texto.toLowerCase().replace(/[\s.\-]/g, '')
  return /^\d{5,}k?$/.test(limpio)
}

// ----------------------------------------------------------------------
// Busqueda por NOMBRE (directo en PostgreSQL, columna apellidos_y_nombres)
//   Cada palabra escrita debe aparecer en el nombre.
//   unaccent() ignora tildes; lower() ignora mayusculas.
// ----------------------------------------------------------------------
async function buscarPorNombre(texto) {
  const tokens = texto.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []

  const condiciones = tokens
    .map((_, i) => `unaccent(lower(apellidos_y_nombres)) LIKE '%' || unaccent(lower($${i + 1})) || '%'`)
    .join(' AND ')

  const { rows } = await pool.query(
    `SELECT ${SELECT_CAMPOS}
     FROM hospitales
     WHERE ${condiciones}
     ORDER BY apellidos_y_nombres`,
    tokens
  )
  return rows
}

// ----------------------------------------------------------------------
// Busqueda por CEDULA (columna cedula, coincidencia exacta)
// ----------------------------------------------------------------------
async function buscarPorCedula(texto) {
  const q = normalizarCedula(texto)
  if (!q) return []

  const { rows } = await pool.query(
    `SELECT ${SELECT_CAMPOS}
     FROM hospitales
     WHERE regexp_replace(lower(coalesce(cedula, '')), '[^0-9k]', '', 'g') = $1`,
    [q]
  )
  return rows
}

// ----------------------------------------------------------------------
// Ficha de respuesta (todas las columnas)
// ----------------------------------------------------------------------
function v(x) {
  return (x === null || x === undefined || x === '') ? '—' : x
}

function ficha(p) {
  return [
    `----- Registro ----- `,
    `*Hospital:* ${v(p.hospital)}`,
    `*Red social (RRSS):* ${v(p.red_social_rrss)}`,
    `*Fuente de información:* ${v(p.fuente_de_informacion)}`,
    `*Cédula:* ${v(p.cedula)}`,
    `*N° Historia:* ${v(p.numero_historia_lista)}`,
    `*Apellidos y nombres:* ${v(p.nombre)}`,
    `*Direccion domicilio:* ${v(p.direccion_de_domicilio)}`,
    `*Edad:* ${v(p.edad)}`,
    `*Sexo:* ${v(p.sexo)}`,
    `*Manera que llegó:* ${v(p.manera_que_llego)}`,
    `*Naturaleza de la lesión:* ${v(p.naturaleza_de_la_lesion)}`,
    `*Hora de entrada:* ${v(p.hora_de_entrada)}`,
    `*Servicio / diagnóstico:* ${v(p.servicio_diagnostico)}`,
    `*Información adicional:* ${v(p.informacion_adicional)}`,
    `*Estado persona:* ${v(p.estado)} `,
  ].join('\n')
}

// ----------------------------------------------------------------------
// Respuesta (devuelve SIEMPRE un arreglo de mensajes)
// ----------------------------------------------------------------------
async function respuestaPara(texto) {
  let encontrados
  try {
    encontrados = pareceCedula(texto)
      ? await buscarPorCedula(texto)
      : await buscarPorNombre(texto)
  } catch (err) {
    console.error('Error consultando PostgreSQL:', err.message)
    return ['Ocurrió un error al consultar los datos. Intenta de nuevo.']
  }

  if (encontrados.length === 0) {
    return [
      `No encontré coincidencias para "${texto.trim()}".\n` +
      'Puedes escribir un nombre (o parte de él) o un número de cédula.'
    ]
  }
  if (encontrados.length === 1) {
    return [ficha(encontrados[0])]
  }

  // Varios: mostramos TODOS, repartidos en lotes para no enviar un
  // unico mensaje enorme.
  const mensajes = [`Encontré ${encontrados.length} coincidencias:`]
  for (let i = 0; i < encontrados.length; i += LOTE) {
    mensajes.push(encontrados.slice(i, i + LOTE).map(ficha).join('\n\n────────────\n\n'))
  }
  return mensajes
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
      console.log('🔌 Conexión cerrada. Código:', code, '→ Reconectar:', reconectar)
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

    // --- Primer mensaje del usuario: SOLO bienvenida ---
    if (!yaSaludados.has(jid)) {
      yaSaludados.add(jid)
      await sock.sendMessage(jid, { text: MENSAJE_BIENVENIDA })
      return
    }

    // --- Resto de mensajes: buscar y responder ---
    for (const m of await respuestaPara(texto)) {
      await sock.sendMessage(jid, { text: m })
    }
  })
}

// ----------------------------------------------------------------------
// Arranque
// ----------------------------------------------------------------------
try {
  const { rows } = await pool.query('SELECT COUNT(*) FROM hospitales')
  console.log(`📇 Conectado a PostgreSQL: ${rows[0].count} personas en la tabla`)
} catch (err) {
  console.error('No pude conectar a PostgreSQL:', err.message)
}

iniciarBot()