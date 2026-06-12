import express from 'express'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import QRCode from 'qrcode'
import nodemailer from 'nodemailer'
import Anthropic from '@anthropic-ai/sdk'
import { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'
import { fileURLToPath } from 'url'
import { requireAdmin, withCompany } from '../middleware/auth.js'
import {
  db, loadConfig, saveConfig, buildSystemPrompt,
  listCompanies, getCompany, getCompanyByToken, findCompanyByWaInstance
} from '../db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ============================================================
// HELPERS
// ============================================================
function sanitizeFTS(q) {
  return q.replace(/["']/g, ' ').split(/\s+/).filter(w => w.length > 2).slice(0, 10).map(w => `"${w}"`).join(' OR ')
}

function searchKnowledge(companyId, query, limit = 5) {
  const q = sanitizeFTS(query)
  if (!q) return []
  try {
    return db.prepare(`
      SELECT c.title, c.content FROM chunks c
      JOIN documents d ON d.id = c.doc_id
      WHERE chunks MATCH ? AND d.company_id = ?
      ORDER BY rank LIMIT ?
    `).all(q, companyId, limit)
  } catch { return [] }
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

async function sendNotification({ type, conversationId, companyId }) {
  const cfg = loadConfig(companyId)
  const mailer = getMailer(cfg)
  if (!mailer) return
  if (type === 'lead' && !cfg.notifyOnLead) return
  if (type === 'escalation' && !cfg.notifyOnEscalation) return

  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) || {}
  const msgs = db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId)
  const channel = conv.channel === 'whatsapp' ? '💬 WhatsApp' : '🌐 Web'
  const accent = cfg.accentColor || '#D4AF37'

  const subject = type === 'lead'
    ? `🎯 Nuevo lead capturado — ${cfg.businessName || 'Agente'}`
    : `🚨 Conversación escalada — ${cfg.businessName || 'Agente'}`

  const transcript = msgs.map(m => {
    const who = m.role === 'user' ? 'Cliente' : 'Agente'
    const color = m.role === 'user' ? accent : '#888'
    const bg = m.role === 'user' ? '#fff8e0' : '#f4f4f4'
    return `<tr><td style="padding:10px 14px;border-left:3px solid ${color};background:${bg};border-radius:4px"><b style="color:${color}">${who}:</b><br>${(m.content || '').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</td></tr>`
  }).join('<tr><td style="height:8px"></td></tr>')

  const leadInfo = (conv.lead_email || conv.lead_phone)
    ? `<tr><td style="padding:14px;background:#0a0a0a;border-radius:8px;color:#fff">
        <div style="color:${accent};font-size:11px;letter-spacing:2px;margin-bottom:8px">DATOS DEL CLIENTE</div>
        ${conv.lead_email ? `<div>📧 <b>${conv.lead_email}</b></div>` : ''}
        ${conv.lead_phone ? `<div>📞 <b>${conv.lead_phone}</b></div>` : ''}
        <div style="color:#888;font-size:12px;margin-top:6px">${conv.visitor_id || ''}</div>
      </td></tr><tr><td style="height:14px"></td></tr>` : ''

  const html = `
  <div style="font-family:-apple-system,Arial,sans-serif;max-width:640px;margin:0 auto;background:#fafafa;padding:24px">
    <div style="background:#0a0a0a;color:#fff;padding:22px;border-radius:10px;border-left:4px solid ${accent}">
      <div style="color:${accent};font-size:11px;letter-spacing:2px">${type === 'lead' ? 'NUEVO LEAD' : 'ESCALAMIENTO'}</div>
      <h1 style="margin:8px 0 4px;font-size:22px;font-weight:600">${cfg.businessName || 'Agente'}</h1>
      <div style="color:#aaa;font-size:13px">${channel} · ${new Date().toLocaleString('es-MX')}</div>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px">
      ${leadInfo}
      <tr><td style="color:#666;font-size:12px;letter-spacing:1px;padding:0 0 8px">TRANSCRIPCIÓN</td></tr>
      ${transcript}
    </table>
  </div>`

  try {
    await mailer.sendMail({ from: cfg.smtpFrom || cfg.smtpUser, to: cfg.notifyEmail, subject, html })
  } catch (err) { console.error('Email send failed:', err.message) }
}

// ============================================================
// WHATSAPP EXTERNAL (Evolution API)
// ============================================================
export async function sendWhatsApp(cfg, phone, text) {
  if (!cfg.waBaseUrl || !cfg.waInstance || !cfg.waApiKey) return
  const url = `${cfg.waBaseUrl.replace(/\/$/, '')}/message/sendText/${cfg.waInstance}`
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': cfg.waApiKey },
      body: JSON.stringify({ number: phone, text })
    })
    if (!r.ok) console.error('WA send failed:', r.status, await r.text())
  } catch (err) { console.error('WA send error:', err.message) }
}

// ============================================================
// INSTAGRAM
// ============================================================
export async function sendInstagram(accessToken, recipientId, text) {
  if (!accessToken || !recipientId) return
  const r = await fetch(`https://graph.instagram.com/v21.0/me/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text }, messaging_type: 'RESPONSE' })
  })
  const d = await r.json().catch(() => ({}))
  if (d.error) console.error('[Instagram send]', d.error.message)
}

// ============================================================
// CORE CHAT processMessage
// ============================================================
export async function processMessage({ companyId, message, conversationId, visitorId, channel, pageUrl, pageTitle }) {
  const cfg = loadConfig(companyId)
  let convId = conversationId
  const now = Date.now()

  if (!convId && visitorId && channel !== 'web') {
    const existing = db.prepare("SELECT id FROM conversations WHERE visitor_id = ? AND channel = ? AND company_id = ? ORDER BY updated_at DESC LIMIT 1").get(visitorId, channel, companyId)
    if (existing) convId = existing.id
  }

  if (!convId) {
    convId = crypto.randomUUID()
    db.prepare('INSERT INTO conversations (id, visitor_id, channel, created_at, updated_at, company_id) VALUES (?, ?, ?, ?, ?, ?)').run(convId, visitorId || 'anon', channel || 'web', now, now, companyId)
  } else {
    // ensure conv belongs to same company
    const owner = db.prepare('SELECT company_id FROM conversations WHERE id = ?').get(convId)
    if (owner && owner.company_id !== companyId) {
      // re-create under correct company
      convId = crypto.randomUUID()
      db.prepare('INSERT INTO conversations (id, visitor_id, channel, created_at, updated_at, company_id) VALUES (?, ?, ?, ?, ?, ?)').run(convId, visitorId || 'anon', channel || 'web', now, now, companyId)
    } else {
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId)
    }
  }

  db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(convId, 'user', message, now)
  // Reset retargeting so it fires again after new activity
  db.prepare('UPDATE conversations SET retargeting_sent = 0 WHERE id = ?').run(convId)

  const contacts = extractContacts(message)
  const conv = db.prepare('SELECT lead_email, lead_phone, lead_name, lead_notified, human_mode FROM conversations WHERE id = ?').get(convId)

  // Human takeover — skip AI
  if (conv.human_mode) return { reply: null, conversationId: convId }
  let newLead = false
  if (contacts.emails[0] && !conv.lead_email) {
    db.prepare('UPDATE conversations SET lead_email = ? WHERE id = ?').run(contacts.emails[0], convId)
    newLead = true
  }
  if (contacts.phones[0] && !conv.lead_phone) {
    const clean = contacts.phones[0].replace(/\D/g, '')
    if (clean.length >= 8) {
      db.prepare('UPDATE conversations SET lead_phone = ? WHERE id = ?').run(contacts.phones[0], convId)
      newLead = true
    }
  }
  // Extract name from message using simple patterns
  if (!conv.lead_name) {
    const namePat = /(?:me llamo|soy|mi nombre es|my name is)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i
    const nm = message.match(namePat)
    if (nm) {
      db.prepare('UPDATE conversations SET lead_name = ? WHERE id = ?').run(nm[1].trim(), convId)
      newLead = true
    }
  }
  if (newLead && !conv.lead_notified) {
    db.prepare('UPDATE conversations SET lead_notified = 1 WHERE id = ?').run(convId)
    setImmediate(() => sendNotification({ type: 'lead', conversationId: convId, companyId }))
  }

  const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id').all(convId)
  const knowledge = searchKnowledge(companyId, message, 5)
  const knowledgeText = knowledge.length
    ? `\n\nINFORMACIÓN RELEVANTE DE LA BASE DE CONOCIMIENTO:\n${knowledge.map(k => `[${k.title}]\n${k.content}`).join('\n---\n')}\n\nUSA esta información para responder con precisión. Si la respuesta está ahí, cítala.`
    : ''

  const pageCtx = pageUrl ? `\n\nCONTEXTO: El visitante está en ${pageTitle ? `"${pageTitle}" (` : ''}${pageUrl}${pageTitle ? ')' : ''}.` : ''
  const response = await client.messages.create({
    model: cfg.model || 'claude-haiku-4-5-20251001',
    max_tokens: 350,
    system: buildSystemPrompt(cfg) + knowledgeText + pageCtx,
    messages: history.map(m => ({ role: m.role, content: m.content }))
  })

  const reply = response.content.map(c => c.text || '').join('').trim()
  const info = db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(convId, 'assistant', reply, Date.now())
  if (/no (tengo|sé|conozco)|no puedo (ayudart|responder)|contacta(r)? (al|con) (el )?(equipo|negocio)|pasar tu consulta/i.test(reply)) {
    const c = db.prepare('SELECT escalated_notified FROM conversations WHERE id = ?').get(convId)
    db.prepare('UPDATE conversations SET unresolved = 1 WHERE id = ?').run(convId)
    if (!c.escalated_notified) {
      db.prepare('UPDATE conversations SET escalated_notified = 1 WHERE id = ?').run(convId)
      setImmediate(() => sendNotification({ type: 'escalation', conversationId: convId, companyId }))
    }
  }
  return { conversationId: convId, reply, messageId: info.lastInsertRowid }
}

// ============================================================
// BUILT-IN WHATSAPP (Baileys) — per-company
// ============================================================
const waBaseDir = path.join(rootDir, 'data', 'wa-auth')
export const waConnections = new Map() // companyId → { sock, state }
const SILENT_LOGGER = { level: 'silent', trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){}, child(){ return this } }

function getWaConn(companyId) {
  if (!waConnections.has(companyId)) waConnections.set(companyId, { sock: null, state: { status: 'waiting', qr: null, phone: null } })
  return waConnections.get(companyId)
}

export async function startBuiltinWhatsApp(companyId) {
  const conn = getWaConn(companyId)
  const authDir = path.join(waBaseDir, companyId)
  try {
    fs.mkdirSync(authDir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, SILENT_LOGGER) },
      printQRInTerminal: false,
      logger: SILENT_LOGGER,
      browser: ['Mi Agente IA', 'Chrome', '120.0.0'],
      markOnlineOnConnect: false,
    })
    conn.sock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        const dataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 1, errorCorrectionLevel: 'M' })
        conn.state = { status: 'qr', qr: dataUrl, phone: null }
        console.log(`[WA:${companyId}] QR listo`)
      }
      if (connection === 'open') {
        const phone = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || null
        conn.state = { status: 'open', qr: null, phone }
        console.log(`[WA:${companyId}] Conectado: ${phone}`)
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        const loggedOut = code === DisconnectReason.loggedOut
        conn.state = { status: loggedOut ? 'logged_out' : 'disconnected', qr: null, phone: null }
        console.log(`[WA:${companyId}] Desconectado código:${code} reintento:${!loggedOut}`)
        if (!loggedOut) setTimeout(() => startBuiltinWhatsApp(companyId), 5000)
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        const text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.ephemeralMessage?.message?.conversation
          || null
        if (!text?.trim() || !msg.message) continue
        const remoteJid = msg.key.remoteJid
        if (remoteJid.endsWith('@g.us')) continue
        const phone = remoteJid.replace('@s.whatsapp.net', '')
        const visitorId = `wa:${phone}`

        // Handle commands sent FROM the business phone (fromMe)
        if (msg.key.fromMe) {
          const cmd = text.trim()
          if (cmd === '/' || cmd === '//') {
            const conv = db.prepare("SELECT id FROM conversations WHERE visitor_id = ? AND company_id = ? AND channel = 'whatsapp' ORDER BY updated_at DESC LIMIT 1").get(visitorId, companyId)
            if (conv) {
              const mode = cmd === '/' ? 1 : 0
              db.prepare('UPDATE conversations SET human_mode = ? WHERE id = ?').run(mode, conv.id)
              const ack = mode ? '⏸ IA pausada. Tú tienes el control.' : '▶ IA reactivada.'
              await sock.sendMessage(remoteJid, { text: ack })
              console.log(`[WA:${companyId}] human_mode=${mode} para ${visitorId}`)
            }
          }
          continue // never process fromMe messages through AI
        }

        try {
          const result = await processMessage({ companyId, message: text.trim(), visitorId, channel: 'whatsapp' })
          if (result?.reply) await sock.sendMessage(remoteJid, { text: result.reply })
        } catch (err) { console.error(`[WA:${companyId}] Error:`, err.message) }
      }
    })
  } catch (err) {
    console.error(`[WA:${companyId}] Error iniciando:`, err.message)
    conn.state.status = 'disconnected'
    setTimeout(() => startBuiltinWhatsApp(companyId), 10000)
  }
}

// Auto-start companies that have saved auth
try {
  if (fs.existsSync(waBaseDir)) {
    for (const cid of fs.readdirSync(waBaseDir)) {
      if (fs.existsSync(path.join(waBaseDir, cid, 'creds.json'))) {
        startBuiltinWhatsApp(cid).catch(console.error)
      }
    }
  }
} catch {}

// ============================================================
// RETARGETING JOB — fires 18 hours after last message
// ============================================================
async function runRetargeting() {
  const cutoff = Date.now() - 18 * 60 * 60 * 1000
  const convs = db.prepare(`
    SELECT c.id, c.channel, c.visitor_id, c.company_id
    FROM conversations c
    WHERE c.updated_at < ?
      AND c.retargeting_sent = 0
      AND c.human_mode = 0
      AND c.channel IN ('whatsapp','instagram')
  `).all(cutoff)

  for (const conv of convs) {
    try {
      const cfg = loadConfig(conv.company_id)
      const msgs = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 6').all(conv.id)
      if (!msgs.length) continue
      const context = msgs.reverse().map(m => `${m.role === 'user' ? 'Cliente' : 'Agente'}: ${m.content}`).join('\n')
      const resp = await client.messages.create({
        model: cfg.model || 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        messages: [{ role: 'user', content: `Eres "${cfg.agentName || 'Asistente'}" de "${cfg.businessName}". Escribe UN mensaje de seguimiento corto y natural para retomar esta conversación. Sin emojis, sin listas, máximo 2 oraciones:\n\n${context}` }]
      })
      const retargetMsg = resp.content[0].text.trim()
      if (conv.channel === 'whatsapp') {
        const phone = conv.visitor_id.replace('wa:', '')
        await sendWhatsApp(cfg, phone, retargetMsg)
      } else if (conv.channel === 'instagram') {
        const igId = conv.visitor_id.replace('ig:', '')
        await sendInstagram(cfg.igAccessToken, igId, retargetMsg)
      }
      db.prepare('UPDATE conversations SET retargeting_sent = 1 WHERE id = ?').run(conv.id)
      db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(conv.id, 'assistant', retargetMsg, Date.now())
      console.log(`[Retargeting] sent to ${conv.visitor_id}`)
    } catch (e) { console.error('[Retargeting]', e.message) }
  }
}
setInterval(runRetargeting, 30 * 60 * 1000) // check every 30 min

export const chatRouter = express.Router()

// ============================================================
// RATINGS
// ============================================================
chatRouter.post('/rate', (req, res) => {
  const { conversationId, messageId, rating } = req.body
  if (!conversationId || ![1, -1].includes(rating)) return res.status(400).json({ error: 'Datos inválidos' })
  db.prepare('INSERT INTO ratings (conversation_id, message_id, rating, created_at) VALUES (?, ?, ?, ?)')
    .run(conversationId, messageId || null, rating, Date.now())
  if (rating === -1) db.prepare('UPDATE conversations SET unresolved = 1 WHERE id = ?').run(conversationId)
  res.json({ ok: true })
})

// ============================================================
// CONVERSATIONS (scoped to company)
// ============================================================
chatRouter.get('/conversations', requireAdmin, withCompany, (req, res) => {
  res.json(db.prepare('SELECT id, visitor_id, channel, unresolved, human_mode, created_at, updated_at FROM conversations WHERE company_id = ? ORDER BY updated_at DESC LIMIT 100').all(req.company.id))
})

chatRouter.get('/conversations/:id', requireAdmin, withCompany, (req, res) => {
  const conv = db.prepare('SELECT id, human_mode, channel, visitor_id FROM conversations WHERE id = ? AND company_id = ?').get(req.params.id, req.company.id)
  if (!conv) return res.status(404).json({ error: 'No encontrada' })
  const msgs = db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(req.params.id)
  res.json({ conv, msgs })
})

chatRouter.post('/conversations/:id/resolve', requireAdmin, withCompany, (req, res) => {
  db.prepare('UPDATE conversations SET unresolved = 0 WHERE id = ? AND company_id = ?').run(req.params.id, req.company.id)
  res.json({ ok: true })
})

// Toggle human mode: / = takeover, // = return to AI
chatRouter.post('/conversations/:id/human-mode', requireAdmin, withCompany, (req, res) => {
  const { mode } = req.body // 1 = human, 0 = AI
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND company_id = ?').get(req.params.id, req.company.id)
  if (!conv) return res.status(404).json({ error: 'No encontrada' })
  db.prepare('UPDATE conversations SET human_mode = ? WHERE id = ?').run(mode ? 1 : 0, req.params.id)
  res.json({ ok: true, human_mode: mode ? 1 : 0 })
})

// Admin reply — sends message as agent and delivers it to the user
chatRouter.post('/conversations/:id/reply', requireAdmin, withCompany, async (req, res) => {
  const { text } = req.body
  if (!text?.trim()) return res.status(400).json({ error: 'Falta texto' })
  const conv = db.prepare('SELECT id, channel, visitor_id FROM conversations WHERE id = ? AND company_id = ?').get(req.params.id, req.company.id)
  if (!conv) return res.status(404).json({ error: 'No encontrada' })
  db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(conv.id, 'assistant', text.trim(), Date.now())
  const cfg = req.company.config
  try {
    if (conv.channel === 'whatsapp') {
      const phone = conv.visitor_id.replace('wa:', '')
      await sendWhatsApp(cfg, phone, text.trim())
    } else if (conv.channel === 'instagram') {
      const igId = conv.visitor_id.replace('ig:', '')
      await sendInstagram(cfg.igAccessToken, igId, text.trim())
    }
  } catch (e) { console.error('[admin reply]', e.message) }
  res.json({ ok: true })
})

// ============================================================
// LEADS
// ============================================================
chatRouter.get('/leads', requireAdmin, withCompany, (req, res) => {
  const leads = db.prepare(`
    SELECT id, visitor_id, channel, created_at, updated_at,
           lead_name, lead_email, lead_phone,
           (SELECT content FROM messages WHERE conversation_id = conversations.id AND role = 'user' ORDER BY id LIMIT 1) as first_msg
    FROM conversations
    WHERE company_id = ?
      AND (lead_email IS NOT NULL OR lead_phone IS NOT NULL OR lead_name IS NOT NULL)
    ORDER BY updated_at DESC
  `).all(req.company.id)
  res.json(leads)
})

chatRouter.patch('/leads/:id', requireAdmin, withCompany, (req, res) => {
  const { lead_name, lead_email, lead_phone } = req.body
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND company_id = ?').get(req.params.id, req.company.id)
  if (!conv) return res.status(404).json({ error: 'No encontrado' })
  const fields = [], vals = []
  if (lead_name !== undefined) { fields.push('lead_name = ?'); vals.push(lead_name || null) }
  if (lead_email !== undefined) { fields.push('lead_email = ?'); vals.push(lead_email || null) }
  if (lead_phone !== undefined) { fields.push('lead_phone = ?'); vals.push(lead_phone || null) }
  if (!fields.length) return res.json({ ok: true })
  vals.push(req.params.id)
  db.prepare(`UPDATE conversations SET ${fields.join(', ')} WHERE id = ?`).run(...vals)
  res.json({ ok: true })
})

chatRouter.delete('/leads/:id', requireAdmin, withCompany, (req, res) => {
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND company_id = ?').get(req.params.id, req.company.id)
  if (!conv) return res.status(404).json({ error: 'No encontrado' })
  // Clear lead fields only — keeps conversation history intact
  db.prepare('UPDATE conversations SET lead_name = NULL, lead_email = NULL, lead_phone = NULL, lead_notified = 0 WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// ============================================================
// CORE CHAT
// ============================================================
chatRouter.post('/chat', withCompany, async (req, res) => {
  try {
    const { message, conversationId, visitorId, demo, history, pageUrl, pageTitle } = req.body
    if (!message) return res.status(400).json({ error: 'Falta mensaje' })

    if (demo) {
      const cfg = req.company.config
      const msgs = Array.isArray(history) ? [...history] : []
      msgs.push({ role: 'user', content: message })
      const knowledge = searchKnowledge(req.company.id, message, 5)
      const knowledgeText = knowledge.length
        ? `\n\nINFORMACIÓN RELEVANTE:\n${knowledge.map(k => `[${k.title}]\n${k.content}`).join('\n---\n')}`
        : ''
      const resp = await client.messages.create({
        model: cfg.model || 'claude-haiku-4-5-20251001',
        max_tokens: 350,
        system: buildSystemPrompt(cfg) + knowledgeText + '\n\n[MODO DEMO]',
        messages: msgs
      })
      const reply = resp.content.map(c => c.text || '').join('').trim()
      return res.json({ reply, history: [...msgs, { role: 'assistant', content: reply }] })
    }

    const result = await processMessage({ companyId: req.company.id, message, conversationId, visitorId, channel: 'web', pageUrl, pageTitle })
    res.json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// WHATSAPP (resolved by instance)
// ============================================================
chatRouter.post('/whatsapp/webhook', async (req, res) => {
  try {
    res.sendStatus(200)
    const ev = req.body
    const event = ev?.event || ''
    if (!/messages.?upsert/i.test(event)) return
    const instance = ev.instance || ev.instanceName
    const company = findCompanyByWaInstance(instance) || getCompany('default')
    if (!company) return
    const data = ev.data || ev
    if (data?.key?.fromMe) return
    const jid = data?.key?.remoteJid || ''
    if (!jid || jid.includes('@g.us')) return
    const phone = jid.split('@')[0]
    const text = data.message?.conversation
      || data.message?.extendedTextMessage?.text
      || data.message?.imageMessage?.caption || ''
    if (!text.trim()) return
    const result = await processMessage({ companyId: company.id, message: text, visitorId: `wa:${phone}`, channel: 'whatsapp' })
    await sendWhatsApp(company.config, phone, result.reply)
  } catch (err) { console.error('WA webhook error:', err) }
})

chatRouter.post('/whatsapp/test', requireAdmin, withCompany, async (req, res) => {
  const { phone, text } = req.body
  await sendWhatsApp(req.company.config, phone, text || 'Test desde el agente ✓')
  res.json({ ok: true })
})

chatRouter.post('/whatsapp/qr', requireAdmin, withCompany, async (req, res) => {
  const saved = req.company.config
  // Accept credentials from request body (form values) or fall back to saved config
  const waBaseUrl = req.body.waBaseUrl || saved.waBaseUrl
  const waInstance = req.body.waInstance || saved.waInstance
  const waApiKey = req.body.waApiKey || saved.waApiKey
  if (!waBaseUrl || !waInstance || !waApiKey)
    return res.status(400).json({ error: 'Completa Base URL, Instance Name y API Key antes de generar el QR' })
  try {
    const base = waBaseUrl.replace(/\/$/, '')
    const r = await fetch(`${base}/instance/connect/${waInstance}`, {
      headers: { 'apikey': waApiKey }
    })
    const data = await r.json()
    const qr = data.base64 || data?.qrcode?.base64 || data?.qr?.base64 || null
    const state = data.state || data?.instance?.state || null
    res.json({ qr, state })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

chatRouter.post('/whatsapp/status', requireAdmin, withCompany, async (req, res) => {
  const saved = req.company.config
  const waBaseUrl = req.body.waBaseUrl || saved.waBaseUrl
  const waInstance = req.body.waInstance || saved.waInstance
  const waApiKey = req.body.waApiKey || saved.waApiKey
  if (!waBaseUrl || !waInstance || !waApiKey)
    return res.status(400).json({ error: 'Faltan credenciales' })
  try {
    const base = waBaseUrl.replace(/\/$/, '')
    const r = await fetch(`${base}/instance/connectionState/${waInstance}`, {
      headers: { 'apikey': waApiKey }
    })
    const data = await r.json()
    const state = data.state || data?.instance?.state || data?.connectionState || 'unknown'
    res.json({ state })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

chatRouter.get('/whatsapp/contact-qr', requireAdmin, async (req, res) => {
  const { phone, msg } = req.query
  if (!phone) return res.status(400).json({ error: 'Falta phone' })
  const clean = phone.replace(/\D/g, '')
  let url = `https://wa.me/${clean}`
  if (msg) url += `?text=${encodeURIComponent(msg)}`
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 600, margin: 2, errorCorrectionLevel: 'H' })
    res.json({ dataUrl, waUrl: url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

chatRouter.get('/whatsapp/builtin/qr', requireAdmin, withCompany, async (req, res) => {
  const cid = req.company.id
  const conn = getWaConn(cid)
  if (conn.state.status === 'open') return res.json({ status: 'open', phone: conn.state.phone })
  if (conn.state.status === 'qr') return res.json({ status: 'qr', qr: conn.state.qr })
  if (conn.state.status !== 'connecting') {
    conn.state.status = 'connecting'
    startBuiltinWhatsApp(cid).catch(console.error)
  }
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (conn.state.status === 'qr') return res.json({ status: 'qr', qr: conn.state.qr })
    if (conn.state.status === 'open') return res.json({ status: 'open', phone: conn.state.phone })
  }
  res.json({ status: 'connecting' })
})

chatRouter.get('/whatsapp/builtin/status', requireAdmin, withCompany, (req, res) => {
  const conn = getWaConn(req.company.id)
  res.json({ status: conn.state.status, phone: conn.state.phone })
})

chatRouter.post('/whatsapp/builtin/disconnect', requireAdmin, withCompany, async (req, res) => {
  const cid = req.company.id
  const conn = getWaConn(cid)
  if (conn.sock) { try { await conn.sock.logout() } catch {} conn.sock = null }
  const authDir = path.join(waBaseDir, cid)
  if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
  conn.state = { status: 'waiting', qr: null, phone: null }
  res.json({ ok: true })
})

// ============================================================
// INSTAGRAM DMs (Meta Graph API + OAuth)
// ============================================================

// OAuth step 1: redirect to Instagram Business Login
chatRouter.get('/instagram/connect', requireAdmin, withCompany, (req, res) => {
  const igAppId = process.env.IG_APP_ID
  const igAppSecret = process.env.IG_APP_SECRET
  if (!igAppId || !igAppSecret)
    return res.status(400).send('<h3 style="font-family:sans-serif;color:#c00">Credenciales de Instagram no configuradas en el servidor.</h3>')
  const redirectUri = `https://${req.get('host')}/api/instagram/callback`
  const state = Buffer.from(JSON.stringify({ companyId: req.company.id })).toString('base64url')
  const scope = 'instagram_business_basic,instagram_business_manage_messages'
  const url = `https://www.instagram.com/oauth/authorize?client_id=${igAppId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&response_type=code&state=${state}`
  res.redirect(url)
})

// OAuth step 2: Instagram redirects back with code
chatRouter.get('/instagram/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error || !code || !state) return res.send(`<script>window.opener?.postMessage({igError:'${error||'cancelled'}'}, '*'); window.close();</script>`)
  let companyId
  try { companyId = JSON.parse(Buffer.from(state, 'base64url').toString()).companyId } catch { return res.send('Estado inválido') }
  const igAppId = process.env.IG_APP_ID
  const igAppSecret = process.env.IG_APP_SECRET
  if (!igAppId || !igAppSecret) return res.send('Credenciales no configuradas')
  try {
    const redirectUri = `https://${req.get('host')}/api/instagram/callback`
    // Exchange code for short-lived token
    const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: igAppId, client_secret: igAppSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code })
    })
    const tokenData = await tokenRes.json()
    console.log('[Instagram OAuth] token response:', JSON.stringify(tokenData).substring(0, 100))
    if (!tokenData.access_token) throw new Error(tokenData.error_message || tokenData.error?.message || 'No token')
    // Exchange for long-lived token
    const llRes = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_id=${igAppId}&client_secret=${igAppSecret}&access_token=${tokenData.access_token}`)
    const llData = await llRes.json()
    const accessToken = llData.access_token || tokenData.access_token
    // Get IG user info
    const userRes = await fetch(`https://graph.instagram.com/me?fields=id,username&access_token=${accessToken}`)
    const userData = await userRes.json()
    const igUsername = userData.username || ''
    const igUserId = userData.id || String(tokenData.user_id || '')
    console.log('[Instagram OAuth] user:', igUsername, 'id:', igUserId, 'token:', accessToken ? accessToken.substring(0,20)+'...' : 'EMPTY')
    if (!igUserId) throw new Error('No se pudo obtener el ID de usuario de Instagram.')
    const cfg = loadConfig(companyId)
    const verifyToken = cfg.igVerifyToken || 'lynkro123'
    saveConfig(companyId, { igAccessToken: accessToken, igPageId: igUserId, igUsername, igVerifyToken: verifyToken })
    console.log('[Instagram OAuth] saved - user:', igUsername, 'id:', igUserId)
    res.send(`<script>window.opener?.postMessage({igOk:true,igUsername:'${igUsername}',igPageId:'${igUserId}'}, '*'); window.close();</script>`)
  } catch (err) {
    console.error('[Instagram OAuth]', err.message)
    res.send(`<script>window.opener?.postMessage({igError:'${err.message.replace(/'/g,"\\'")}'},'*'); window.close();</script>`)
  }
})

// Webhook verification
chatRouter.get('/instagram/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query
  if (mode !== 'subscribe') return res.sendStatus(403)
  const match = listCompanies().find(c => { const cfg = loadConfig(c.id); return cfg.igVerifyToken && cfg.igVerifyToken === token })
  if (match) return res.send(challenge)
  res.sendStatus(403)
})

// Incoming Instagram DM
chatRouter.post('/instagram/webhook', async (req, res) => {
  res.sendStatus(200)
  const body = req.body
  if (body.object !== 'instagram' && body.object !== 'page') return
  for (const entry of (body.entry || [])) {
    const pageId = entry.id
    const companies = listCompanies()
    const company = companies.find(c => { const cfg = loadConfig(c.id); return cfg.igPageId === pageId })
      || companies.find(c => { const cfg = loadConfig(c.id); return !!cfg.igAccessToken })
    if (!company) continue
    const cfg = loadConfig(company.id)
    for (const event of (entry.messaging || [])) {
      const senderId = event.sender?.id
      if (!senderId) continue
      const text = event.message?.text?.trim()
      if (!text) continue

      // Message sent BY the business (echo) — handle / and // commands
      if (senderId === pageId || event.message?.is_echo) {
        const recipientId = event.recipient?.id || event.message?.recipient_id
        if (!recipientId) continue
        if (text === '/' || text === '//') {
          const visitorId = `ig:${recipientId}`
          const conv = db.prepare("SELECT id FROM conversations WHERE visitor_id = ? AND company_id = ? AND channel = 'instagram' ORDER BY updated_at DESC LIMIT 1").get(visitorId, company.id)
          if (conv) {
            const mode = text === '/' ? 1 : 0
            db.prepare('UPDATE conversations SET human_mode = ? WHERE id = ?').run(mode, conv.id)
            const ack = mode ? '⏸ IA pausada. Tú tienes el control.' : '▶ IA reactivada.'
            await sendInstagram(cfg.igAccessToken, recipientId, ack)
            console.log(`[Instagram] human_mode=${mode} para ${visitorId}`)
          }
        }
        continue
      }

      try {
        const result = await processMessage({ companyId: company.id, message: text, visitorId: `ig:${senderId}`, channel: 'instagram' })
        if (result?.reply) await sendInstagram(cfg.igAccessToken, senderId, result.reply)
      } catch (err) { console.error('[Instagram]', err.message) }
    }
  }
})
