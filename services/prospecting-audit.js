// services/prospecting-audit.js — Paso "Construye": una auditoría real por
// prospecto, en serie. Sin headless browser: fetch + señales de texto sobre
// el HTML, igual de suficiente para los 3 problemas que importa nombrar.
import crypto from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { db } from '../db.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const VIEWPORT_RE = /<meta[^>]+name=["']viewport["']/i
const FORM_RE = /<form[\s>]/i
const BOOKING_OR_CHAT_RE = /calendly\.com|wa\.me\/|api\.whatsapp\.com|tidio|intercom|crisp\.chat|livechat|zendesk|freshchat|drift\.com|book(?:ing)?\s*online|reserva[sn]?\s*online|acuity|square\s*appointments|calendar\.google/i

export async function auditWebsite(url) {
  const start = Date.now()
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) })
    const html = await res.text()
    return {
      reachable: res.ok,
      load_time_ms: Date.now() - start,
      mobile_friendly: VIEWPORT_RE.test(html) ? 1 : 0,
      has_form: FORM_RE.test(html) ? 1 : 0,
      has_booking_or_chat: BOOKING_OR_CHAT_RE.test(html) ? 1 : 0
    }
  } catch (err) {
    return {
      reachable: false,
      load_time_ms: null,
      mobile_friendly: 0,
      has_form: 0,
      has_booking_or_chat: 0,
      error: err.message
    }
  }
}

function signalsSummary(prospect, signals) {
  if (!prospect.website) return 'El negocio no tiene sitio web (o su único enlace público es Instagram).'
  if (!signals.reachable) return `El sitio (${prospect.website}) no cargó al intentar auditarlo (${signals.error || 'sin respuesta'}).`
  const bits = []
  bits.push(`Tiempo de carga: ${signals.load_time_ms}ms.`)
  bits.push(signals.mobile_friendly ? 'Tiene meta viewport (adaptado a celular).' : 'NO tiene meta viewport — probablemente no se ve bien en celular.')
  bits.push(signals.has_form ? 'Tiene al menos un formulario.' : 'No tiene ningún formulario de contacto.')
  bits.push(signals.has_booking_or_chat ? 'Tiene señales de reservas online o chat.' : 'No tiene reservas online ni chat visible.')
  return bits.join(' ')
}

export async function generateAuditIssues(prospect, signals) {
  const summary = signalsSummary(prospect, signals)
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    system: 'Eres un consultor que audita negocios locales para venderles un asistente/sitio con IA. Escribes en español neutro, directo, sin jerga técnica ni relleno. Cada problema debe sonar a algo que el dueño del negocio puede notar él mismo (no una métrica técnica).',
    messages: [{
      role: 'user',
      content: `Negocio: ${prospect.name} (${prospect.category || 'sin categoría'}).\nSeñales encontradas: ${summary}\n\nEscribe EXACTAMENTE 3 problemas concretos, cortos (una línea cada uno), que le estén costando clientes a este negocio HOY. Devuelve solo la lista, un problema por línea, sin numeración ni viñetas.`
    }]
  })
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
  return text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3)
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
