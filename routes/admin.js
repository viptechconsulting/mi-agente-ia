import express from 'express'
import path from 'path'
import fs from 'fs'
import dns from 'dns'
import multer from 'multer'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import Anthropic from '@anthropic-ai/sdk'
import PDFDocument from 'pdfkit'
import nodemailer from 'nodemailer'
import { requireAdmin, requireSuperAdmin, withCompany, verifyCredentials, createSession, revokeSession, signState, verifyState } from '../middleware/auth.js'
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

// Translate description + quickReplies into cfg.language, cached on the
// company record (config._i18n[lang]) so the AI call only runs once per
// company/language until the source text actually changes.
async function getTranslatedContent(company) {
  const cfg = company.config
  const lang = cfg.language
  const original = { description: cfg.description || '', quickReplies: cfg.quickReplies || [] }
  if (!lang || lang === 'español') return original

  const cache = cfg._i18n?.[lang]
  const sourceMatches = cache
    && cache.sourceDescription === original.description
    && JSON.stringify(cache.sourceQuickReplies || []) === JSON.stringify(original.quickReplies)
  if (sourceMatches) return { description: cache.description, quickReplies: cache.quickReplies }

  if (!original.description && !original.quickReplies.length) return original

  try {
    const prompt = `Traduce al ${lang} los siguientes textos de un negocio, manteniendo el mismo tono, longitud y formato. Responde ÚNICAMENTE con JSON válido, sin texto adicional, con esta estructura exacta:
{"description": "texto traducido", "quickReplies": [{"label": "etiqueta traducida", "message": "mensaje traducido"}]}

TEXTOS ORIGINALES (español):
description: ${JSON.stringify(original.description)}
quickReplies: ${JSON.stringify(original.quickReplies)}`
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
    const raw = msg.content[0].text.trim()
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end === -1) throw new Error('No JSON in translation response')
    const parsed = JSON.parse(raw.slice(start, end + 1))
    const translated = {
      description: parsed.description || original.description,
      quickReplies: Array.isArray(parsed.quickReplies) && parsed.quickReplies.length ? parsed.quickReplies : original.quickReplies
    }
    saveConfig(company.id, {
      _i18n: { ...(cfg._i18n || {}), [lang]: { sourceDescription: original.description, sourceQuickReplies: original.quickReplies, ...translated } }
    })
    return translated
  } catch (err) {
    console.error('[i18n translate] Error:', err.message)
    return original
  }
}

adminRouter.get('/config/public', withCompany, async (req, res) => {
  const cfg = req.company.config
  const { quickReplies } = await getTranslatedContent(req.company)
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
    quickReplies,
    language: cfg.language || 'español'
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
adminRouter.get('/demo/config/:token', async (req, res) => {
  const c = getCompanyByToken(req.params.token)
  if (!c) return res.status(404).json({ error: 'Demo no encontrada' })
  if (!c.active) return res.status(403).json({ error: 'Desactivada' })
  if (c.expires_at && Date.now() > c.expires_at) {
    return res.status(403).json({ error: c.demo ? 'Expirada' : 'Tu enlace ha expirado. Si quieres que sea reactivado, por favor envía un email a hello@lynkro.io' })
  }
  const cfg = c.config
  const { description, quickReplies } = await getTranslatedContent(c)
  res.json({
    companyId: c.id,
    shareToken: c.share_token,
    businessName: cfg.businessName,
    description,
    agentName: cfg.agentName,
    welcomeMessage: cfg.welcomeMessage,
    welcomeMessageEn: cfg.welcomeMessageEn || '',
    accentColor: cfg.accentColor,
    bgColor: cfg.bgColor,
    userBubbleColor: cfg.userBubbleColor,
    logoUrl: cfg.logoUrl,
    avatarUrl: cfg.avatarUrl,
    widgetPosition: cfg.widgetPosition,
    quickReplies,
    expiresAt: c.expires_at,
    language: cfg.language || 'español'
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

// Exchanges real credentials for a short-lived opaque session token.
// The client stores only this token (never the password) — see admin.html login().
adminRouter.post('/auth/login', express.json(), (req, res) => {
  const { email, password } = req.body || {}
  const normalizedEmail = String(email || '').toLowerCase().trim()
  const result = verifyCredentials(String(password || ''), normalizedEmail)
  if (!result) {
    console.warn(JSON.stringify({ event: 'auth_failure', ip: req.ip, path: req.originalUrl, email: normalizedEmail || null, ts: new Date().toISOString() }))
    return res.status(401).json({ error: 'No autorizado' })
  }
  const token = createSession(result)
  res.json({ token, isSuperAdmin: result.isSuperAdmin })
})

adminRouter.post('/auth/logout', requireAdmin, (req, res) => {
  const token = req.headers['x-admin-password'] || req.query.adminPassword
  if (token) revokeSession(token)
  res.json({ ok: true })
})

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

function isPrivateOrReservedIp(ip) {
  return /^10\.|^127\.|^169\.254\.|^192\.168\.|^0\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip) || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd')
}

async function assertPublicUrl(parsedUrl) {
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Protocolo no permitido')
  let address
  try { ({ address } = await dns.promises.lookup(parsedUrl.hostname)) }
  catch { throw new Error('No se pudo resolver el host') }
  if (isPrivateOrReservedIp(address)) throw new Error('Host no permitido')
}

// Fetches a URL while re-validating every redirect hop against internal/private
// addresses, instead of either blindly following redirects (SSRF) or rejecting
// them outright (breaks ordinary http->https / www redirects).
async function safeFetch(startUrl, maxRedirects = 5) {
  let current = startUrl
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicUrl(current)
    const resp = await fetch(current, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgenteScraper/1.0)' },
      signal: AbortSignal.timeout(20000),
      redirect: 'manual'
    })
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get('location')
      if (!location) return resp
      current = new URL(location, current)
      continue
    }
    return resp
  }
  throw new Error('Demasiadas redirecciones')
}

adminRouter.post('/docs/url', requireAdmin, withCompany, async (req, res) => {
  const { url, title } = req.body
  if (!url) return res.status(400).json({ error: 'Falta URL' })
  let parsedUrl
  try { parsedUrl = new URL(url) } catch { return res.status(400).json({ error: 'URL inválida' }) }
  try {
    const resp = await safeFetch(parsedUrl)
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
// LYNKRO FUNNEL — dashboard del funnel de calificación (solo empresa Lynkro)
// ============================================================
// Debe coincidir con LYNKRO_COMPANY_ID en routes/chat.js. No se importa de ahí
// porque chat.js tiene side-effects al importarse (arranca sesiones WhatsApp).
const LYNKRO_COMPANY_ID = '4a945bfd-5090-472e-a3e4-a137c1da56c9'

function lynkroEtapa(cur, flags) {
  if (flags.do_not_contact || cur === 'DO_NOT_CONTACT') return 'No contactar'
  if (flags.demo_done) return 'Demo hecho'
  switch (cur) {
    case 'OPENING':
    case 'BUSINESS_TYPE': return 'Primer contacto'
    case 'VOLUME_DISCOVERY':
    case 'TICKET_DISCOVERY': return 'Calificando'
    case 'DEMO_OFFERED': return 'Demo ofrecido'
    case 'QUESTION_HANDLING': return 'Objeción/duda'
    case 'LOW_VOLUME_CLOSE': return 'No califica'
    case 'CONVERSATION_COMPLETE': return 'Cerrada'
    case 'HUMAN_HANDOFF': return 'A humano'
    default: return 'Primer contacto'
  }
}

// Teléfono real del lead o '' si no hay uno utilizable.
// Instagram NO expone teléfono (visitor_id es un id interno); WhatsApp en modo
// privado llega como '...@lid' y también oculta el número. Solo devolvemos un
// número si: (a) el lead lo dio en el chat, o (b) es un jid de WhatsApp normal.
function cleanPhone(s) {
  if (!s) return ''
  const d = String(s).replace(/[^\d]/g, '')
  return /^\d{7,15}$/.test(d) ? d : ''
}
function lynkroPhone(channel, visitorId, capturedFields) {
  const cf = capturedFields || {}
  const given = cleanPhone(cf.whatsapp) || cleanPhone(cf.phone)
  if (given) return given
  const raw = (visitorId || '').replace(/^wa:|^ig:/, '')
  if (channel === 'whatsapp' && !/@lid/i.test(raw)) {
    const num = cleanPhone(raw.replace(/@.*$/, ''))
    if (num) return num
  }
  return ''
}

// Mapeo etapa → lista operativa del usuario (5 listas del manual).
function lynkroLista(etapa, snoozeActive, inReeng) {
  if (snoozeActive) return 'retomar'
  if (etapa === 'No contactar' || etapa === 'No califica' || etapa === 'Cerrada') return 'no_interesado'
  if (etapa === 'Demo hecho') return 'demo_completado'
  if (etapa === 'Demo ofrecido') return 'esperando_demo'
  if (inReeng) return 'retomar'
  return 'en_conversacion'
}

function buildLynkroFunnel() {
  const rows = db.prepare(`
    SELECT id, visitor_id, channel, updated_at, flow_state, lead_name, lead_phone, do_not_contact
    FROM conversations
    WHERE company_id = ? AND channel IN ('whatsapp','instagram')
    ORDER BY updated_at DESC
  `).all(LYNKRO_COMPANY_ID)

  const tiles = { conversaciones: 0, respondieron: 0, calificados: 0, demoHecho: 0, noContactar: 0 }
  const porVertical = { clinica_estetica: 0, salon_belleza: 0, ecommerce: 0, otro: 0, sin: 0 }
  const porTemperatura = { CALIENTE: 0, TIBIO: 0, FRIO: 0, sin: 0 }
  const objeciones = { PRECIO: 0, TIMING: 0, PENSARLO: 0, CONSULTAR: 0, DESCONFIANZA: 0 }
  const followups = { fu1: 0, fu2: 0, fu3: 0, reeng30: 0, reeng60: 0, reeng90: 0, postDemo: 0 }
  const listas = { en_conversacion: 0, esperando_demo: 0, demo_completado: 0, no_interesado: 0, retomar: 0 }
  const leads = []
  const now = Date.now()
  const D30ms = 30 * 24 * 60 * 60 * 1000

  for (const r of rows) {
    let fs = {}
    try { fs = r.flow_state ? JSON.parse(r.flow_state) : {} } catch {}
    const lq = fs.leadQuali || {}
    tiles.conversaciones++

    const um = db.prepare("SELECT COUNT(*) c, MAX(created_at) t FROM messages WHERE conversation_id = ? AND role='user'").get(r.id)
    const userCount = um.c
    const lastUserAt = um.t || r.updated_at
    if (userCount >= 2) tiles.respondieron++   // engaged más allá del primer mensaje

    const qualified = (lq.volume_level === 'MEDIO' || lq.volume_level === 'ALTO') && !!lq.captured_fields?.website && !!lq.captured_fields?.instagram
    if (qualified) tiles.calificados++
    if (fs.demo_done) tiles.demoHecho++
    const dnc = r.do_not_contact === 1 || lq.current_state === 'DO_NOT_CONTACT'
    if (dnc) tiles.noContactar++

    porVertical[lq.vertical || 'sin'] = (porVertical[lq.vertical || 'sin'] || 0) + 1
    porTemperatura[lq.temperature || 'sin'] = (porTemperatura[lq.temperature || 'sin'] || 0) + 1
    if (lq.objection_type && objeciones[lq.objection_type] != null) objeciones[lq.objection_type]++

    for (const k of ['fu1', 'fu2', 'fu3', 'reeng30', 'reeng60', 'reeng90']) if (fs[k]) followups[k]++
    if (fs.post_demo_sent) followups.postDemo++

    const etapa = lynkroEtapa(lq.current_state, { do_not_contact: dnc, demo_done: fs.demo_done })
    const snoozeActive = !!fs.snooze_until && now < fs.snooze_until
    const inReeng = lq.temperature === 'FRIO' || (now - lastUserAt) >= D30ms
    const lista = lynkroLista(etapa, snoozeActive, inReeng)
    listas[lista]++

    leads.push({
      id: r.id,
      name: r.lead_name || null,
      phone: lynkroPhone(r.channel, r.visitor_id, lq.captured_fields),
      channel: r.channel,
      etapa,
      lista,
      snooze_until: fs.snooze_until || null,
      vertical: lq.vertical || null,
      temperature: lq.temperature || null,
      objection: lq.objection_type || null,
      business_type: lq.business_type || null,
      resumen: lq.conversation_summary || '',
      updated_at: r.updated_at,
      demo_done: !!fs.demo_done,
      do_not_contact: dnc
    })
  }

  return { tiles, porVertical, porTemperatura, objeciones, followups, listas, leads }
}

adminRouter.get('/dashboard/lynkro-funnel', requireAdmin, withCompany, (req, res) => {
  if (req.company.id !== LYNKRO_COMPANY_ID) return res.json({ lynkro: false })
  res.json({ lynkro: true, ...buildLynkroFunnel() })
})

// Export CSV de la lista de leads (respeta el filtro de lista activo: ?lista=xxx).
const LYNKRO_LISTA_LABEL = { en_conversacion: 'En conversación', esperando_demo: 'Esperando demo', demo_completado: 'Demo completado', no_interesado: 'No interesado', retomar: 'Retomar' }
adminRouter.get('/dashboard/lynkro-funnel.csv', requireAdmin, withCompany, (req, res) => {
  if (req.company.id !== LYNKRO_COMPANY_ID) return res.status(404).send('No disponible')
  const { leads } = buildLynkroFunnel()
  const lista = req.query.lista
  const rows = (lista && lista !== 'all') ? leads.filter(l => l.lista === lista) : leads
  const esc = v => '"' + (v == null ? '' : String(v)).replace(/"/g, '""') + '"'
  const header = ['Teléfono', 'Canal', 'Nombre', 'Negocio', 'Etapa', 'Lista', 'Resumen de la conversación', 'Última actividad']
  const out = [header.map(esc).join(',')]
  const chLabel = { whatsapp: 'WhatsApp', instagram: 'Instagram' }
  for (const l of rows) {
    const when = l.updated_at ? new Date(l.updated_at).toISOString().slice(0, 10) : ''
    out.push([l.phone, chLabel[l.channel] || l.channel, l.name || '', l.business_type || '', l.etapa, LYNKRO_LISTA_LABEL[l.lista] || l.lista, l.resumen || '', when].map(esc).join(','))
  }
  const csv = String.fromCharCode(0xFEFF) + out.join('\r\n') // BOM para que Excel respete acentos
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="lynkro-leads-${lista || 'todos'}.csv"`)
  res.send(csv)
})

// ============================================================
// ASESOR IA — chat que revisa la cuenta real y recomienda acciones
// ============================================================
adminRouter.post('/dashboard/advisor', requireAdmin, withCompany, async (req, res) => {
  const cid = req.company.id
  const cfg = req.company.config || {}

  // Contexto: funnel (si es Lynkro) + muestra de conversaciones reales.
  let contexto = `NEGOCIO: ${cfg.businessName || 'Sin nombre'} — industria: ${cfg.industry || 'n/d'}.`
  if (cid === LYNKRO_COMPANY_ID) {
    const f = buildLynkroFunnel()
    const conNum = f.leads.filter(l => l.phone).length
    contexto += `\n\nFUNNEL LYNKRO (datos reales):
- Tiles: ${JSON.stringify(f.tiles)}
- Listas: ${JSON.stringify(f.listas)}
- Por rubro: ${JSON.stringify(f.porVertical)}
- Por temperatura: ${JSON.stringify(f.porTemperatura)}
- Objeciones detectadas: ${JSON.stringify(f.objeciones)}
- Follow-ups enviados: ${JSON.stringify(f.followups)}
- Teléfonos: solo ${conNum} de ${f.leads.length} leads tienen número real (el resto es Instagram o WhatsApp en modo privado @lid).`
  } else {
    const tot = db.prepare('SELECT COUNT(*) c FROM conversations WHERE company_id = ?').get(cid).c
    const leads = db.prepare("SELECT COUNT(*) c FROM conversations WHERE company_id = ? AND (lead_email IS NOT NULL OR lead_phone IS NOT NULL)").get(cid).c
    contexto += `\n\nFUNNEL: ${tot} conversaciones, ${leads} con datos de contacto.`
  }

  const samples = db.prepare('SELECT id, channel FROM conversations WHERE company_id = ? ORDER BY updated_at DESC LIMIT 15').all(cid)
  const dialogos = samples.map(s => {
    const msgs = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id LIMIT 10').all(s.id)
    if (!msgs.length) return null
    return `[${s.channel}]\n` + msgs.map(m => `${m.role === 'user' ? 'Cliente' : 'Agente'}: ${(m.content || '').slice(0, 220)}`).join('\n')
  }).filter(Boolean).join('\n---\n')
  if (dialogos) contexto += `\n\nMUESTRA DE ${samples.length} CONVERSACIONES RECIENTES:\n${dialogos}`

  const system = `Eres un asesor experto en ventas y operaciones para ${cfg.businessName || 'este negocio'} (Lynkro vende agentes de IA que responden WhatsApp/Instagram a negocios de servicios). Revisas la cuenta REAL del usuario y le dices, directo y accionable, qué funciona, qué falla y qué debería hacer que hoy no hace. El usuario implementa todo a mano, así que da pasos concretos y priorizados, específicos a SUS datos — nada de consejos genéricos. Responde en español, sin introducciones largas ni relleno. Usa viñetas cortas cuando ayude.

CONTEXTO DE LA CUENTA:
${contexto}`

  const INITIAL = 'Dame el diagnóstico inicial de mi cuenta: qué está funcionando, qué está fallando, y las 3-5 cosas más importantes que debería hacer y hoy no estoy haciendo. Prioriza y sé concreto con mis datos.'
  const chat = Array.isArray(req.body?.messages)
    ? req.body.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content).map(m => ({ role: m.role, content: String(m.content).slice(0, 4000) }))
    : []
  const convo = [{ role: 'user', content: INITIAL }, ...chat] // siempre arranca con user (requisito de la API)

  try {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1600,
      system,
      messages: convo
    })
    const reply = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
    res.json({ reply: reply || 'No pude generar una respuesta.' })
  } catch (err) {
    console.error('[advisor]', err.message)
    res.status(500).json({ error: 'No se pudo consultar al asesor.' })
  }
})

// Marcar "Demo hecho" → dispara el follow-up post-demo 24h después (runLynkroFollowUp).
adminRouter.post('/lynkro/conversations/:id/demo-done', requireAdmin, (req, res) => {
  const conv = db.prepare('SELECT id, company_id, flow_state FROM conversations WHERE id = ?').get(req.params.id)
  if (!conv || conv.company_id !== LYNKRO_COMPANY_ID) return res.status(404).json({ error: 'Conversación no encontrada' })
  let fs = {}
  try { fs = conv.flow_state ? JSON.parse(conv.flow_state) : {} } catch {}
  const done = req.body?.done !== false // default true; {done:false} desmarca
  if (done) { fs.demo_done = true; fs.demo_done_at = Date.now(); delete fs.post_demo_sent }
  else { delete fs.demo_done; delete fs.demo_done_at }
  db.prepare('UPDATE conversations SET flow_state = ? WHERE id = ?').run(JSON.stringify(fs), conv.id)
  res.json({ ok: true, demo_done: !!fs.demo_done })
})

// Marcar / desmarcar "No contactar" — el job de follow-up respeta do_not_contact.
adminRouter.post('/lynkro/conversations/:id/do-not-contact', requireAdmin, (req, res) => {
  const conv = db.prepare('SELECT id, company_id FROM conversations WHERE id = ?').get(req.params.id)
  if (!conv || conv.company_id !== LYNKRO_COMPANY_ID) return res.status(404).json({ error: 'Conversación no encontrada' })
  const val = req.body?.value === false ? 0 : 1
  db.prepare('UPDATE conversations SET do_not_contact = ? WHERE id = ?').run(val, conv.id)
  res.json({ ok: true, do_not_contact: val })
})

// "Retomar en X meses" — snooze manual. months=0 cancela. Mientras dure, el job de
// follow-up guarda silencio; al vencer, manda UN mensaje de reactivación (ver chat.js).
adminRouter.post('/lynkro/conversations/:id/snooze', requireAdmin, (req, res) => {
  const conv = db.prepare('SELECT id, company_id, flow_state FROM conversations WHERE id = ?').get(req.params.id)
  if (!conv || conv.company_id !== LYNKRO_COMPANY_ID) return res.status(404).json({ error: 'Conversación no encontrada' })
  const months = Math.max(0, Math.min(24, parseInt(req.body?.months) || 0))
  let fs = {}
  try { fs = conv.flow_state ? JSON.parse(conv.flow_state) : {} } catch {}
  if (months > 0) { fs.snooze_until = Date.now() + months * 30 * 24 * 60 * 60 * 1000; delete fs.snooze_done }
  else { delete fs.snooze_until; delete fs.snooze_done }
  db.prepare('UPDATE conversations SET flow_state = ? WHERE id = ?').run(JSON.stringify(fs), conv.id)
  res.json({ ok: true, snooze_until: fs.snooze_until || null, months })
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

adminRouter.get('/report/weekly.pdf', requireAdmin, withCompany, async (req, res) => {
  const company = req.company
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

// ============================================================
// TWILIO SMS INTEGRATION
// ============================================================

adminRouter.get('/twilio/status', requireAdmin, withCompany, (req, res) => {
  const cfg = loadConfig(req.company.id)
  const t = cfg.twilio || {}
  res.json({ connected: !!(t.accountSid && t.authToken && t.fromNumber), fromNumber: t.fromNumber || null, connected_at: t.connected_at || null })
})

adminRouter.post('/twilio/test', requireAdmin, withCompany, async (req, res) => {
  const { accountSid, authToken, fromNumber } = req.body
  if (!accountSid || !authToken || !fromNumber) return res.status(400).json({ error: 'Falta Account SID, Auth Token o número From' })
  try {
    const { getAccountInfo } = await import('../services/twilio.js')
    const account = await getAccountInfo(accountSid, authToken)
    const cfg = loadConfig(req.company.id)
    cfg.twilio = { accountSid, authToken, fromNumber, connected_at: new Date().toISOString() }
    saveConfig(req.company.id, cfg)
    res.json({ ok: true, name: account.friendly_name || 'Twilio' })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

adminRouter.delete('/twilio/disconnect', requireAdmin, withCompany, (req, res) => {
  const cfg = loadConfig(req.company.id)
  delete cfg.twilio
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

// Optional HMAC check on top of the path token, gated behind a per-company
// `webhookSigningSecret` in config. When unset (the default for every
// existing company), behavior is unchanged — path-token-only auth.
// Note: verifies against JSON.stringify(req.body) rather than the exact raw
// bytes (the body is already parsed by the global express.json() middleware
// by the time it reaches here), so the sender must serialize the payload
// the same way. Good enough for an opt-in feature; a byte-exact raw-body
// check would require moving these routes ahead of the global JSON parser.
function verifyOptionalWebhookSignature(req, cfg) {
  if (!cfg.webhookSigningSecret) return true
  const sig = req.headers['x-webhook-signature'] || ''
  const expected = crypto.createHmac('sha256', cfg.webhookSigningSecret).update(JSON.stringify(req.body || {})).digest('hex')
  const a = Buffer.from(String(sig)), b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// GHL webhook — appointment created/deleted (path-token auth; optional HMAC — see above)
adminRouter.post('/webhooks/ghl/:token', async (req, res) => {
  res.json({ ok: true })
  const company = getCompanyByToken(req.params.token)
  if (!company) return
  const cfg = loadConfig(company.id)
  if (!cfg.ghl?.api_key) return
  if (!verifyOptionalWebhookSignature(req, cfg)) { console.warn('[ghl-webhook] invalid signature for company', company.id); return }
  const { type, appointment } = req.body || {}
  if (!appointment?.contactId || !appointment?.id) return
  try {
    const { getContact, normalizePhone, fillTemplate } = await import('../services/ghl.js')
    const { sendWhatsApp: sendWA, sendSMS } = await import('../routes/chat.js')
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
        const confirmMsg = fillTemplate(citas.confirm.message, vars)
        await sendWA(cfg, phone, confirmMsg)
        await sendSMS(cfg, phone, confirmMsg)
        logRow.run(company.id, appointment.contactId, 'cita_confirm', appointment.id, 'whatsapp', 'sent', null)
      }
    }
    if (isDelete && citas.cancel?.enabled) {
      const cancelMsg = fillTemplate(citas.cancel.message || 'Hola {nombre}, tu cita fue cancelada. Escríbenos para reagendar.', vars)
      await sendWA(cfg, phone, cancelMsg)
      await sendSMS(cfg, phone, cancelMsg)
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
  const state = signState({ cid: req.company.id })
  res.redirect(getOAuthUrl(state))
})

adminRouter.get('/square/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error) return res.redirect('/admin?msg=square_denied')
  try {
    const parsed = verifyState(state)
    if (!parsed) return res.redirect('/admin?msg=square_error')
    const { cid } = parsed
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
// GOOGLE CALENDAR INTEGRATION
// ============================================================

adminRouter.get('/google-calendar/status', requireAdmin, withCompany, async (req, res) => {
  const cfg = loadConfig(req.company.id)
  res.json({
    connected: !!(cfg.googleCalendar?.refresh_token),
    calendar_id: cfg.googleCalendar?.calendar_id || null
  })
})

adminRouter.get('/google-calendar/connect', requireAdmin, withCompany, async (req, res) => {
  const { hasCredentials, getOAuthUrl } = await import('../services/google-calendar.js')
  if (!hasCredentials()) return res.status(503).json({ error: 'Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en el servidor' })
  const state = signState({ cid: req.company.id })
  res.redirect(getOAuthUrl(state))
})

adminRouter.get('/google-calendar/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error) return res.redirect('/admin?msg=google_denied')
  try {
    const parsed = verifyState(state)
    if (!parsed) return res.redirect('/admin?msg=google_error')
    const { cid } = parsed
    const { exchangeCode } = await import('../services/google-calendar.js')
    const tokens = await exchangeCode(code)
    const cfg = loadConfig(cid)
    cfg.googleCalendar = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in * 1000),
      calendar_id: 'primary',
      connected_at: new Date().toISOString()
    }
    saveConfig(cid, cfg)
    res.redirect('/admin?msg=google_ok')
  } catch (e) {
    console.error('[google-calendar-callback]', e.message)
    res.redirect('/admin?msg=google_error')
  }
})

adminRouter.delete('/google-calendar/disconnect', requireAdmin, withCompany, async (req, res) => {
  saveConfig(req.company.id, { googleCalendar: null })
  res.json({ ok: true })
})

adminRouter.post('/calendar-provider', requireAdmin, withCompany, async (req, res) => {
  const { provider } = req.body
  if (![null, 'square', 'ghl', 'google'].includes(provider)) {
    return res.status(400).json({ error: 'Proveedor inválido' })
  }
  const cfg = loadConfig(req.company.id)
  cfg.calendarProvider = provider
  saveConfig(req.company.id, cfg)
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
  const state = signState({ cid: req.company.id })
  res.redirect(getOAuthUrl(state))
})

adminRouter.get('/qbo/callback', async (req, res) => {
  const { code, state, realmId, error } = req.query
  if (error) return res.redirect('/admin?msg=qbo_denied')
  try {
    const parsed = verifyState(state)
    if (!parsed) return res.redirect('/admin?msg=qbo_error')
    const { cid } = parsed
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
  if (!verifyOptionalWebhookSignature(req, cfg)) { console.warn('[generic-webhook] invalid signature for company', company.id); return }
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
    const { sendWhatsApp, sendSMS } = await import('../routes/chat.js')
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
        const confirmMsg = fillTemplate(citas.confirm.message, vars)
        await sendWhatsApp(cfg, phone, confirmMsg)
        await sendSMS(cfg, phone, confirmMsg)
        logStmt.run(company.id, contact.phone, 'cita_confirm', appt.id, 'whatsapp', 'sent', null)
      }
    }
    if (isCancel && citas.cancel?.enabled) {
      const cancelMsg = fillTemplate(citas.cancel?.message || 'Hola {nombre}, tu cita fue cancelada. Escríbenos para reagendar.', vars)
      await sendWhatsApp(cfg, phone, cancelMsg)
      await sendSMS(cfg, phone, cancelMsg)
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
    google_client_id:      getServerSetting('google_client_id') || process.env.GOOGLE_CLIENT_ID || '',
    google_client_secret:  getServerSetting('google_client_secret') ? '••••••••' : (process.env.GOOGLE_CLIENT_SECRET ? '••••••••' : ''),
    square_configured:  !!(getServerSetting('square_app_id') || process.env.SQUARE_APP_ID),
    qbo_configured:     !!(getServerSetting('qbo_client_id') || process.env.QBO_CLIENT_ID),
    google_configured:  !!(getServerSetting('google_client_id') || process.env.GOOGLE_CLIENT_ID),
  })
})

adminRouter.post('/server-config/integrations', requireAdmin, (req, res) => {
  const { square_app_id, square_app_secret, qbo_client_id, qbo_client_secret, google_client_id, google_client_secret } = req.body
  if (square_app_id    !== undefined) setServerSetting('square_app_id',    square_app_id)
  if (square_app_secret !== undefined && square_app_secret !== '••••••••') setServerSetting('square_app_secret', square_app_secret)
  if (qbo_client_id    !== undefined) setServerSetting('qbo_client_id',    qbo_client_id)
  if (qbo_client_secret !== undefined && qbo_client_secret !== '••••••••') setServerSetting('qbo_client_secret', qbo_client_secret)
  if (google_client_id    !== undefined) setServerSetting('google_client_id',    google_client_id)
  if (google_client_secret !== undefined && google_client_secret !== '••••••••') setServerSetting('google_client_secret', google_client_secret)
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
