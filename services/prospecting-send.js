// services/prospecting-send.js — envío real de la prospección en frío.
//
// Solo WhatsApp se envía de forma automática: reusa la misma conexión de
// WhatsApp de una empresa ya configurada en Lynkro (mismo patrón que
// sendLynkroFU en routes/chat.js — socket Baileys en proceso si está
// abierto, si no cae a Evolution API). Instagram NO se puede automatizar:
// la API oficial de Meta solo permite responder a quien ya escribió o
// comentó, nunca iniciar un DM en frío — así que para ese canal solo se
// marca el mensaje como listo para copiar y pegar a mano.
import { db, loadConfig } from '../db.js'
import { waConnections, sendWhatsApp } from '../routes/chat.js'
import { normalizePhone } from './ghl.js'

const STAGE_TO_STATUS = { opener: 'contacted', day2: 'followup_2', day4: 'followup_4', day7: 'followup_7' }

export async function sendColdWhatsApp(companyId, phone, text) {
  const normalized = normalizePhone(phone || '')
  if (!normalized) throw new Error('El prospecto no tiene teléfono')

  const conn = waConnections.get(companyId)
  if (conn?.sock && conn.state?.status === 'open') {
    await conn.sock.sendMessage(`${normalized}@s.whatsapp.net`, { text })
    return
  }
  const cfg = loadConfig(companyId)
  if (!cfg.waBaseUrl || !cfg.waInstance || !cfg.waApiKey) {
    throw new Error(`La empresa ${companyId} no tiene WhatsApp conectado (ni socket ni Evolution API)`)
  }
  await sendWhatsApp(cfg, normalized, text)
}

export async function sendProspectMessage(messageId) {
  const message = db.prepare('SELECT * FROM prospect_messages WHERE id = ?').get(messageId)
  if (!message) throw new Error('Mensaje no encontrado')
  const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(message.prospect_id)
  if (!prospect) throw new Error('Prospecto no encontrado')

  const now = Date.now()

  if (message.channel === 'instagram') {
    // No hay envío real posible — solo se deja constancia de que el texto
    // está listo para que una persona lo copie y lo mande a mano por IG.
    db.prepare("UPDATE prospect_messages SET status = 'ready_to_copy', sent_at = ? WHERE id = ?").run(now, messageId)
    return { ok: true, manual: true, channel: 'instagram' }
  }

  const companyId = process.env.PROSPECTING_COMPANY_ID
  if (!companyId) throw new Error('PROSPECTING_COMPANY_ID no está configurado')

  try {
    await sendColdWhatsApp(companyId, prospect.phone, message.message_text)
    db.prepare("UPDATE prospect_messages SET status = 'sent', sent_at = ? WHERE id = ?").run(now, messageId)
    const nextStatus = STAGE_TO_STATUS[message.stage]
    if (nextStatus) {
      db.prepare('UPDATE prospects SET status = ?, updated_at = ? WHERE id = ?').run(nextStatus, now, prospect.id)
    }
    return { ok: true, manual: false, channel: 'whatsapp' }
  } catch (err) {
    db.prepare("UPDATE prospect_messages SET status = 'error', error = ? WHERE id = ?").run(err.message, messageId)
    throw err
  }
}
