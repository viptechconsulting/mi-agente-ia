// services/prospecting-audit.js — Paso "Construye": una auditoría real por
// prospecto, en serie. Sin headless browser: fetch + señales de texto sobre
// el HTML, igual de suficiente para los 3 problemas que importa nombrar.
import crypto from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { db } from '../db.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const VIEWPORT_RE = /<meta[^>]+name=["']viewport["']/i
const FORM_RE = /<form[\s>]/i
// pista débil: un fetch no ejecuta JS, así que muchos widgets de reserva/chat no se ven aquí
const BOOKING_OR_CHAT_RE = /calendly\.com|wa\.me\/|api\.whatsapp\.com|tidio|intercom|crisp\.chat|livechat|zendesk|freshchat|drift\.com|book(?:ing)?\s*online|reserva[sn]?\s*online|acuity|square\s*appointments|calendar\.google|vagaro|boulevard|blvd\.co|mangomint|glossgenius|fresha|booksy|setmore|schedulicity|janeapp|zenoti|mindbody|book\s*now|agendar|reservar/i

// Extrae lo que un humano leería: título, meta descripción y texto visible (recortado).
function extractContent(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim()
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] || '').replace(/\s+/g, ' ').trim()
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000)
  return { title, desc, text }
}

export async function auditWebsite(url) {
  const start = Date.now()
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept': 'text/html' }
    })
    const html = await res.text()
    return {
      reachable: res.ok,
      load_time_ms: Date.now() - start,
      mobile_friendly: VIEWPORT_RE.test(html) ? 1 : 0,
      has_form: FORM_RE.test(html) ? 1 : 0,
      has_booking_or_chat: BOOKING_OR_CHAT_RE.test(html) ? 1 : 0,
      ...extractContent(html)
    }
  } catch (err) {
    return {
      reachable: false,
      load_time_ms: null,
      mobile_friendly: 0,
      has_form: 0,
      has_booking_or_chat: 0,
      title: '', desc: '', text: '',
      error: err.message
    }
  }
}

export async function generateAuditIssues(prospect, signals) {
  if (!prospect.website) {
    return ['No tiene sitio web propio (solo redes o Google): quien lo busca en Google y no encuentra página se va con la competencia, y no hay dónde captar ni responder al cliente fuera de horario.']
  }
  if (!signals.reachable) {
    return [`Su sitio (${prospect.website}) no cargó al auditarlo (${signals.error || 'sin respuesta'}) — si a ti no te carga, a sus clientes tampoco.`]
  }

  const hints = [
    `Carga del HTML: ${signals.load_time_ms} ms.`,
    signals.mobile_friendly ? 'Declara viewport móvil.' : 'No declara viewport móvil.',
    `Detección automática SIN ejecutar JavaScript (poco confiable): formulario=${signals.has_form ? 'sí' : 'no visto'}, reservas/chat=${signals.has_booking_or_chat ? 'sí' : 'no visto'}.`
  ].join(' ')

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: 'Eres un consultor que audita negocios locales para venderles un asistente de WhatsApp/chat con IA. Escribes en español neutro, directo, sin jerga ni relleno; cada problema suena a algo que el dueño puede notar él mismo. REGLA CRÍTICA: basa cada problema SOLO en la evidencia real del contenido de la página. NUNCA afirmes que le falta algo (reservas online, chat, formulario) si no estás seguro: la detección automática no ejecuta JavaScript y suele fallar, y el texto de la página puede mencionar reservas o chat aunque la detección diga que no. Ante la duda, NO lo afirmes. Es mejor 1 problema real y verificable que 3 inventados.',
    messages: [{
      role: 'user',
      content: `Negocio: ${prospect.name} (${prospect.category || 'sin categoría'}), rating ${prospect.rating ?? 'n/d'} con ${prospect.reviews_count ?? 0} reseñas.
Título del sitio: ${signals.title || '(sin título)'}
Meta descripción: ${signals.desc || '(sin descripción)'}
Señales técnicas: ${hints}

CONTENIDO REAL DE LA PÁGINA (texto extraído, puede estar recortado):
"""
${signals.text || '(no se pudo extraer texto)'}
"""

Basándote en el contenido real de arriba, escribe entre 1 y 3 problemas concretos que le estén costando clientes y que un asistente de WhatsApp/chat con IA resolvería (ej: no responde fuera de horario, tarda en contestar, no capta al que pregunta de noche, sin reservas 24/7). Solo problemas que puedas sostener con lo que ves; si el sitio ya hace algo bien, no inventes un problema para llenar, devuelve menos. Un problema por línea, sin numeración ni viñetas.`
    }]
  })
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
  return text.split('\n').map(l => l.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean).slice(0, 3)
}

// ── Chat sobre la auditoría: el usuario puede corregir/refinar el análisis ──
export async function sendAuditChat(prospectId, message) {
  const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(prospectId)
  if (!prospect) throw new Error('Prospecto no encontrado')
  const audit = db.prepare('SELECT * FROM prospect_audits WHERE prospect_id = ? ORDER BY audited_at DESC').get(prospectId)
  const issues = audit ? JSON.parse(audit.issues_json || '[]') : []
  const history = db.prepare('SELECT role, content FROM prospect_audit_chat WHERE prospect_id = ? ORDER BY created_at ASC').all(prospectId)

  const auditContext = audit
    ? `Auditoría automática del sitio de ${prospect.name}${prospect.website ? ' (' + prospect.website + ')' : ''}:
- Tiempo de carga: ${audit.load_time_ms ?? 'n/d'} ms
- Meta viewport (adaptado a móvil): ${audit.mobile_friendly ? 'sí' : 'no'}
- Formulario de contacto: ${audit.has_form ? 'sí' : 'no'}
- Reservas online / chat: ${audit.has_booking_or_chat ? 'sí' : 'no'}
Problemas detectados por la auditoría:
${issues.map((x, i) => `${i + 1}. ${x}`).join('\n') || '(ninguno)'}`
    : 'Todavía no se ha corrido una auditoría de este prospecto.'

  const system = `Eres un consultor experto que ayuda a revisar y CORREGIR auditorías de negocios locales (el objetivo final es venderles un asistente/sitio con IA).
La auditoría automática se basa en señales simples (un fetch del HTML + regex), así que PUEDE equivocarse: por ejemplo marcar que no hay reservas online cuando sí las hay, no detectar un chat embebido, o juzgar mal la velocidad.
Tu trabajo: responder al usuario, ADMITIR cuando el análisis automático pudo estar mal, corregirlo con criterio, y dar un análisis más preciso y accionable. Sé concreto, honesto y breve, en español neutro, sin relleno ni jerga técnica innecesaria.

DATOS DEL NEGOCIO: ${prospect.name} · ${prospect.category || 'sin categoría'} · ${prospect.address || 'sin dirección'} · rating ${prospect.rating ?? 'n/d'} (${prospect.reviews_count ?? 0} reseñas).

${auditContext}`

  const messages = [...history.map(h => ({ role: h.role, content: h.content })), { role: 'user', content: message }]
  const resp = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 800, system, messages })
  const reply = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim() || '(sin respuesta)'

  const now = Date.now()
  const ins = db.prepare('INSERT INTO prospect_audit_chat (id, prospect_id, role, content, created_at) VALUES (?,?,?,?,?)')
  ins.run(crypto.randomUUID(), prospectId, 'user', message, now)
  ins.run(crypto.randomUUID(), prospectId, 'assistant', reply, now + 1)
  return { reply }
}

export function clearAuditChat(prospectId) {
  db.prepare('DELETE FROM prospect_audit_chat WHERE prospect_id = ?').run(prospectId)
}

export async function auditProspect(prospectId) {
  const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(prospectId)
  if (!prospect) throw new Error('Prospecto no encontrado')

  const signals = prospect.website
    ? await auditWebsite(prospect.website)
    : { reachable: false, load_time_ms: null, mobile_friendly: 0, has_form: 0, has_booking_or_chat: 0 }

  const issues = await generateAuditIssues(prospect, signals)

  const id = crypto.randomUUID()
  const now = Date.now()
  db.prepare(`
    INSERT INTO prospect_audits (
      id, prospect_id, load_time_ms, mobile_friendly, has_form,
      has_booking_or_chat, issues_json, audited_at
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(id, prospectId, signals.load_time_ms, signals.mobile_friendly, signals.has_form, signals.has_booking_or_chat, JSON.stringify(issues), now)

  if (prospect.status === 'new') {
    db.prepare("UPDATE prospects SET status = 'audited', updated_at = ? WHERE id = ?").run(now, prospectId)
  }

  return { id, prospect_id: prospectId, issues, signals }
}
