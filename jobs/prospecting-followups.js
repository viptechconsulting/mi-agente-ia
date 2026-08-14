// jobs/prospecting-followups.js — "El 80% responde en el toque 2, 3 o 4"
//
// Corre diario. Por cada prospecto, mira cuándo se mandó el opener y decide
// si ya toca el siguiente seguimiento (día 2, 4 o 7), lo genera y lo envía
// por WhatsApp. Después del día 7 lo suelta (do_not_contact), igual que la
// regla del playbook: "3-4 toques en 7 días, luego lo sueltas. No ruegas."
//
// Limitación conocida: este job no tiene forma de saber si el prospecto ya
// respondió (no hay un canal de entrada ligado a estos números) — sigue el
// calendario a ciegas. Si alguien contesta, hay que marcar manualmente el
// prospecto como won/lost/do_not_contact para detener los seguimientos.
import { db } from '../db.js'
import { generateMessage } from '../services/prospecting-outreach.js'
import { sendProspectMessage } from '../services/prospecting-send.js'

const DAY_MS = 24 * 60 * 60 * 1000

const SCHEDULE = [
  { fromStatus: 'contacted', afterDays: 2, stage: 'day2' },
  { fromStatus: 'followup_2', afterDays: 4, stage: 'day4' },
  { fromStatus: 'followup_4', afterDays: 7, stage: 'day7' }
]

function openerSentAt(prospectId) {
  const row = db.prepare(`
    SELECT sent_at FROM prospect_messages
    WHERE prospect_id = ? AND stage = 'opener' AND sent_at IS NOT NULL
    ORDER BY sent_at ASC LIMIT 1
  `).get(prospectId)
  return row?.sent_at || null
}

// Prospectos a los que hoy les toca el siguiente seguimiento (usado tanto
// por el job real como por el dashboard, para mostrar la cuota pendiente).
export function listDueFollowups(now = Date.now()) {
  const due = []
  for (const { fromStatus, afterDays, stage } of SCHEDULE) {
    const prospects = db.prepare('SELECT * FROM prospects WHERE status = ?').all(fromStatus)
    for (const prospect of prospects) {
      const openedAt = openerSentAt(prospect.id)
      if (openedAt && now - openedAt >= afterDays * DAY_MS) due.push({ prospect, stage })
    }
  }
  return due
}

export async function runProspectingFollowups() {
  const now = Date.now()

  for (const { prospect, stage } of listDueFollowups(now)) {
    try {
      const { id } = await generateMessage(prospect.id, stage, { channel: 'whatsapp' })
      await sendProspectMessage(id)
      console.log(`[prospecting-followups] ${stage} enviado a ${prospect.name} (${prospect.id})`)
    } catch (err) {
      console.error(`[prospecting-followups] error enviando ${stage} a ${prospect.id}:`, err.message)
    }
  }

  const doneWaiting = db.prepare("SELECT * FROM prospects WHERE status = 'followup_7'").all()
  for (const prospect of doneWaiting) {
    const lastDay7 = db.prepare(`
      SELECT sent_at FROM prospect_messages
      WHERE prospect_id = ? AND stage = 'day7' AND sent_at IS NOT NULL
      ORDER BY sent_at DESC LIMIT 1
    `).get(prospect.id)
    if (lastDay7?.sent_at && now - lastDay7.sent_at >= DAY_MS) {
      db.prepare("UPDATE prospects SET status = 'do_not_contact', updated_at = ? WHERE id = ?").run(now, prospect.id)
      console.log(`[prospecting-followups] ${prospect.name} (${prospect.id}) -> do_not_contact`)
    }
  }
}
