// services/prospecting-outreach.js — Paso "Manda": el opener y los 3
// seguimientos, calcados de los scripts del playbook ("copia y pega, solo
// personaliza lo que va en corchetes"). Son plantillas deterministas, no
// generadas por IA en cada envío — los 3 problemas reales (lo único que
// varía por prospecto) ya vienen del paso de auditoría.
import crypto from 'crypto'
import { db } from '../db.js'

const STAGES = ['opener', 'day2', 'day4', 'day7']

function firstName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || 'ahí'
}

export function buildOpenerMessage(prospect, issues, { senderName, videoUrl } = {}) {
  const [p1, p2, p3] = issues && issues.length ? issues : [
    'su página no abre bien en celular', 'no tiene cómo agendar citas en línea', 'los mensajes fuera de horario se quedan sin responder'
  ]
  const sender = senderName || 'tu nombre'
  const link = videoUrl || '[link del video]'
  return `Hola ${firstName(prospect.name)} 👋 Soy ${sender}. Le hice una auditoría rápida a ${prospect.name} y encontré 3 cosas que ahorita le están costando clientes:\n\n1) ${p1}  2) ${p2}  3) ${p3}\n\nSe lo grabé en un video de 90 seg: ${link}. Si quiere, le arreglo la #1 GRATIS para que vea cómo trabajo. ¿Le late?`
}

export function buildFollowupMessage(prospect, day) {
  const name = firstName(prospect.name)
  if (day === 2) {
    return `${name}, ¿alcanzó a ver el video? La parte de la página en celular es la que más rápido le sube las citas. Si me dice que sí, se la dejo lista esta semana sin costo.`
  }
  if (day === 4) {
    return `Se lo hago fácil: déjeme arreglarle ese punto GRATIS. Si le gusta el resultado, hablamos de lo demás. Si no, no perdió nada. ¿Mañana le marco 5 minutos?`
  }
  if (day === 7) {
    return `${name}, última vez que le escribo para no molestar 🙏 Le dejo el video por si después le sirve. Cuando quiera dar el paso, aquí estoy.`
  }
  throw new Error(`día de seguimiento inválido: ${day}`)
}

function latestIssues(prospectId) {
  const audit = db.prepare('SELECT issues_json FROM prospect_audits WHERE prospect_id = ? ORDER BY audited_at DESC LIMIT 1').get(prospectId)
  if (!audit) return null
  try { return JSON.parse(audit.issues_json) } catch { return null }
}

export function generateMessage(prospectId, stage, { channel = 'whatsapp', senderName, videoUrl } = {}) {
  if (!STAGES.includes(stage)) throw new Error(`stage inválido: ${stage}`)
  const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(prospectId)
  if (!prospect) throw new Error('Prospecto no encontrado')

  let text
  if (stage === 'opener') {
    const issues = latestIssues(prospectId)
    if (!issues) throw new Error('Este prospecto todavía no tiene auditoría — corre /audit primero')
    text = buildOpenerMessage(prospect, issues, { senderName, videoUrl })
  } else {
    text = buildFollowupMessage(prospect, { day2: 2, day4: 4, day7: 7 }[stage])
  }

  const id = crypto.randomUUID()
  const now = Date.now()
  db.prepare(`
    INSERT INTO prospect_messages (id, prospect_id, channel, stage, message_text, status, created_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, prospectId, channel, stage, text, 'draft', now)

  return { id, prospect_id: prospectId, channel, stage, message_text: text }
}
