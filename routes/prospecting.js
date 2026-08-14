// routes/prospecting.js — "La Máquina de Tu Primer Cliente" (Apify)
//
// Herramienta interna, protegida con requireAdmin: no es una feature de
// Lynkro para sus clientes, es cómo Vip Tech/Lynkro consigue los propios.
import express from 'express'
import { randomUUID } from 'node:crypto'
import { db } from '../db.js'
import { requireAdmin } from '../middleware/auth.js'
import { scrapeIntoBatch } from '../services/prospecting-scraper.js'
import { auditProspect, sendAuditChat, clearAuditChat } from '../services/prospecting-audit.js'
import { generateMessage } from '../services/prospecting-outreach.js'
import { sendProspectMessage } from '../services/prospecting-send.js'
import { painTier } from '../services/prospecting-score.js'
import { listDueFollowups } from '../jobs/prospecting-followups.js'

export const prospectingRouter = express.Router()

function withTier(prospect) {
  return { ...prospect, pain_tier: painTier(prospect.pain_score) }
}

function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Cuota diaria del playbook: 20 negocios nuevos, 10 auditorías, 20 mensajes,
// todos los seguimientos del día.
prospectingRouter.get('/stats/today', requireAdmin, (req, res) => {
  const since = startOfToday()
  const newToday = db.prepare('SELECT COUNT(*) as n FROM prospects WHERE created_at >= ?').get(since).n
  const auditedToday = db.prepare('SELECT COUNT(*) as n FROM prospect_audits WHERE audited_at >= ?').get(since).n
  const messagesToday = db.prepare(`
    SELECT COUNT(*) as n FROM prospect_messages WHERE sent_at >= ? AND status IN ('sent', 'ready_to_copy')
  `).get(since).n
  const pendingFollowups = listDueFollowups().length
  res.json({ newToday, auditedToday, messagesToday, pendingFollowups })
})

// ── Batches ──────────────────────────────────────────────────────────────
prospectingRouter.post('/batches', requireAdmin, (req, res) => {
  const { niche, city, serviceOffered, limit } = req.body || {}
  if (!niche || !city) return res.status(400).json({ error: 'niche y city son obligatorios' })
  // Crea el batch en estado 'running' y responde YA; el scrape (minutos) corre
  // en segundo plano para no chocar con el timeout del proxy. El frontend hace
  // polling sobre GET /batches/:id hasta status 'completed'/'failed'.
  const batchId = randomUUID()
  db.prepare(`INSERT INTO prospect_batches (id, niche, city, service_offered, status, created_at) VALUES (?,?,?,?,?,?)`)
    .run(batchId, niche, city, serviceOffered || null, 'running', Date.now())
  const batch = db.prepare('SELECT * FROM prospect_batches WHERE id = ?').get(batchId)
  res.json({ ok: true, batch })
  scrapeIntoBatch(batchId, { niche, city, limit })
    .catch(err => console.error('[prospecting] batch bg error:', err.message))
})

prospectingRouter.get('/batches', requireAdmin, (req, res) => {
  const batches = db.prepare('SELECT * FROM prospect_batches ORDER BY created_at DESC LIMIT 100').all()
  res.json({ batches })
})

prospectingRouter.get('/batches/:id', requireAdmin, (req, res) => {
  const batch = db.prepare('SELECT * FROM prospect_batches WHERE id = ?').get(req.params.id)
  if (!batch) return res.status(404).json({ error: 'Batch no encontrado' })
  const counts = db.prepare(`
    SELECT status, COUNT(*) as n FROM prospects WHERE batch_id = ? GROUP BY status
  `).all(req.params.id)
  res.json({ batch, counts })
})

// ── Prospectos ───────────────────────────────────────────────────────────
prospectingRouter.get('/prospects', requireAdmin, (req, res) => {
  const { batchId, status, limit = 200 } = req.query
  const clauses = []
  const params = []
  if (batchId) { clauses.push('batch_id = ?'); params.push(batchId) }
  if (status) { clauses.push('status = ?'); params.push(status) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db.prepare(`
    SELECT * FROM prospects ${where} ORDER BY pain_score DESC, created_at DESC LIMIT ?
  `).all(...params, Number(limit) || 200)
  res.json({ prospects: rows.map(withTier) })
})

prospectingRouter.get('/prospects/:id', requireAdmin, (req, res) => {
  const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id)
  if (!prospect) return res.status(404).json({ error: 'Prospecto no encontrado' })
  const audits = db.prepare('SELECT * FROM prospect_audits WHERE prospect_id = ? ORDER BY audited_at DESC').all(req.params.id)
  const messages = db.prepare('SELECT * FROM prospect_messages WHERE prospect_id = ? ORDER BY created_at DESC').all(req.params.id)
  const notes = db.prepare('SELECT * FROM prospect_notes WHERE prospect_id = ? ORDER BY created_at DESC').all(req.params.id)
  const auditChat = db.prepare('SELECT role, content, created_at FROM prospect_audit_chat WHERE prospect_id = ? ORDER BY created_at ASC').all(req.params.id)
  res.json({ prospect: withTier(prospect), audits, messages, notes, auditChat })
})

// ── Chat con IA sobre la auditoría (corregir / refinar el análisis) ────
prospectingRouter.post('/prospects/:id/audit-chat', requireAdmin, async (req, res) => {
  const message = String(req.body?.message || '').trim()
  if (!message) return res.status(400).json({ error: 'Escribe un mensaje' })
  try {
    const { reply } = await sendAuditChat(req.params.id, message)
    res.json({ reply })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

prospectingRouter.delete('/prospects/:id/audit-chat', requireAdmin, (req, res) => {
  clearAuditChat(req.params.id)
  res.json({ ok: true })
})

// ── Borrar prospectos (individual + bulk) ──────────────────────────────
function deleteProspects(ids) {
  if (!ids.length) return 0
  const ph = ids.map(() => '?').join(',')
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM prospect_audits WHERE prospect_id IN (${ph})`).run(...ids)
    db.prepare(`DELETE FROM prospect_messages WHERE prospect_id IN (${ph})`).run(...ids)
    db.prepare(`DELETE FROM prospect_notes WHERE prospect_id IN (${ph})`).run(...ids)
    db.prepare(`DELETE FROM prospect_audit_chat WHERE prospect_id IN (${ph})`).run(...ids)
    return db.prepare(`DELETE FROM prospects WHERE id IN (${ph})`).run(...ids).changes
  })
  return tx()
}

prospectingRouter.delete('/prospects/:id', requireAdmin, (req, res) => {
  const deleted = deleteProspects([req.params.id])
  if (!deleted) return res.status(404).json({ error: 'Prospecto no encontrado' })
  res.json({ ok: true, deleted })
})

prospectingRouter.post('/prospects/bulk-delete', requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(x => typeof x === 'string') : []
  if (!ids.length) return res.status(400).json({ error: 'Envía un array de ids en el body' })
  const deleted = deleteProspects(ids)
  res.json({ ok: true, deleted })
})

// ── Notas tipo CRM por prospecto ───────────────────────────────────────
prospectingRouter.post('/prospects/:id/notes', requireAdmin, (req, res) => {
  const body = String(req.body?.body || '').trim()
  if (!body) return res.status(400).json({ error: 'La nota está vacía' })
  const exists = db.prepare('SELECT 1 FROM prospects WHERE id = ?').get(req.params.id)
  if (!exists) return res.status(404).json({ error: 'Prospecto no encontrado' })
  const note = { id: randomUUID(), prospect_id: req.params.id, body, created_at: Date.now() }
  db.prepare('INSERT INTO prospect_notes (id, prospect_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run(note.id, note.prospect_id, note.body, note.created_at)
  res.json({ note })
})

prospectingRouter.delete('/notes/:noteId', requireAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM prospect_notes WHERE id = ?').run(req.params.noteId)
  if (!result.changes) return res.status(404).json({ error: 'Nota no encontrada' })
  res.json({ ok: true })
})

prospectingRouter.patch('/prospects/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body || {}
  const VALID = ['new', 'audited', 'contacted', 'followup_2', 'followup_4', 'followup_7', 'won', 'lost', 'do_not_contact']
  if (!VALID.includes(status)) return res.status(400).json({ error: `status inválido, debe ser uno de: ${VALID.join(', ')}` })
  const result = db.prepare('UPDATE prospects SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), req.params.id)
  if (!result.changes) return res.status(404).json({ error: 'Prospecto no encontrado' })
  res.json({ ok: true, status })
})

// ── Paso "Construye": auditoría ────────────────────────────────────────
prospectingRouter.post('/prospects/:id/audit', requireAdmin, async (req, res) => {
  try {
    const result = await auditProspect(req.params.id)
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[prospecting] audit error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Paso "Manda": generar mensaje ──────────────────────────────────────
prospectingRouter.post('/prospects/:id/message', requireAdmin, (req, res) => {
  const { stage, channel, senderName, videoUrl, lang } = req.body || {}
  try {
    const message = generateMessage(req.params.id, stage, { channel, senderName, videoUrl, lang })
    res.json({ ok: true, message })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ── Paso "Manda": enviar (WhatsApp real, Instagram = listo para copiar) ─
prospectingRouter.post('/messages/:messageId/send', requireAdmin, async (req, res) => {
  try {
    const result = await sendProspectMessage(req.params.messageId)
    res.json(result)
  } catch (err) {
    console.error('[prospecting] send error:', err.message)
    res.status(500).json({ error: err.message })
  }
})
