// routes/prospecting.js — "La Máquina de Tu Primer Cliente" (Apify)
//
// Herramienta interna, protegida con requireAdmin: no es una feature de
// Lynkro para sus clientes, es cómo Vip Tech/Lynkro consigue los propios.
import express from 'express'
import { db } from '../db.js'
import { requireAdmin } from '../middleware/auth.js'
import { runProspectingBatch } from '../services/prospecting-scraper.js'
import { auditProspect } from '../services/prospecting-audit.js'
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
prospectingRouter.post('/batches', requireAdmin, async (req, res) => {
  const { niche, city, serviceOffered, limit } = req.body || {}
  if (!niche || !city) return res.status(400).json({ error: 'niche y city son obligatorios' })
  try {
    const result = await runProspectingBatch({ niche, city, serviceOffered, limit })
    const batch = db.prepare('SELECT * FROM prospect_batches WHERE id = ?').get(result.batchId)
    res.json({ ok: true, batch })
  } catch (err) {
    console.error('[prospecting] batch error:', err.message)
    res.status(500).json({ error: err.message })
  }
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
  res.json({ prospect: withTier(prospect), audits, messages })
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
  const { stage, channel, senderName, videoUrl } = req.body || {}
  try {
    const message = generateMessage(req.params.id, stage, { channel, senderName, videoUrl })
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
