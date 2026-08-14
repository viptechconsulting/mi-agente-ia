// services/prospecting-outreach.js — Paso "Manda": el opener y los 3
// seguimientos, calcados de los scripts del playbook ("copia y pega, solo
// personaliza lo que va en corchetes"). Son plantillas deterministas, no
// generadas por IA en cada envío — los 3 problemas reales (lo único que
// varía por prospecto) ya vienen del paso de auditoría.
import crypto from 'crypto'
import { db } from '../db.js'
import { reconcileIssues } from './prospecting-audit.js'

const STAGES = ['opener', 'day2', 'day4', 'day7']

// Google Maps/Apify solo da el nombre del NEGOCIO, nunca el del dueño — usar
// la primera palabra (ej. "Taller" de "Taller El Rayo") como si fuera un
// nombre de persona suena raro. Saludamos con el nombre completo del negocio.
export function buildOpenerMessage(prospect, issues, { senderName, videoUrl, lang = 'es', includeVideo = true } = {}) {
  const en = lang === 'en'
  const [p1, p2, p3] = issues && issues.length ? issues : (en
    ? ["your site doesn't open well on mobile", "there's no way to book appointments online", 'after-hours messages go unanswered']
    : ['su página no abre bien en celular', 'no tiene cómo agendar citas en línea', 'los mensajes fuera de horario se quedan sin responder'])
  const sender = senderName || (en ? 'your name' : 'tu nombre')
  const link = videoUrl || (en ? '[video link]' : '[link del video]')
  // El video (Loom) es opcional; si no se incluye, el párrafo pasa directo a la oferta.
  const video = includeVideo ? (en ? `I recorded it in a 90-sec video: ${link}. ` : `Se lo grabé en un video de 90 seg: ${link}. `) : ''
  return en
    ? `Hi ${prospect.name} 👋 I'm ${sender}. I ran a quick audit on ${prospect.name} and found 3 things that are costing you customers right now:\n\n1) ${p1}  2) ${p2}  3) ${p3}\n\n${video}If you want, I'll fix #1 for FREE so you can see how I work. Sound good?`
    : `Hola ${prospect.name} 👋 Soy ${sender}. Le hice una auditoría rápida a ${prospect.name} y encontré 3 cosas que ahorita le están costando clientes:\n\n1) ${p1}  2) ${p2}  3) ${p3}\n\n${video}Si quiere, le arreglo la #1 GRATIS para que vea cómo trabajo. ¿Le late?`
}

export function buildFollowupMessage(prospect, day, lang = 'es') {
  const name = prospect.name
  const en = lang === 'en'
  if (day === 2) {
    return en
      ? `${name}, did you get a chance to watch the video? The mobile-site piece is the one that boosts your bookings fastest. Just say the word and I'll have it ready for you this week at no cost.`
      : `${name}, ¿alcanzó a ver el video? La parte de la página en celular es la que más rápido le sube las citas. Si me dice que sí, se la dejo lista esta semana sin costo.`
  }
  if (day === 4) {
    return en
      ? `Let me make it easy: let me fix that one thing for FREE. If you like the result, we talk about the rest. If not, you've lost nothing. Can I grab 5 minutes with you tomorrow?`
      : `Se lo hago fácil: déjeme arreglarle ese punto GRATIS. Si le gusta el resultado, hablamos de lo demás. Si no, no perdió nada. ¿Mañana le marco 5 minutos?`
  }
  if (day === 7) {
    return en
      ? `${name}, last time I'll reach out so I don't bug you 🙏 I'll leave the video here in case it's useful later. Whenever you're ready to take the step, I'm here.`
      : `${name}, última vez que le escribo para no molestar 🙏 Le dejo el video por si después le sirve. Cuando quiera dar el paso, aquí estoy.`
  }
  throw new Error(`día de seguimiento inválido: ${day}`)
}

function latestIssues(prospectId) {
  const audit = db.prepare('SELECT issues_json FROM prospect_audits WHERE prospect_id = ? ORDER BY audited_at DESC LIMIT 1').get(prospectId)
  if (!audit) return null
  try { return JSON.parse(audit.issues_json) } catch { return null }
}

export async function generateMessage(prospectId, stage, { channel = 'whatsapp', senderName, videoUrl, lang = 'es', includeVideo = true } = {}) {
  if (!STAGES.includes(stage)) throw new Error(`stage inválido: ${stage}`)
  const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(prospectId)
  if (!prospect) throw new Error('Prospecto no encontrado')

  let text
  if (stage === 'opener') {
    if (!latestIssues(prospectId)) throw new Error('Este prospecto todavía no tiene auditoría — corre /audit primero')
    // Reconcilia auditoría (Paso 2) + "Revisar auditoría con IA" en los 3 problemas finales.
    const issues = await reconcileIssues(prospectId, lang)
    text = buildOpenerMessage(prospect, issues, { senderName, videoUrl, lang, includeVideo })
  } else {
    text = buildFollowupMessage(prospect, { day2: 2, day4: 4, day7: 7 }[stage], lang)
  }

  const id = crypto.randomUUID()
  const now = Date.now()
  db.prepare(`
    INSERT INTO prospect_messages (id, prospect_id, channel, stage, message_text, status, created_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, prospectId, channel, stage, text, 'draft', now)

  return { id, prospect_id: prospectId, channel, stage, message_text: text }
}
