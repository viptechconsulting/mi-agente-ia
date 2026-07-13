import express from 'express'
import path from 'path'
import fs from 'fs'
import multer from 'multer'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import Anthropic from '@anthropic-ai/sdk'
import PDFDocument from 'pdfkit'
import nodemailer from 'nodemailer'
import { requireAdmin, requireSuperAdmin, withCompany } from '../middleware/auth.js'
import {
  db, loadConfig, saveConfig, buildSystemPrompt,
  listCompanies, getCompany, getCompanyByToken, createCompany, updateCompanyMeta, deleteCompany,
  regenerateShareToken, seedSampleContent, getServerSetting, setServerSetting
} from '../db.js'

const require = createRequire(import.meta.url)
const pdfParse = require('pdf-parse/lib/pdf-parse.js')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')
const assetsDir = path.join(rootDir, 'data', 'assets')

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// multer for memory (PDF parse)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

// multer for disk (image upload)
const uploadImage = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(assetsDir, req.company?.id || 'default')
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.png'
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
})

// ============================================================
// HELPERS
// ============================================================
function chunkText(text, size = 800, overlap = 100) {
  const clean = text.replace(/\s+/g, ' ').trim()
  const chunks = []
  for (let i = 0; i < clean.length; i += size - overlap) chunks.push(clean.slice(i, i + size))
  return chunks
}

function extractContacts(text) {
  const emails = [...(text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [])]
  const phones = [...(text.match(/(?:\+?\d[\d\s\-().]{7,}\d)/g) || [])]
  return { emails, phones }
}

function getMailer(cfg) {
  if (!cfg.smtpHost || !cfg.notifyEmail) return null
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: parseInt(cfg.smtpPort) || 587,
    secure: !!cfg.smtpSecure,
    auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined
  })
}

async function buildReportData(companyId, daysBack = 7) {
  const since = Date.now() - daysBack * 86400000
  const cfg = loadConfig(companyId)

  const totalConvs = db.prepare('SELECT COUNT(*) as c FROM conversations WHERE company_id = ? AND created_at > ?').get(companyId, since).c
  const unresolved = db.prepare('SELECT COUNT(*) as c FROM conversations WHERE company_id = ? AND created_at > ? AND unresolved = 1').get(companyId, since).c
  const resolved = totalConvs - unresolved
  const resolutionRate = totalConvs ? Math.round((resolved / totalConvs) * 100) : null
  const byChannel = db.prepare("SELECT COALESCE(channel,'web') as ch, COUNT(*) as c FROM conversations WHERE company_id = ? AND created_at > ? GROUP BY ch").all(companyId, since)
  const userMsgs = db.prepare("SELECT COUNT(*) as c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.company_id = ? AND m.role = 'user' AND m.created_at > ?").get(companyId, since).c
  const up = db.prepare("SELECT COUNT(*) as c FROM ratings r JOIN conversations c ON c.id = r.conversation_id WHERE c.company_id = ? AND r.rating = 1 AND r.created_at > ?").get(companyId, since).c
  const down = db.prepare("SELECT COUNT(*) as c FROM ratings r JOIN conversations c ON c.id = r.conversation_id WHERE c.company_id = ? AND r.rating = -1 AND r.created_at > ?").get(companyId, since).c
  const satisfaction = (up + down) ? Math.round((up / (up + down)) * 100) : null

  const topQuestions = db.prepare(`
    SELECT LOWER(TRIM(m.content)) as q, COUNT(*) as count
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.company_id = ? AND m.role = 'user' AND m.created_at > ? AND LENGTH(m.content) < 200
    GROUP BY q ORDER BY count DESC LIMIT 10
  `).all(companyId, since)

  const unresolvedSamples = db.prepare(`
    SELECT (SELECT content FROM messages WHERE conversation_id = c.id AND role='user' ORDER BY id DESC LIMIT 1) as q
    FROM conversations c WHERE c.company_id = ? AND c.unresolved = 1 AND c.created_at > ? LIMIT 15
  `).all(companyId, since).map(r => r.q).filter(Boolean)

  const allMsgs = db.prepare("SELECT m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.company_id = ? AND m.role = 'user' AND m.created_at > ?").all(companyId, since)
  const emails = new Set(), phones = new Set()
  allMsgs.forEach(m => {
    const c = extractContacts(m.content)
    c.emails.forEach(e => emails.add(e.toLowerCase()))
    c.phones.forEach(p => { const clean = p.replace(/\D/g, ''); if (clean.length >= 8) phones.add(clean) })
  })
  const leads = [...emails].map(e => ({ type: 'email', value: e })).concat([...phones].map(p => ({ type: 'teléfono', value: p })))

  let suggestions = []
  if (topQuestions.length || unresolvedSamples.length) {
    try {
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: `Eres un analista de atención al cliente. Genera 4-6 sugerencias concretas y accionables para mejorar el agente, basándote en las preguntas reales y consultas sin resolver. Devuelve SOLO una lista de sugerencias separadas por "• " al inicio de cada línea.`,
        messages: [{
          role: 'user',
          content: `Negocio: ${cfg.businessName}\n\nPreguntas más frecuentes:\n${topQuestions.map(q => `- ${q.q} (${q.count}x)`).join('\n')}\n\nConsultas sin resolver:\n${unresolvedSamples.map(q => `- ${q}`).join('\n')}`
        }]
      })
      suggestions = resp.content.map(c => c.text || '').join('').split('\n').map(s => s.replace(/^[•\-*]\s*/, '').trim()).filter(Boolean)
    } catch (err) { console.error('Suggestions error:', err.message) }
  }

  return {
    businessName: cfg.businessName, period: `Últimos ${daysBack} días`,
    generatedAt: new Date().toLocaleString('es-MX'),
    totalConvs, unresolved, resolved, resolutionRate, byChannel, userMsgs,
    ratings: { up, down, satisfaction },
    topQuestions, unresolvedSamples, leads, suggestions
  }
}

export const adminRouter = express.Router()

// ============================================================
// PUBLIC: widget config
// ============================================================
adminRouter.get('/config/public', withCompany, (req, res) => {
  const cfg = req.company.config
  res.json({
    companyId: req.company.id,
    slug: req.company.slug,
    businessName: cfg.businessName,
    welcomeMessage: cfg.welcomeMessage,
    welcomeMessageEn: cfg.welcomeMessageEn || '',
    accentColor: cfg.accentColor,
    bgColor: cfg.bgColor,
    userBubbleColor: cfg.userBubbleColor,
    logoUrl: cfg.logoUrl,
    avatarUrl: cfg.avatarUrl,
    widgetPosition: cfg.widgetPosition,
    quickReplies: cfg.quickReplies || []
  })
})

// ============================================================
// COMPANIES (admin)
// ============================================================
adminRouter.get('/companies', requireAdmin, (req, res) => {
  const opts = {}
  if (req.query.demo === '1') opts.demoOnly = true
  if (req.query.demo === '0') opts.excludeDemo = true
  let companies = listCompanies(opts)
  if (!req.isSuperAdmin && req.allowedCompanies) {
    companies = companies.filter(c => req.allowedCompanies.includes(c.id))
  }
  res.json(companies)
})

adminRouter.post('/companies', requireSuperAdmin, (req, res) => {
  const { name, slug } = req.body
  if (!name) return res.status(400).json({ error: 'Falta nombre' })
  try { res.json(createCompany({ name, slug })) }
  catch (err) { res.status(400).json({ error: err.message }) }
})

// ============================================================
// DEMOS (prospect demos, isolated from production)
// ============================================================
adminRouter.post('/demos', requireAdmin, (req, res) => {
  const { name, parentCompanyId, expiresInDays, seedSample } = req.body
  if (!name) return res.status(400).json({ error: 'Falta nombre' })
  try {
    const expiresAt = expiresInDays ? Date.now() + expiresInDays * 86400000 : null
    const company = createCompany({
      name,
      demo: true,
      parentCompanyId: parentCompanyId || null,
      expiresAt
    })
    if (seedSample) seedSampleContent(company.id)
    res.json(company)
  } catch (err) { res.status(400).json({ error: err.message }) }
})

adminRouter.post('/demos/:id/duplicate', requireAdmin, (req, res) => {
  const src = getCompany(req.params.id)
  if (!src) return res.status(404).json({ error: 'No encontrada' })
  try {
    const newDemo = createCompany({
      name: (req.body.name || src.name) + ' (copia)',
      demo: true,
      parentCompanyId: src.id,
      expiresAt: src.expires_at
    })
    // also copy the non-auto-copied config overrides (createCompany already copies config from parent)
    res.json(newDemo)
  } catch (err) { res.status(400).json({ error: err.message }) }
})

adminRouter.post('/demos/:id/seed', requireAdmin, (req, res) => {
  const c = getCompany(req.params.id)
  if (!c || !c.demo) return res.status(404).json({ error: 'Demo no encontrada' })
  seedSampleContent(c.id)
  res.json({ ok: true })
})

adminRouter.post('/demos/:id/regenerate-token', requireAdmin, (req, res) => {
  const c = getCompany(req.params.id)
  if (!c) return res.status(404).json({ error: 'No encontrada' })
  const tok = regenerateShareToken(c.id)
  res.json({ share_token: tok })
})

// Generate or return share token for any active company
adminRouter.post('/company/share-token', requireAdmin, withCompany, (req, res) => {
  const c = req.company
  let tok = c.share_token
  if (!tok) tok = regenerateShareToken(c.id)
  res.json({ share_token: tok, url: `/demo/${tok}` })
})

adminRouter.post('/company/regenerate-share-token', requireAdmin, withCompany, (req, res) => {
  const tok = regenerateShareToken(req.company.id)
  res.json({ share_token: tok, url: `/demo/${tok}` })
})

// Public config by token (used by the demo page widget)
adminRouter.get('/demo/config/:token', (req, res) => {
  const c = getCompanyByToken(req.params.token)
  if (!c) return res.status(404).json({ error: 'Demo no encontrada' })
  if (!c.active) return res.status(403).json({ error: 'Desactivada' })
  if (c.expires_at && Date.now() > c.expires_at) return res.status(403).json({ error: 'Expirada' })
  const cfg = c.config
  res.json({
    companyId: c.id,
    shareToken: c.share_token,
    businessName: cfg.businessName,
    description: cfg.description,
    agentName: cfg.agentName,
    welcomeMessage: cfg.welcomeMessage,
    accentColor: cfg.accentColor,
    bgColor: cfg.bgColor,
    userBubbleColor: cfg.userBubbleColor,
    logoUrl: cfg.logoUrl,
    avatarUrl: cfg.avatarUrl,
    widgetPosition: cfg.widgetPosition,
    quickReplies: cfg.quickReplies || [],
    expiresAt: c.expires_at
  })
})

adminRouter.patch('/companies/:id', requireAdmin, (req, res) => {
  if (!req.isSuperAdmin) return res.status(403).json({ error: 'Solo el administrador principal' })
  try { res.json(updateCompanyMeta(req.params.id, req.body)) }
  catch (err) { res.status(400).json({ error: err.message }) }
})

adminRouter.delete('/companies/:id', requireSuperAdmin, (req, res) => {
  try { deleteCompany(req.params.id); res.json({ ok: true }) }
  catch (err) { res.status(400).json({ error: err.message }) }
})

// ============================================================
// AUTH / USERS
// ============================================================
adminRouter.get('/auth/me', requireAdmin, (req, res) => {
  res.json({
    isSuperAdmin: req.isSuperAdmin || false,
    email: req.userEmail || (req.isSuperAdmin ? (process.env.ADMIN_EMAIL || '') : ''),
    allowedCompanies: req.allowedCompanies
  })
})

adminRouter.get('/users', requireSuperAdmin, (_req, res) => {
  const rows = db.prepare('SELECT id, email, company_ids, active, created_at FROM users ORDER BY created_at DESC').all()
  res.json(rows.map(r => ({ ...r, company_ids: JSON.parse(r.company_ids || '[]') })))
})

adminRouter.post('/users', requireSuperAdmin, (req, res) => {
  const { email, password, company_ids } = req.body || {}
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' })
  const id = crypto.randomUUID()
  try {
    db.prepare('INSERT INTO users (id, email, password_hash, company_ids) VALUES (?,?,?,?)')
      .run(id, email.toLowerCase().trim(), hashPassword(password), JSON.stringify(company_ids || []))
    res.json({ ok: true, id })
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Ese email ya existe' : e.message })
  }
})

adminRouter.patch('/users/:id', requireSuperAdmin, (req, res) => {
  const { password, company_ids, active } = req.body || {}
  const fields = []; const args = []
  if (password)              { fields.push('password_hash = ?'); args.push(hashPassword(password)) }
  if (company_ids !== undefined) { fields.push('company_ids = ?'); args.push(JSON.stringify(company_ids)) }
  if (active !== undefined)  { fields.push('active = ?');        args.push(active ? 1 : 0) }
  if (!fields.length) return res.json({ ok: true })
  args.push(req.params.id)
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...args)
  res.json({ ok: true })
})

adminRouter.delete('/users/:id', requireSuperAdmin, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// ============================================================
// CONFIG (admin, per-company)
// ============================================================
adminRouter.get('/config', requireAdmin, withCompany, (req, res) => res.json(req.company.config))
adminRouter.post('/config', requireAdmin, withCompany, (req, res) => res.json(saveConfig(req.company.id, req.body)))

// ============================================================
// UPLOADS (per-company asset folder)
// ============================================================
adminRouter.post('/upload/image', requireAdmin, withCompany, uploadImage.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta archivo' })
  res.json({ url: `/assets/${req.company.id}/${req.file.filename}` })
})

// ============================================================
// KNOWLEDGE DOCS (scoped to company)
// ============================================================
adminRouter.get('/docs', requireAdmin, withCompany, (req, res) => {
  const docs = db.prepare('SELECT d.id, d.title, d.source, d.created_at, (SELECT COUNT(*) FROM chunks WHERE doc_id = d.id) as chunks FROM documents d WHERE d.company_id = ? ORDER BY created_at DESC').all(req.company.id)
  res.json(docs)
})

adminRouter.post('/docs/text', requireAdmin, withCompany, (req, res) => {
  const { title, content } = req.body
  if (!title || !content) return res.status(400).json({ error: 'Falta título o contenido' })
  const info = db.prepare('INSERT INTO documents (title, source, created_at, company_id) VALUES (?, ?, ?, ?)').run(title, 'text', Date.now(), req.company.id)
  const insert = db.prepare('INSERT INTO chunks (doc_id, title, content) VALUES (?, ?, ?)')
  chunkText(content).forEach(c => insert.run(info.lastInsertRowid, title, c))
  res.json({ id: info.lastInsertRowid })
})

adminRouter.post('/docs/pdf', requireAdmin, withCompany, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Falta archivo' })
    const title = req.body.title || req.file.originalname
    const parsed = await pdfParse(req.file.buffer)
    if (!parsed.text.trim()) return res.status(400).json({ error: 'PDF sin texto extraíble' })
    const info = db.prepare('INSERT INTO documents (title, source, created_at, company_id) VALUES (?, ?, ?, ?)').run(title, 'pdf', Date.now(), req.company.id)
    const insert = db.prepare('INSERT INTO chunks (doc_id, title, content) VALUES (?, ?, ?)')
    const chunks = chunkText(parsed.text)
    chunks.forEach(c => insert.run(info.lastInsertRowid, title, c))
    res.json({ id: info.lastInsertRowid, chunks: chunks.length })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

adminRouter.post('/docs/url', requireAdmin, withCompany, async (req, res) => {
  const { url, title } = req.body
  if (!url) return res.status(400).json({ error: 'Falta URL' })
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgenteScraper/1.0)' },
      signal: AbortSignal.timeout(20000)
    })
    if (!resp.ok) return res.status(400).json({ error: `La página respondió HTTP ${resp.status}` })
    const html = await resp.text()

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    const docTitle = title || (titleMatch ? titleMatch[1].trim() : url)

    // Extract meta description
    const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
                      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i) || [])[1] || ''

    // Extract JSON-LD structured data (useful for JS-heavy sites)
    const jsonLdBlocks = []
    const jsonLdRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    let jm
    while ((jm = jsonLdRe.exec(html)) !== null) {
      try {
        const obj = JSON.parse(jm[1])
        const flatten = (o) => Object.values(o).filter(v => typeof v === 'string' && v.length > 10).join(' ')
        jsonLdBlocks.push(flatten(obj))
      } catch {}
    }

    // Extract og:description
    const ogDesc = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
                    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i) || [])[1] || ''

    const bodyText = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
      .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
      .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
      .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s{2,}/g, ' ').trim()

    const text = [docTitle, metaDesc, ogDesc, ...jsonLdBlocks, bodyText].filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim()

    if (text.length < 30) return res.status(400).json({ error: 'No se pudo extraer contenido útil de esa URL' })

    const info = db.prepare('INSERT INTO documents (title, source, created_at, company_id) VALUES (?, ?, ?, ?)').run(docTitle, url, Date.now(), req.company.id)
    const insert = db.prepare('INSERT INTO chunks (doc_id, title, content) VALUES (?, ?, ?)')
    const chunks = chunkText(text)
    chunks.forEach(c => insert.run(info.lastInsertRowid, docTitle, c))
    res.json({ id: info.lastInsertRowid, chunks: chunks.length, title: docTitle })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

adminRouter.delete('/docs/:id', requireAdmin, withCompany, (req, res) => {
  const id = req.params.id
  const doc = db.prepare('SELECT id FROM documents WHERE id = ? AND company_id = ?').get(id, req.company.id)
  if (!doc) return res.status(404).json({ error: 'No encontrado' })
  db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(id)
  db.prepare('DELETE FROM documents WHERE id = ?').run(id)
  res.json({ ok: true })
})

// ============================================================
// DASHBOARD (scoped)
// ============================================================
adminRouter.get('/dashboard', requireAdmin, withCompany, (req, res) => {
  const cid = req.company.id
  const now = Date.now()
  const dayAgo = now - 86400000
  const weekAgo = now - 7 * 86400000

  const stat = (sql, ...p) => db.prepare(sql).get(...p) || {}
  const totalConvs = stat('SELECT COUNT(*) as c FROM conversations WHERE company_id = ?', cid).c
  const byChannel = db.prepare("SELECT COALESCE(channel,'web') as ch, COUNT(*) as c FROM conversations WHERE company_id = ? GROUP BY ch").all(cid)
  const convsToday = stat('SELECT COUNT(*) as c FROM conversations WHERE company_id = ? AND created_at > ?', cid, dayAgo).c
  const convsWeek = stat('SELECT COUNT(*) as c FROM conversations WHERE company_id = ? AND created_at > ?', cid, weekAgo).c
  const totalMsgs = stat('SELECT COUNT(*) as c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.company_id = ?', cid).c
  const userMsgs = stat("SELECT COUNT(*) as c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.company_id = ? AND m.role = 'user'", cid).c
  const up = stat("SELECT COUNT(*) as c FROM ratings r JOIN conversations c ON c.id = r.conversation_id WHERE c.company_id = ? AND r.rating = 1", cid).c
  const down = stat("SELECT COUNT(*) as c FROM ratings r JOIN conversations c ON c.id = r.conversation_id WHERE c.company_id = ? AND r.rating = -1", cid).c
  const satisfaction = (up + down) ? Math.round((up / (up + down)) * 100) : null
  const unresolved = stat('SELECT COUNT(*) as c FROM conversations WHERE company_id = ? AND unresolved = 1', cid).c

  const topQuestions = db.prepare(`
    SELECT LOWER(TRIM(m.content)) as q, COUNT(*) as count
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.company_id = ? AND m.role = 'user' AND LENGTH(m.content) < 200
    GROUP BY q ORDER BY count DESC LIMIT 10
  `).all(cid)

  const unresolvedList = db.prepare(`
    SELECT c.id, c.created_at, c.visitor_id,
      (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'user' ORDER BY id DESC LIMIT 1) as last_user_msg
    FROM conversations c WHERE c.company_id = ? AND c.unresolved = 1
    ORDER BY c.updated_at DESC LIMIT 20
  `).all(cid)

  const activity = db.prepare(`
    SELECT strftime('%Y-%m-%d', datetime(created_at/1000, 'unixepoch')) as day, COUNT(*) as c
    FROM conversations WHERE company_id = ? AND created_at > ?
    GROUP BY day ORDER BY day
  `).all(cid, weekAgo)

  res.json({
    totalConvs, convsToday, convsWeek, totalMsgs, userMsgs, byChannel,
    ratings: { up, down, satisfaction },
    unresolved, unresolvedList, topQuestions, activity
  })
})

// ============================================================
// AI INSIGHTS
// ============================================================
adminRouter.get('/dashboard/ai-insights', requireAdmin, withCompany, async (req, res) => {
  const cid = req.company.id
  const days = parseInt(req.query.days) || 7
  const since = Date.now() - days * 86400000
  const cfg = req.company.config

  const totalConvs = db.prepare('SELECT COUNT(*) as c FROM conversations WHERE company_id = ? AND created_at > ?').get(cid, since).c
  const leads = db.prepare("SELECT COUNT(*) as c FROM conversations WHERE company_id = ? AND created_at > ? AND (lead_email IS NOT NULL OR lead_phone IS NOT NULL OR lead_name IS NOT NULL)").get(cid, since).c
  const converted = db.prepare("SELECT COUNT(*) as c FROM conversations WHERE company_id = ? AND created_at > ? AND converted = 1").get(cid, since).c
  const leadRate = totalConvs ? Math.round(leads / totalConvs * 100) : 0
  const conversionRate = leads ? Math.round(converted / leads * 100) : 0

  const convSamples = db.prepare(`
    SELECT c.id, c.converted, c.lead_email, c.lead_phone, c.unresolved, c.channel
    FROM conversations c WHERE c.company_id = ? AND c.created_at > ?
    ORDER BY c.created_at DESC LIMIT 20
  `).all(cid, since)

  const convDetails = convSamples.map(conv => {
    const msgs = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id LIMIT 8').all(conv.id)
    const state = conv.converted ? 'CONVERTIDA' : (conv.lead_email || conv.lead_phone) ? 'LEAD' : 'SIN LEAD'
    const dialog = msgs.map(m => `${m.role === 'user' ? 'Cliente' : 'IA'}: ${m.content.slice(0, 150)}`).join('\n')
    return `[${state}] ${dialog}`
  }).join('\n---\n')

  let summary = ''
  let insights = []

  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `Eres experto en optimización de conversión para chatbots de ventas.

Negocio: ${cfg.businessName || 'Sin nombre'}
Período: últimos ${days} días

FUNNEL:
- Conversaciones: ${totalConvs}
- Leads capturados: ${leads} (${leadRate}%)
- Convertidos: ${converted} (${conversionRate}% de leads)

MUESTRA DE CONVERSACIONES:
${convDetails || 'Sin conversaciones recientes.'}

Devuelve SOLO este JSON sin markdown:
{"summary":"2-3 oraciones sobre el estado actual y qué impacta más la conversión","insights":[{"icon":"🎯","title":"título corto","description":"recomendación accionable específica"}]}`
      }]
    })
    const text = resp.content[0]?.text || ''
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[0])
      summary = parsed.summary || ''
      insights = (parsed.insights || []).slice(0, 6)
    }
  } catch (err) { console.error('AI Insights error:', err.message) }

  res.json({
    funnel: { conversations: totalConvs, leads, converted, leadRate, conversionRate },
    summary, insights,
    generatedAt: new Date().toLocaleString('es-MX')
  })
})

// ============================================================
// EMAIL NOTIFICATIONS
// ============================================================
adminRouter.post('/notify/test', requireAdmin, withCompany, async (req, res) => {
  const cfg = req.company.config
  const mailer = getMailer(cfg)
  if (!mailer) return res.status(400).json({ error: 'SMTP no configurado' })
  try {
    await mailer.sendMail({
      from: cfg.smtpFrom || cfg.smtpUser,
      to: cfg.notifyEmail,
      subject: `Test — ${cfg.businessName || 'Agente IA'}`,
      html: `<div style="font-family:Arial"><h2 style="color:${cfg.accentColor}">✓ Email configurado correctamente</h2></div>`
    })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ============================================================
// REPORTS (scoped)
// ============================================================
adminRouter.get('/report/weekly.json', requireAdmin, withCompany, async (req, res) => {
  res.json(await buildReportData(req.company.id, parseInt(req.query.days) || 7))
})

adminRouter.get('/report/weekly.pdf', async (req, res) => {
  if (req.query.pw !== process.env.ADMIN_PASSWORD) return res.status(401).send('No autorizado')
  const companyId = req.query.companyId || req.query.slug || 'default'
  const company = getCompany(companyId)
  if (!company) return res.status(404).send('Empresa no encontrada')
  const days = parseInt(req.query.days) || 7
  const data = await buildReportData(company.id, days)
  const doc = new PDFDocument({ margin: 50, size: 'A4' })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="reporte-${company.slug}-${new Date().toISOString().slice(0, 10)}.pdf"`)
  doc.pipe(res)
  const GOLD = company.config.accentColor || '#D4AF37', DARK = '#0a0a0a', GRAY = '#666'
  doc.fillColor(DARK).fontSize(24).font('Helvetica-Bold').text(data.businessName)
  doc.fillColor(GOLD).fontSize(11).font('Helvetica').text('REPORTE DE ATENCIÓN AL CLIENTE', { characterSpacing: 2 })
  doc.moveDown(0.3)
  doc.fillColor(GRAY).fontSize(9).text(`${data.period} · Generado el ${data.generatedAt}`)
  doc.moveTo(50, doc.y + 8).lineTo(545, doc.y + 8).strokeColor(GOLD).lineWidth(1.5).stroke()
  doc.moveDown(1.5)
  const section = (t) => { doc.moveDown(0.8); doc.fillColor(GOLD).fontSize(10).font('Helvetica-Bold').text(t.toUpperCase(), { characterSpacing: 1.5 }); doc.moveDown(0.4) }
  section('Métricas clave')
  const metrics = [
    ['Total conversaciones', data.totalConvs], ['Mensajes de usuarios', data.userMsgs],
    ['Resueltas', data.resolved], ['Sin resolver', data.unresolved],
    ['Tasa de resolución', data.resolutionRate === null ? '—' : data.resolutionRate + '%'],
    ['Satisfacción', data.ratings.satisfaction === null ? '—' : data.ratings.satisfaction + '%'],
    ['Valoraciones 👍 / 👎', `${data.ratings.up} / ${data.ratings.down}`]
  ]
  doc.fillColor(DARK).fontSize(10).font('Helvetica')
  metrics.forEach(([k, v]) => {
    doc.font('Helvetica').fillColor(GRAY).text(k + ':', 70, doc.y, { continued: true, width: 250 })
    doc.font('Helvetica-Bold').fillColor(DARK).text(' ' + v)
  })
  if (data.byChannel.length) { section('Por canal'); data.byChannel.forEach(c => { doc.font('Helvetica').fillColor(GRAY).text((c.ch==='whatsapp'?'WhatsApp':'Web')+':', 70, doc.y, {continued:true}); doc.font('Helvetica-Bold').fillColor(DARK).text(' '+c.c+' conversaciones') }) }
  section('Preguntas más frecuentes')
  if (data.topQuestions.length) data.topQuestions.forEach((q,i) => { doc.font('Helvetica-Bold').fillColor(GOLD).text(`${i+1}. `, 70, doc.y, {continued:true, width:20}); doc.font('Helvetica').fillColor(DARK).text(`(${q.count}x) `, {continued:true}); doc.fillColor(GRAY).text(q.q.slice(0,150)) })
  else doc.fillColor(GRAY).text('Sin datos.')
  section('Leads capturados')
  if (data.leads.length) { doc.fillColor(DARK).font('Helvetica').text(`Se detectaron ${data.leads.length} contactos únicos:`); doc.moveDown(0.3); data.leads.slice(0,30).forEach(l => { doc.fillColor(GRAY).text('• ', {continued:true}).fillColor(DARK).text(`${l.type}: ${l.value}`) }) }
  else doc.fillColor(GRAY).text('No se detectaron leads en este período.')
  if (data.unresolvedSamples.length) { section('Consultas sin resolver (muestras)'); data.unresolvedSamples.slice(0,8).forEach(q => doc.fillColor(DARK).font('Helvetica').text('• '+q.slice(0,200), {indent:10})) }
  if (data.suggestions.length) { section('Sugerencias de mejora'); data.suggestions.forEach(s => { doc.fillColor(GOLD).font('Helvetica-Bold').text('→ ', {continued:true, indent:10}); doc.fillColor(DARK).font('Helvetica').text(s); doc.moveDown(0.2) }) }
  doc.moveDown(2)
  doc.fillColor(GRAY).fontSize(8).text('Generado automáticamente · '+data.businessName, 50, doc.page.height-60, {align:'center', width:495})
  doc.end()
})

// ============================================================
// TRAINING (scoped)
// ============================================================
adminRouter.get('/training/pending', requireAdmin, withCompany, (req, res) => {
  const rows = db.prepare(`
    SELECT m.id as message_id, m.content as question, m.conversation_id, c.channel,
      (SELECT content FROM messages WHERE conversation_id = m.conversation_id AND role='assistant' AND id > m.id ORDER BY id LIMIT 1) as reply,
      (SELECT rating FROM ratings WHERE message_id = (SELECT id FROM messages WHERE conversation_id = m.conversation_id AND role='assistant' AND id > m.id ORDER BY id LIMIT 1)) as rating
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.role = 'user' AND c.company_id = ?
      AND m.id NOT IN (SELECT message_id FROM training_pairs WHERE message_id IS NOT NULL AND company_id = ?)
      AND (c.unresolved = 1 OR EXISTS (
        SELECT 1 FROM ratings r JOIN messages m2 ON m2.id = r.message_id
        WHERE m2.conversation_id = m.conversation_id AND r.rating = -1
      ))
    ORDER BY m.id DESC LIMIT 50
  `).all(req.company.id, req.company.id)
  res.json(rows)
})

adminRouter.post('/training/teach', requireAdmin, withCompany, (req, res) => {
  const { question, answer, messageId } = req.body
  if (!question || !answer) return res.status(400).json({ error: 'Falta pregunta o respuesta' })
  const info = db.prepare('INSERT INTO training_pairs (question, answer, message_id, created_at, company_id) VALUES (?, ?, ?, ?, ?)').run(question, answer, messageId || null, Date.now(), req.company.id)
  const docTitle = `Entrenada: ${question.slice(0, 60)}`
  const doc = db.prepare('INSERT INTO documents (title, source, created_at, company_id) VALUES (?, ?, ?, ?)').run(docTitle, 'training', Date.now(), req.company.id)
  db.prepare('INSERT INTO chunks (doc_id, title, content) VALUES (?, ?, ?)').run(doc.lastInsertRowid, docTitle, `Pregunta: ${question}\n\nRespuesta: ${answer}`)
  if (messageId) {
    const conv = db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(messageId)
    if (conv) db.prepare('UPDATE conversations SET unresolved = 0 WHERE id = ? AND company_id = ?').run(conv.conversation_id, req.company.id)
  }
  res.json({ id: info.lastInsertRowid })
})

adminRouter.post('/training/ignore', requireAdmin, withCompany, (req, res) => {
  const { messageId } = req.body
  if (!messageId) return res.status(400).json({ error: 'Falta messageId' })
  db.prepare('INSERT INTO training_pairs (question, answer, message_id, created_at, company_id) VALUES (?, ?, ?, ?, ?)').run('', '[ignorada]', messageId, Date.now(), req.company.id)
  res.json({ ok: true })
})

adminRouter.get('/training/list', requireAdmin, withCompany, (req, res) => {
  res.json(db.prepare("SELECT id, question, answer, created_at FROM training_pairs WHERE company_id = ? AND answer != '' AND answer != '[ignorada]' ORDER BY id DESC LIMIT 200").all(req.company.id))
})

adminRouter.delete('/training/:id', requireAdmin, withCompany, (req, res) => {
  const tp = db.prepare('SELECT * FROM training_pairs WHERE id = ? AND company_id = ?').get(req.params.id, req.company.id)
  if (!tp) return res.status(404).json({ error: 'No encontrada' })
  const docTitle = `Entrenada: ${tp.question.slice(0, 60)}`
  const doc = db.prepare('SELECT id FROM documents WHERE title = ? AND source = ? AND company_id = ?').get(docTitle, 'training', req.company.id)
  if (doc) {
    db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(doc.id)
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id)
  }
  db.prepare('DELETE FROM training_pairs WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// ============================================================
// HELPER: hashPassword (needed for user creation)
// ============================================================
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

// ============================================================
// GHL INTEGRATION
// ============================================================

adminRouter.get('/ghl/status', requireAdmin, withCompany, (req, res) => {
  const cfg = loadConfig(req.company.id)
  const g = cfg.ghl || {}
  res.json({ connected: !!(g.api_key && g.location_id), location_name: g.location_name, connected_at: g.connected_at })
})

adminRouter.post('/ghl/test', requireAdmin, withCompany, async (req, res) => {
  const { api_key, location_id } = req.body
  if (!api_key || !location_id) return res.status(400).json({ error: 'Falta api_key o location_id' })
  const { testGhlConnection } = await import('../services/ghl.js')
  const result = await testGhlConnection(api_key, location_id)
  if (result.ok) {
    const cfg = loadConfig(req.company.id)
    cfg.ghl = { api_key, location_id, location_name: result.name, connected_at: new Date().toISOString() }
    saveConfig(req.company.id, cfg)
  }
  res.json(result)
})

adminRouter.delete('/ghl/disconnect', requireAdmin, withCompany, (req, res) => {
  const cfg = loadConfig(req.company.id)
  delete cfg.ghl
  saveConfig(req.company.id, cfg)
  res.json({ ok: true })
})

adminRouter.get('/campaigns/stats', requireAdmin, withCompany, (req, res) => {
  try {
    const since = new Date(); since.setDate(1); since.setHours(0,0,0,0)
    const rows = db.prepare(`
      SELECT campaign_type, COUNT(*) as count
      FROM campaign_log WHERE company_id=? AND sent_at>=? AND status='sent'
      GROUP BY campaign_type
    `).all(req.company.id, since.toISOString())
    res.json({ rows, total: rows.reduce((s,r) => s + r.count, 0) })
  } catch(e) { res.json({ rows: [], total: 0 }) }
})

// GHL webhook — appointment created/deleted (no auth, public)
adminRouter.post('/webhooks/ghl/:token', async (req, res) => {
  res.json({ ok: true })
  const company = getCompanyByToken(req.params.token)
  if (!company) return
  const cfg = loadConfig(company.id)
  if (!cfg.ghl?.api_key) return
  const { type, appointment } = req.body || {}
  if (!appointment?.contactId || !appointment?.id) return
  try {
    const { getContact, normalizePhone, fillTemplate } = await import('../services/ghl.js')
    const { sendWhatsApp: sendWA } = await import('../routes/chat.js')
    const citas = cfg.citas || {}
    const businessName = cfg.businessName || cfg.name || ''
    const apptDate = new Date(appointment.startTime || appointment.start || Date.now())
    const contact = await getContact(cfg.ghl.api_key, appointment.contactId)
    const vars = {
      nombre: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'cliente',
      negocio: businessName, servicio: appointment.title || '',
      link_reserva: cfg.bookingUrl || '',
      fecha: apptDate.toLocaleDateString('es-US', { weekday:'long', month:'long', day:'numeric' }),
      hora:  apptDate.toLocaleTimeString('es-US', { hour:'2-digit', minute:'2-digit' })
    }
    const phone = normalizePhone(contact.phone || '')
    if (!phone) return
    const logRow = db.prepare(`
      INSERT INTO campaign_log(company_id,contact_id,campaign_type,appointment_id,channel,status,error)
      VALUES(?,?,?,?,?,?,?)
    `)
    const isCreate = type === 'AppointmentCreated' || type === 'appointment.created'
    const isDelete = type === 'AppointmentDeleted' || type === 'appointment.deleted' || type === 'AppointmentCancelled'
    if (isCreate && citas.confirm?.enabled) {
      const dup = db.prepare('SELECT 1 FROM campaign_log WHERE company_id=? AND appointment_id=? AND campaign_type=?')
        .get(company.id, appointment.id, 'cita_confirm')
      if (!dup) {
        await sendWA(cfg, phone, fillTemplate(citas.confirm.message, vars))
        logRow.run(company.id, appointment.contactId, 'cita_confirm', appointment.id, 'whatsapp', 'sent', null)
      }
    }
    if (isDelete && citas.cancel?.enabled) {
      await sendWA(cfg, phone, fillTemplate(citas.cancel.message || 'Hola {nombre}, tu cita fue cancelada. Escríbenos para reagendar.', vars))
      logRow.run(company.id, appointment.contactId, 'cita_cancel', appointment.id, 'whatsapp', 'sent', null)
    }
  } catch(e) { console.error('[ghl-webhook]', e.message) }
})

// ============================================================
// SQUARE INTEGRATION
// ============================================================

adminRouter.get('/square/status', requireAdmin, withCompany, async (req, res) => {
  const { hasCredentials } = await import('../services/square.js')
  const cfg = loadConfig(req.company.id)
  res.json({
    configured: hasCredentials(),
    connected: !!(cfg.square?.access_token),
    merchant_name: cfg.square?.merchant_name || null
  })
})

adminRouter.get('/square/connect', requireAdmin, withCompany, async (req, res) => {
  const { hasCredentials, getOAuthUrl } = await import('../services/square.js')
  if (!hasCredentials()) return res.status(503).json({ error: 'Faltan SQUARE_APP_ID / SQUARE_APP_SECRET en el servidor' })
  const state = Buffer.from(JSON.stringify({ cid: req.company.id, ts: Date.now() })).toString('base64url')
  res.redirect(getOAuthUrl(state))
})

adminRouter.get('/square/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error) return res.redirect('/admin?msg=square_denied')
  try {
    const { cid } = JSON.parse(Buffer.from(state, 'base64url').toString())
    const { exchangeCode } = await import('../services/square.js')
    const tokens = await exchangeCode(code)
    const cfg = loadConfig(cid)
    cfg.square = { access_token: tokens.access_token, merchant_id: tokens.merchant_id, merchant_name: tokens.merchant_id || 'Square', connected_at: new Date().toISOString() }
    saveConfig(cid, cfg)
    res.redirect('/admin?msg=square_ok')
  } catch(e) {
    console.error('[square-callback]', e.message)
    res.redirect('/admin?msg=square_error')
  }
})

adminRouter.delete('/square/disconnect', requireAdmin, withCompany, async (req, res) => {
  const cfg = loadConfig(req.company.id)
  if (cfg.square?.access_token) {
    const { revokeToken } = await import('../services/square.js')
    await revokeToken(cfg.square.access_token).catch(() => {})
  }
  saveConfig(req.company.id, { square: null })
  res.json({ ok: true })
})

// ============================================================
// QUICKBOOKS INTEGRATION
// ============================================================

adminRouter.get('/qbo/status', requireAdmin, withCompany, async (req, res) => {
  const { hasCredentials } = await import('../services/qbo.js')
  const cfg = loadConfig(req.company.id)
  res.json({
    configured: hasCredentials(),
    connected: !!(cfg.qbo?.access_token),
    company_name: cfg.qbo?.company_name || null,
    connected_at: cfg.qbo?.connected_at || null
  })
})

adminRouter.get('/qbo/connect', requireAdmin, withCompany, async (req, res) => {
  const { hasCredentials, getOAuthUrl } = await import('../services/qbo.js')
  if (!hasCredentials()) return res.status(503).json({ error: 'Faltan QBO_CLIENT_ID / QBO_CLIENT_SECRET en el servidor' })
  const state = Buffer.from(JSON.stringify({ cid: req.company.id, ts: Date.now() })).toString('base64url')
  res.redirect(getOAuthUrl(state))
})

adminRouter.get('/qbo/callback', async (req, res) => {
  const { code, state, realmId, error } = req.query
  if (error) return res.redirect('/admin?msg=qbo_denied')
  try {
    const { cid } = JSON.parse(Buffer.from(state, 'base64url').toString())
    const { exchangeCode, getCustomers } = await import('../services/qbo.js')
    const tokens = await exchangeCode(code)
    const cfg = loadConfig(cid)
    cfg.qbo = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, realm_id: realmId, connected_at: new Date().toISOString() }
    // Try to get company name
    try {
      const { queryQBO } = await import('../services/qbo.js')
      const r = await queryQBO(tokens.access_token, realmId, 'SELECT CompanyName FROM CompanyInfo')
      cfg.qbo.company_name = r.CompanyInfo?.[0]?.CompanyName || 'QuickBooks'
    } catch(_) {}
    saveConfig(cid, cfg)
    res.redirect('/admin?msg=qbo_ok')
  } catch(e) {
    console.error('[qbo-callback]', e.message)
    res.redirect('/admin?msg=qbo_error')
  }
})

adminRouter.delete('/qbo/disconnect', requireAdmin, withCompany, (req, res) => {
  const cfg = loadConfig(req.company.id)
  delete cfg.qbo
  saveConfig(req.company.id, cfg)
  res.json({ ok: true })
})

// ============================================================
// GENERIC WEBHOOK (Vagaro, Booksy, cualquier app via Zapier)
// ============================================================

adminRouter.post('/webhooks/generic/:token', async (req, res) => {
  res.json({ ok: true, received: true })
  const company = getCompanyByToken(req.params.token)
  if (!company) return
  const cfg = loadConfig(company.id)
  const body = req.body || {}

  // Flexible field extraction — handles multiple payload shapes
  const contact = {
    name:  body.contact?.name  || body.client_name  || body.customer_name || body.name  || [body.first_name, body.last_name].filter(Boolean).join(' ') || '',
    phone: body.contact?.phone || body.client_phone || body.customer_phone || body.phone || body.mobile || '',
    email: body.contact?.email || body.client_email || body.customer_email || body.email || ''
  }
  const appt = {
    id:       body.appointment?.id  || body.booking_id  || body.appointment_id || body.id || `gen_${Date.now()}`,
    service:  body.appointment?.service || body.service_name || body.service || body.title || '',
    datetime: body.appointment?.datetime || body.start_time || body.appointment_datetime || body.booking_date || body.date || ''
  }
  const rawEvent = (body.event || body.event_type || body.type || body.status || '').toLowerCase()
  const isCreate = rawEvent.includes('creat') || rawEvent.includes('book') || rawEvent.includes('schedul') || rawEvent.includes('new') || rawEvent.includes('confirm')
  const isCancel = rawEvent.includes('cancel') || rawEvent.includes('delet') || rawEvent.includes('remov')

  if (!contact.phone) return

  try {
    const { sendWhatsApp } = await import('../routes/chat.js')
    const { fillTemplate, normalizePhone } = await import('../services/ghl.js')
    const phone = normalizePhone(contact.phone)
    if (!phone) return
    const citas = cfg.citas || {}
    const apptDate = appt.datetime ? new Date(appt.datetime) : new Date()
    const vars = {
      nombre: contact.name || 'cliente', negocio: cfg.businessName || cfg.name || '',
      servicio: appt.service, link_reserva: cfg.bookingUrl || '',
      fecha: apptDate.toLocaleDateString('es-US', { weekday:'long', month:'long', day:'numeric' }),
      hora:  apptDate.toLocaleTimeString('es-US', { hour:'2-digit', minute:'2-digit' })
    }
    const logStmt = db.prepare(`
      INSERT INTO campaign_log(company_id,contact_id,campaign_type,appointment_id,channel,status,error)
      VALUES(?,?,?,?,?,?,?)
    `)
    if (isCreate && citas.confirm?.enabled) {
      const dup = db.prepare('SELECT 1 FROM campaign_log WHERE company_id=? AND appointment_id=? AND campaign_type=?')
        .get(company.id, appt.id, 'cita_confirm')
      if (!dup) {
        await sendWhatsApp(cfg, phone, fillTemplate(citas.confirm.message, vars))
        logStmt.run(company.id, contact.phone, 'cita_confirm', appt.id, 'whatsapp', 'sent', null)
      }
    }
    if (isCancel && citas.cancel?.enabled) {
      await sendWhatsApp(cfg, phone, fillTemplate(citas.cancel?.message || 'Hola {nombre}, tu cita fue cancelada. Escríbenos para reagendar.', vars))
      logStmt.run(company.id, contact.phone, 'cita_cancel', appt.id, 'whatsapp', 'sent', null)
    }
  } catch(e) { console.error('[generic-webhook]', e.message) }
})

// ============================================================
// SERVER CONFIG — integration credentials (super admin only)
// ============================================================
adminRouter.get('/server-config/integrations', requireAdmin, (req, res) => {
  res.json({
    square_app_id:      getServerSetting('square_app_id') || process.env.SQUARE_APP_ID || '',
    square_app_secret:  getServerSetting('square_app_secret') ? '••••••••' : (process.env.SQUARE_APP_SECRET ? '••••••••' : ''),
    qbo_client_id:      getServerSetting('qbo_client_id') || process.env.QBO_CLIENT_ID || '',
    qbo_client_secret:  getServerSetting('qbo_client_secret') ? '••••••••' : (process.env.QBO_CLIENT_SECRET ? '••••••••' : ''),
    square_configured:  !!(getServerSetting('square_app_id') || process.env.SQUARE_APP_ID),
    qbo_configured:     !!(getServerSetting('qbo_client_id') || process.env.QBO_CLIENT_ID),
  })
})

adminRouter.post('/server-config/integrations', requireAdmin, (req, res) => {
  const { square_app_id, square_app_secret, qbo_client_id, qbo_client_secret } = req.body
  if (square_app_id    !== undefined) setServerSetting('square_app_id',    square_app_id)
  if (square_app_secret !== undefined && square_app_secret !== '••••••••') setServerSetting('square_app_secret', square_app_secret)
  if (qbo_client_id    !== undefined) setServerSetting('qbo_client_id',    qbo_client_id)
  if (qbo_client_secret !== undefined && qbo_client_secret !== '••••••••') setServerSetting('qbo_client_secret', qbo_client_secret)
  res.json({ ok: true })
})

adminRouter.post('/dashboard/ai-generate-config', requireAdmin, withCompany, async (req, res) => {
  const { info } = req.body
  if (!info || !info.trim()) return res.status(400).json({ error: 'info required' })

  const prompt = `Eres un experto en configurar agentes de IA para negocios. El usuario te dará un párrafo con información general de su empresa. Debes extraer toda la información relevante y generar una configuración completa y profesional para el agente de IA.

INFORMACIÓN DEL NEGOCIO (párrafo libre):
"${info}"

Genera un JSON con EXACTAMENTE esta estructura (todos los campos son requeridos):
{
  "businessName": "nombre del negocio extraído del párrafo",
  "description": "descripción clara del negocio en 2-3 oraciones",
  "industry": "uno de: general | peluqueria | spa | clinica | dental | estetica | gimnasio | restaurante | tienda",
  "hours": "horario de atención en texto (ej: Lun-Vie 9am-6pm)",
  "contact": "email o teléfono de contacto",
  "products": "lista de productos o servicios principales separados por coma",
  "tone": "descripción del tono de voz en 5-10 palabras",
  "welcomeMessage": "mensaje de bienvenida en español (1-2 oraciones, cálido, menciona el negocio)",
  "welcomeMessageEn": "welcome message in English (1-2 sentences, warm, mentions the business)",
  "systemPromptExtra": "instrucciones adicionales para el agente en 2-4 oraciones: qué hacer, qué evitar, objetivos clave",
  "humanHandoffEnabled": true,
  "humanHandoffTriggers": "quiero hablar con una persona\\nhablar con un agente\\nfactura\\ncancelar\\nreembolso\\nqueja",
  "humanHandoffUserMsg": "mensaje que el agente manda al usuario al escalar (1 oración)",
  "agentName": "nombre de persona para el agente, acorde a la industria y cultura del negocio",
  "language": "español",
  "autoDetectLanguage": true,
  "personality": "descripción de personalidad en 2-3 oraciones: cómo se comporta, qué rasgos tiene",
  "voiceExamples": "Ejemplo 1: frase tipica del agente | Ejemplo 2: otra frase tipica | Ejemplo 3: otra mas",
  "defaultResponses": [
    {"situation": "Saludo inicial", "response": "respuesta apropiada para este negocio"},
    {"situation": "No sé la respuesta", "response": "respuesta apropiada"},
    {"situation": "Despedida", "response": "respuesta apropiada"},
    {"situation": "Cliente molesto", "response": "respuesta apropiada"},
    {"situation": "Pregunta por precio", "response": "respuesta apropiada para este negocio"}
  ],
  "faqs": [
    {"q": "pregunta frecuente 1 real para este negocio", "a": "respuesta completa y útil"},
    {"q": "pregunta frecuente 2", "a": "respuesta completa"},
    {"q": "pregunta frecuente 3", "a": "respuesta completa"},
    {"q": "pregunta frecuente 4", "a": "respuesta completa"},
    {"q": "pregunta frecuente 5", "a": "respuesta completa"}
  ],
  "quickReplies": [
    {"label": "etiqueta botón 1 (2-4 palabras)", "message": "mensaje que se envía al clickear"},
    {"label": "etiqueta botón 2", "message": "mensaje"},
    {"label": "etiqueta botón 3", "message": "mensaje"}
  ],
  "officeHours": {
    "enabled": true,
    "timezone": "America/New_York",
    "offlineMessage": "mensaje fuera de horario apropiado para el negocio (2-3 oraciones)",
    "schedule": [
      {"day": 1, "enabled": true, "open": "09:00", "close": "18:00"},
      {"day": 2, "enabled": true, "open": "09:00", "close": "18:00"},
      {"day": 3, "enabled": true, "open": "09:00", "close": "18:00"},
      {"day": 4, "enabled": true, "open": "09:00", "close": "18:00"},
      {"day": 5, "enabled": true, "open": "09:00", "close": "18:00"},
      {"day": 6, "enabled": true, "open": "10:00", "close": "14:00"},
      {"day": 0, "enabled": false, "open": "10:00", "close": "14:00"}
    ]
  }
}

Importante:
- Extrae businessName, industry, horario y contacto directamente del párrafo si están mencionados
- Adapta TODO al tipo de negocio específico detectado
- Los FAQs deben ser preguntas reales que haría un cliente de este negocio
- Los botones rápidos deben ser las acciones más comunes del negocio
- El horario en officeHours.schedule debe coincidir con el horario mencionado
- Responde ÚNICAMENTE con el JSON válido, sin texto adicional`

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    })
    const raw = msg.content[0].text.trim()
    // Extract outermost JSON object robustly
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end === -1) return res.status(500).json({ error: 'No JSON in response' })
    const jsonStr = raw.slice(start, end + 1)
    let generated
    try {
      generated = JSON.parse(jsonStr)
    } catch (parseErr) {
      // Log raw for debugging
      console.error('[ai-generate-config] JSON parse error:', parseErr.message)
      console.error('[ai-generate-config] Raw:', jsonStr.slice(0, 500))
      return res.status(500).json({ error: 'JSON inválido generado por la IA. Intenta de nuevo.' })
    }
    res.json(generated)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Manual trigger for Lynkro follow-up job (testing/admin)
adminRouter.post('/jobs/lynkro-followup', requireAdmin, async (req, res) => {
  try {
    const { runLynkroFollowUp } = await import('../routes/chat.js')
    await runLynkroFollowUp()
    res.json({ ok: true, message: 'Lynkro follow-up job ejecutado' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})
