import express from 'express'
import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import QRCode from 'qrcode'
import nodemailer from 'nodemailer'
import Anthropic from '@anthropic-ai/sdk'
import { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, downloadMediaMessage } from '@whiskeysockets/baileys'
import { fileURLToPath } from 'url'
import { requireAdmin, withCompany, signState, verifyState } from '../middleware/auth.js'
import {
  db, loadConfig, saveConfig, buildSystemPrompt,
  listCompanies, getCompany, getCompanyByToken, findCompanyByWaInstance
} from '../db.js'
import { SEARCH_PRODUCTS_TOOL, buildSearchResponse } from '../services/recommendations.js'
import { matchKeywordTrigger, getActiveTriggerFlow, startTriggerFlow, advanceTriggerFlow, clearTriggerFlow } from '../services/keyword-trigger.js'
import { getServices, searchAvailability, createBooking, getLocations } from '../services/square.js'
import { RESPOND_TO_PATIENT_TOOL, validateAgentResponse } from '../services/medspa-response-schema.js'
import { buildMedspaPromptModule } from '../services/medspa-prompt.js'
import { loadState as loadMedspaState, saveState as saveMedspaState, setDoNotContact } from '../services/medspa-state.js'
import { canModifyAppointment } from '../services/appointments.js'
import { RESPOND_TO_LEAD_TOOL, validateAgentResponse as validateLeadResponse } from '../services/lynkro-lead-schema.js'
import { buildLynkroLeadPromptModule } from '../services/lynkro-lead-prompt.js'
import { loadState as loadLeadState, saveState as saveLeadState, shouldNotifyQualified } from '../services/lynkro-lead-state.js'
import { transcribeAudioBuffer } from '../services/transcribe.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')

// Lynkro's own company — used both by the lead-qualification vertical
// (processMessage, below) and by the LYNKRO_FU follow-up job further down.
const LYNKRO_COMPANY_ID = '4a945bfd-5090-472e-a3e4-a137c1da56c9'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Retries transient failures (network blips, rate limits, Anthropic 5xx) so a
// single hiccup doesn't leave an inbound message with zero reply.
async function createMessageWithRetry(params, retries = 2) {
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try {
      return await client.messages.create(params)
    } catch (err) {
      lastErr = err
      const status = err?.status || err?.response?.status
      const retryable = !status || status === 429 || status >= 500
      if (!retryable || i === retries) throw err
      await new Promise(r => setTimeout(r, 500 * (i + 1)))
    }
  }
  throw lastErr
}

// ============================================================
// SQUARE BOOKING TOOLS
// ============================================================
const SQUARE_GET_SERVICES_TOOL = {
  name: 'square_get_services',
  description: 'Obtiene la lista de servicios disponibles para agendar citas. Úsalo al inicio cuando el usuario quiera reservar o pregunté qué tratamientos hay.',
  input_schema: { type: 'object', properties: {}, required: [] }
}

// Single combined tool: finds the best available slot and books it atomically
const SQUARE_BOOK_APPOINTMENT_TOOL = {
  name: 'square_book_appointment',
  description: 'Busca disponibilidad y crea la cita en Square en un solo paso. Úsalo cuando el cliente haya elegido servicio, fecha/hora y dado su nombre y teléfono. El sistema encuentra el slot más cercano a lo solicitado y lo reserva automáticamente.',
  input_schema: {
    type: 'object',
    properties: {
      service_variation_id: { type: 'string', description: 'variationId del servicio (de square_get_services)' },
      service_variation_version: { type: 'number', description: 'variationVersion del servicio (de square_get_services)' },
      requested_date: { type: 'string', description: 'Fecha solicitada en formato YYYY-MM-DD (ej: "2026-07-09")' },
      requested_time: { type: 'string', description: 'Hora solicitada en formato HH:MM zona Miami/ET (ej: "18:00" para 6pm, "10:30" para 10:30am)' },
      customer_name: { type: 'string', description: 'Nombre completo del cliente' },
      customer_phone: { type: 'string', description: 'Teléfono con código de país (ej: +17863511573)' },
      customer_email: { type: 'string', description: 'Email del cliente (NO lo pidas, déjalo vacío siempre)' },
      note: { type: 'string', description: 'Nota adicional (opcional)' }
    },
    required: ['service_variation_id', 'service_variation_version', 'requested_date', 'requested_time', 'customer_name', 'customer_phone']
  }
}

// ============================================================
// APPOINTMENT MANAGEMENT TOOLS (reschedule/cancel) — provider-agnostic,
// gated on cfg.calendarProvider (see canModifyAppointment / tool handlers below)
// ============================================================
const FIND_MY_APPOINTMENTS_TOOL = {
  name: 'find_my_appointments',
  description: 'Busca las citas futuras del cliente que está escribiendo ahora mismo (por su teléfono). Úsalo siempre antes de reagendar o cancelar, para saber cuál es su cita.',
  input_schema: { type: 'object', properties: {}, required: [] }
}

const CHECK_AVAILABILITY_TOOL = {
  name: 'check_availability',
  description: 'Verifica si un horario propuesto está realmente libre antes de reagendar una cita a ese horario. Siempre pásale el appointment_id de la cita que se está moviendo (de find_my_appointments) para que compare contra el servicio/ubicación correctos y no la cuente como choque contra sí misma.',
  input_schema: {
    type: 'object',
    properties: {
      appointment_id: { type: 'string', description: 'id de la cita que se está reagendando (de find_my_appointments)' },
      start_iso: { type: 'string', description: 'Fecha/hora propuesta en ISO 8601 (ej: 2026-07-16T15:00:00-04:00)' },
      duration_minutes: { type: 'number', description: 'Duración de la cita en minutos (usa la de la cita original si no se especifica otra)' }
    },
    required: ['appointment_id', 'start_iso', 'duration_minutes']
  }
}

const RESCHEDULE_APPOINTMENT_TOOL = {
  name: 'reschedule_appointment',
  description: 'Mueve una cita existente a un nuevo horario YA VERIFICADO con check_availability. Solo llama esto después de que el cliente confirmó el nuevo horario exacto.',
  input_schema: {
    type: 'object',
    properties: {
      appointment_id: { type: 'string', description: 'id de la cita (de find_my_appointments)' },
      new_start_iso: { type: 'string', description: 'Nuevo inicio en ISO 8601' },
      new_end_iso: { type: 'string', description: 'Nuevo fin en ISO 8601 (mantén la misma duración que la cita original)' }
    },
    required: ['appointment_id', 'new_start_iso', 'new_end_iso']
  }
}

const CANCEL_APPOINTMENT_TOOL = {
  name: 'cancel_appointment',
  description: 'Cancela una cita existente. Solo llama esto después de que el cliente lo confirmó explícitamente (ej. respondió "sí" a "¿confirmas que quieres cancelar tu cita del [fecha]?").',
  input_schema: {
    type: 'object',
    properties: {
      appointment_id: { type: 'string', description: 'id de la cita (de find_my_appointments)' }
    },
    required: ['appointment_id']
  }
}

// Atomic: find best slot near requested time and book it
async function squareBookAppointment(accessToken, { serviceVariationId, serviceVariationVersion, requestedDate, requestedTime, customerName, customerPhone, customerEmail, note }) {
  const locations = await getLocations(accessToken)
  if (!locations.length) throw new Error('No hay ubicaciones configuradas en Square')

  // Build search window: requested date ± 1 day to find slots near the request
  const tzOffset = '-04:00' // Miami EDT (adjust to -05:00 for EST Nov-Mar)
  const requestedIso = `${requestedDate}T${requestedTime}:00${tzOffset}`
  const requestedMs = new Date(requestedIso).getTime()
  const dayStart = new Date(`${requestedDate}T00:00:00${tzOffset}`).toISOString()
  const dayEnd = new Date(`${requestedDate}T23:59:59${tzOffset}`).toISOString()

  let allSlots = []
  for (const loc of locations) {
    try {
      const slots = await searchAvailability(accessToken, {
        serviceVariationId,
        startAt: dayStart,
        endAt: dayEnd,
        locationId: loc.id
      })
      allSlots.push(...slots.map(s => ({ ...s, locationId: loc.id })))
    } catch {}
  }

  // If no slots on that day, search next 7 days
  if (!allSlots.length) {
    const nextWeek = new Date(requestedMs + 7 * 24 * 60 * 60 * 1000).toISOString()
    for (const loc of locations) {
      try {
        const slots = await searchAvailability(accessToken, {
          serviceVariationId,
          startAt: new Date().toISOString(),
          endAt: nextWeek,
          locationId: loc.id
        })
        allSlots.push(...slots.map(s => ({ ...s, locationId: loc.id })))
      } catch {}
    }
  }

  if (!allSlots.length) {
    throw new Error('No hay disponibilidad en los próximos 7 días para ese servicio.')
  }

  // Pick the slot closest to the requested time
  allSlots.sort((a, b) => Math.abs(new Date(a.startAt) - requestedMs) - Math.abs(new Date(b.startAt) - requestedMs))
  const best = allSlots[0]

  const booking = await createBooking(accessToken, {
    startAt: best.startAt,
    serviceVariationId: best.serviceVariationId || serviceVariationId,
    serviceVariationVersion,
    teamMemberId: best.teamMemberId,
    locationId: best.locationId,
    customerName,
    customerPhone,
    customerEmail,
    note
  })

  // Format confirmation time for display
  const confirmedTime = new Date(booking.start_at).toLocaleString('es-US', {
    timeZone: 'America/New_York',
    weekday: 'long', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  })

  return {
    success: true,
    bookingId: booking.id,
    confirmedTime,
    startAt: booking.start_at,
    status: booking.status,
    note: booking.start_at !== requestedIso ? `Confirmado para el horario más cercano disponible: ${confirmedTime}` : null
  }
}

// ============================================================
// HELPERS
// ============================================================
function sanitizeFTS(q) {
  return q.replace(/["']/g, ' ').split(/\s+/).filter(w => w.length > 2).slice(0, 10).map(w => `"${w}"`).join(' OR ')
}

// Bounds the raw transcript sent to Claude for long-running medspa
// conversations; earlier context is carried instead via conversation_summary
// (already injected into the system prompt by buildMedspaPromptModule).
// Ensures the result still starts on a 'user' turn, as the Anthropic API requires.
function windowHistory(history, threshold, keep) {
  if (history.length <= threshold) return history
  let sliced = history.slice(-keep)
  const firstUserIdx = sliced.findIndex(m => m.role === 'user')
  if (firstUserIdx > 0) sliced = sliced.slice(firstUserIdx)
  return sliced
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
  if (type === 'reschedule' && !cfg.notifyOnReschedule) return
  if (type === 'cancel' && !cfg.notifyOnCancel) return
  if (type === 'qualified_lead' && !cfg.notifyOnQualifiedLead) return

  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) || {}
  const msgs = db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId)
  const channel = conv.channel === 'whatsapp' ? '💬 WhatsApp' : '🌐 Web'
  const accent = cfg.accentColor || '#D4AF37'

  const SUBJECTS = {
    lead: `🎯 Nuevo lead capturado — ${cfg.businessName || 'Agente'}`,
    escalation: `🚨 Conversación escalada — ${cfg.businessName || 'Agente'}`,
    reschedule: `📅 Cita reagendada por el bot — ${cfg.businessName || 'Agente'}`,
    cancel: `❌ Cita cancelada por el bot — ${cfg.businessName || 'Agente'}`,
    qualified_lead: `🔥 Lead calificado por Meta Ads — ${cfg.businessName || 'Agente'}`,
  }
  const subject = SUBJECTS[type] || SUBJECTS.escalation

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

  let qualifiedLeadInfo = ''
  if (type === 'qualified_lead') {
    const leadState = loadLeadState(conversationId)
    qualifiedLeadInfo = `<tr><td style="padding:14px;background:#0a0a0a;border-radius:8px;color:#fff">
        <div style="color:${accent};font-size:11px;letter-spacing:2px;margin-bottom:8px">DATOS PARA EL DEMO</div>
        <div>🏢 <b>${leadState.business_type || 'Tipo de negocio no capturado'}</b></div>
        <div>💰 Ticket promedio: <b>${leadState.avg_ticket || 'no capturado'}</b></div>
        <div>📊 Volumen: <b>${leadState.volume_level || 'no capturado'}</b></div>
        <div>🏷️ Rubro: <b>${leadState.vertical || 'no capturado'}</b></div>
        ${leadState.captured_fields?.website ? `<div>🌐 <b>${leadState.captured_fields.website}</b></div>` : ''}
        ${leadState.captured_fields?.instagram ? `<div>📷 <b>${leadState.captured_fields.instagram}</b></div>` : ''}
      </td></tr><tr><td style="height:14px"></td></tr>`
  }

  const html = `
  <div style="font-family:-apple-system,Arial,sans-serif;max-width:640px;margin:0 auto;background:#fafafa;padding:24px">
    <div style="background:#0a0a0a;color:#fff;padding:22px;border-radius:10px;border-left:4px solid ${accent}">
      <div style="color:${accent};font-size:11px;letter-spacing:2px">${ { lead: 'NUEVO LEAD', escalation: 'ESCALAMIENTO', reschedule: 'CITA REAGENDADA', cancel: 'CITA CANCELADA', qualified_lead: 'LEAD CALIFICADO' }[type] || 'AVISO' }</div>
      <h1 style="margin:8px 0 4px;font-size:22px;font-weight:600">${cfg.businessName || 'Agente'}</h1>
      <div style="color:#aaa;font-size:13px">${channel} · ${new Date().toLocaleString('es-MX')}</div>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px">
      ${leadInfo}
      ${qualifiedLeadInfo}
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
// A company is on the Evolution API transport (not the in-process builtin
// Baileys socket) once it has all three connection fields configured. This is
// the per-company switch: presence of Evolution config IS the signal.
export function usesEvolution(cfg) {
  return !!(cfg && cfg.waBaseUrl && cfg.waInstance && cfg.waApiKey)
}

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

// Download a media message (e.g. a voice note) from Evolution as a Buffer.
// Evolution keeps the encrypted media in its own store; POST the message key to
// getBase64FromMediaMessage and it returns the decrypted bytes as base64.
export async function fetchEvolutionMediaBuffer(cfg, data) {
  if (!cfg.waBaseUrl || !cfg.waInstance || !cfg.waApiKey || !data?.key) return null
  const url = `${cfg.waBaseUrl.replace(/\/$/, '')}/chat/getBase64FromMediaMessage/${cfg.waInstance}`
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': cfg.waApiKey },
      body: JSON.stringify({ message: { key: data.key }, convertToMp4: false })
    })
    if (!r.ok) { console.error('Evolution media fetch failed:', r.status, await r.text().catch(() => '')); return null }
    const j = await r.json().catch(() => ({}))
    return j.base64 ? Buffer.from(j.base64, 'base64') : null
  } catch (err) { console.error('Evolution media fetch error:', err.message); return null }
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

// Keyword-trigger button on Instagram via Meta's official "button template".
// Falls back to plain text (link inline) if the template call fails, so a
// customer never ends up with no reply because of a button-API error.
export async function sendInstagramButton(accessToken, recipientId, text, button) {
  if (!accessToken || !recipientId) return
  if (!button?.url || !button?.label) return sendInstagram(accessToken, recipientId, text)
  const r = await fetch(`https://graph.instagram.com/v21.0/me/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
      message: { attachment: { type: 'template', payload: {
        template_type: 'button',
        text,
        buttons: [{ type: 'web_url', url: button.url, title: String(button.label).slice(0, 20) }]
      } } }
    })
  })
  const d = await r.json().catch(() => ({}))
  if (d.error) {
    console.error('[Instagram button send]', d.error.message)
    await sendInstagram(accessToken, recipientId, `${text}\n\n${button.label}: ${button.url}`)
  }
}

// ============================================================
// TWILIO SMS — dual-send alongside WhatsApp for appointment messages only
// ============================================================
export async function sendSMS(cfg, phone, text) {
  if (!cfg.twilio?.accountSid) return
  const e164Phone = phone.startsWith('+') ? phone : `+${phone}`
  try {
    const { sendSMS: twilioSend } = await import('../services/twilio.js')
    await twilioSend(cfg.twilio.accountSid, cfg.twilio.authToken, cfg.twilio.fromNumber, e164Phone, text)
  } catch (err) { console.error('SMS send error:', err.message) }
}

// ============================================================
// WEB CHAT ALERT — notify owner on WhatsApp when a new web chat starts
// ============================================================
async function sendWebChatAlert(companyId, conversationId, firstMessage) {
  const cfg = loadConfig(companyId)
  const alertPhone = (cfg.webAlertPhone || '').replace(/\D/g, '')
  console.log(`[WebAlert] company=${companyId.substring(0,8)} alertPhone=${alertPhone||'(vacío)'}`)
  if (!alertPhone) { console.log('[WebAlert] Abortado: webAlertPhone no configurado'); return }
  const conn = waConnections.get(companyId)
  console.log(`[WebAlert] WA status=${conn?.state?.status || 'no conn'} sock=${!!conn?.sock}`)
  if (!conn?.sock || conn.state?.status !== 'open') { console.log('[WebAlert] Abortado: WA no conectado'); return }
  const shortId = conversationId.substring(0, 8)
  const preview = firstMessage.length > 120 ? firstMessage.substring(0, 117) + '...' : firstMessage
  const text = `🌐 *Nuevo web chat* | #${shortId}\n\n💬 _"${preview}"_\n\n` +
    `↩️ *Mantén presionado este mensaje → Responder* para contestar directamente al visitante.\n\n` +
    `La IA se pausa automáticamente cuando respondes.`
  try {
    await conn.sock.sendMessage(`${alertPhone}@s.whatsapp.net`, { text })
    console.log(`[WebAlert:${companyId}] Alerta enviada a ${alertPhone}`)
  } catch (err) {
    console.error(`[WebAlert:${companyId}] Error:`, err.message)
  }
}

// ============================================================
// CORE CHAT processMessage
// ============================================================
export async function processMessage({ companyId, message, conversationId, visitorId, channel, pageUrl, pageTitle, isNewSession }) {
  const cfg = loadConfig(companyId)
  let convId = conversationId
  const now = Date.now()

  if (!convId && visitorId && channel !== 'web') {
    const existing = db.prepare("SELECT id FROM conversations WHERE visitor_id = ? AND channel = ? AND company_id = ? ORDER BY updated_at DESC LIMIT 1").get(visitorId, channel, companyId)
    if (existing) convId = existing.id
  }

  let isReactivation = false
  if (!convId) {
    convId = crypto.randomUUID()
    db.prepare('INSERT INTO conversations (id, visitor_id, channel, created_at, updated_at, company_id) VALUES (?, ?, ?, ?, ?, ?)').run(convId, visitorId || 'anon', channel || 'web', now, now, companyId)
  } else {
    // ensure conv belongs to same company
    const owner = db.prepare('SELECT company_id, human_mode, updated_at FROM conversations WHERE id = ?').get(convId)
    if (owner && owner.company_id !== companyId) {
      // re-create under correct company
      convId = crypto.randomUUID()
      db.prepare('INSERT INTO conversations (id, visitor_id, channel, created_at, updated_at, company_id) VALUES (?, ?, ?, ?, ?, ?)').run(convId, visitorId || 'anon', channel || 'web', now, now, companyId)
    } else {
      // Auto-reset human_mode for web conversations idle >30 min (prevents test pollution)
      const idleMs = now - (owner?.updated_at || 0)
      if (channel === 'web' && idleMs > 30 * 60 * 1000) {
        isReactivation = true
        db.prepare('UPDATE conversations SET human_mode = 0, updated_at = ? WHERE id = ?').run(now, convId)
      } else {
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId)
      }
    }
  }

  // Check conversation state BEFORE inserting the new user message
  const aiRepliesCount = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ? AND role = 'assistant'").get(convId)
  const lastAiMessage = db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1").get(convId)

  db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(convId, 'user', message, now)
  // Reset retargeting so it fires again after new activity
  db.prepare('UPDATE conversations SET retargeting_sent = 0 WHERE id = ?').run(convId)

  const contacts = extractContacts(message)
  const conv = db.prepare('SELECT lead_email, lead_phone, lead_name, lead_notified, human_mode, web_alert_sent FROM conversations WHERE id = ?').get(convId)

  // Send web chat alert only after the client replies to the system's first message
  if (channel === 'web' && aiRepliesCount.cnt >= 1 && !conv.web_alert_sent) {
    db.prepare('UPDATE conversations SET web_alert_sent = 1 WHERE id = ?').run(convId)
    setImmediate(() => sendWebChatAlert(companyId, convId, message))
  }

  // Auto-expire human_mode if owner hasn't replied in 10 min
  if (channel === 'web' && conv.human_mode) {
    const lastOwner = db.prepare("SELECT MAX(created_at) as ts FROM messages WHERE conversation_id = ? AND role = 'assistant'").get(convId)
    if (!lastOwner?.ts || (now - lastOwner.ts) > 10 * 60 * 1000) {
      db.prepare('UPDATE conversations SET human_mode = 0 WHERE id = ?').run(convId)
      conv.human_mode = 0
    }
  }

  // Human takeover — skip AI
  if (conv.human_mode) return { reply: null, conversationId: convId }

  // Keyword triggers — deterministic match/flow, bypasses the LLM entirely
  const activeFlow = getActiveTriggerFlow(convId)
  if (activeFlow) {
    const t = cfg.keywordTriggers?.[activeFlow.triggerIndex]
    const steps = t?.steps || []
    const stepMsg = steps[activeFlow.step]
    if (stepMsg) {
      if (activeFlow.step >= steps.length - 1) clearTriggerFlow(convId)
      else advanceTriggerFlow(convId, activeFlow.step + 1)
      const info = db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(convId, 'assistant', stepMsg.message, Date.now())
      return { conversationId: convId, reply: stepMsg.message, button: null, messageId: info.lastInsertRowid }
    }
    clearTriggerFlow(convId) // el activador fue editado/borrado mientras el flujo estaba en curso
  } else {
    const match = matchKeywordTrigger(cfg, message)
    if (match) {
      const { trigger, index } = match
      if (trigger.type === 'flow' && trigger.steps?.length) {
        startTriggerFlow(convId, index)
        const info = db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(convId, 'assistant', trigger.steps[0].message, Date.now())
        return { conversationId: convId, reply: trigger.steps[0].message, button: null, messageId: info.lastInsertRowid }
      }
      if (trigger.response) {
        const info = db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(convId, 'assistant', trigger.response, Date.now())
        return { conversationId: convId, reply: trigger.response, button: trigger.button || null, messageId: info.lastInsertRowid }
      }
    }
  }

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
  // Extract name: explicit patterns OR response to AI asking for name
  if (!conv.lead_name) {
    const namePat = /(?:me llamo|soy|mi nombre es|my name is|mi nombre:|nombre:)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i
    const nm = message.match(namePat)
    if (nm) {
      db.prepare('UPDATE conversations SET lead_name = ? WHERE id = ?').run(nm[1].trim(), convId)
      newLead = true
    } else if (lastAiMessage?.content && /con quién|cómo te llamas|tu nombre|me dices tu nombre|¿y tú\?/i.test(lastAiMessage.content)) {
      // AI asked for name — treat short response as the name
      const trimmed = message.trim()
      if (trimmed.length >= 2 && trimmed.length <= 40 && /^[A-ZÁÉÍÓÚÑ\s'-]+$/i.test(trimmed)) {
        db.prepare('UPDATE conversations SET lead_name = ? WHERE id = ?').run(trimmed, convId)
        newLead = true
      }
    }
  }
  // Extract email: explicit in message OR response to AI asking for email
  if (!conv.lead_email && !contacts.emails[0] && lastAiMessage?.content && /correo|email|e-mail/i.test(lastAiMessage.content)) {
    const emailPat = /[\w.+-]+@[\w-]+\.[\w.-]+/
    const em = message.match(emailPat)
    if (em) {
      db.prepare('UPDATE conversations SET lead_email = ? WHERE id = ?').run(em[0], convId)
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

  // Check Commerce Pro status
  const commerceRow = db.prepare('SELECT commerce_pro_enabled, commerce_pro_status FROM companies WHERE id = ?').get(companyId)
  const hasCommercePro = commerceRow?.commerce_pro_enabled === 1 && commerceRow?.commerce_pro_status === 'active'

  const commerceSystemBlock = hasCommercePro
    ? '\n\nTIENES ACCESO AL CATÁLOGO DE PRODUCTOS. Cuando el usuario pregunte por productos, precios, disponibilidad, alternativas o muestre intención de compra, usa la herramienta search_products para buscar en el catálogo. Siempre incluye la URL del producto en tus respuestas. Si un producto está agotado, ofrece alternativas.'
    : ''

  const hasSquare = !!(cfg.square?.access_token)
  const squareSystemBlock = hasSquare
    ? `\n\nTIENES ACCESO AL SISTEMA DE CITAS DE SQUARE. Flujo OBLIGATORIO:\n1) Usa square_get_services para mostrar los servicios disponibles.\n2) En un mismo mensaje pide: nombre completo y teléfono del cliente.\n3) Cuando tengas servicio + nombre + teléfono, pregunta la fecha y hora preferida.\n4) Llama a square_book_appointment — el sistema reserva el slot más cercano disponible automáticamente.\nNUNCA pidas correo electrónico. NUNCA muestres horarios antes de tener nombre y teléfono. NUNCA inventes disponibilidad.`
    : ''

  // Med Spa vertical: forces structured output via respond_to_patient instead
  // of raw text. Phase 1 scoping: mutually exclusive with Commerce/Square tools
  // in the same call (tool_choice forces exactly one tool) — Phase 2 will
  // generalize this into a "terminal tool" pattern that composes with the
  // GHL booking tool. See docs/superpowers/plans for the medspa design.
  const isMedspa = cfg.industry === 'medspa'
  const isLynkroLead = companyId === LYNKRO_COMPANY_ID

  const hasCalendarProvider = ['square', 'ghl', 'google'].includes(cfg.calendarProvider)
  // Medspa forces tool_choice: respond_to_patient below, so it structurally cannot call
  // find_my_appointments/reschedule_appointment/cancel_appointment (only registered in the
  // non-medspa branch of activeTools) — never advertise them in the medspa prompt either.
  const appointmentsSystemBlock = (hasCalendarProvider && !isMedspa && !isLynkroLead)
    ? `\n\nPUEDES REAGENDAR Y CANCELAR CITAS. Flujo OBLIGATORIO:\n1) Llama a find_my_appointments para ver las citas futuras del cliente.\n2) Si hay una sola, confírmala por fecha/hora antes de continuar. Si hay varias, pregunta cuál. Si no hay ninguna, dilo — no inventes una cita.\n3) Para reagendar: pide la nueva fecha/hora, llama a check_availability, y si no está libre ofrece la alternativa más cercana. Solo llama a reschedule_appointment después de que el cliente confirme el horario exacto ya verificado.\n4) Para cancelar: pide confirmación explícita ("¿confirmas que quieres cancelar tu cita del [fecha]?") antes de llamar a cancel_appointment.\nNUNCA reagendes ni canceles sin esa confirmación explícita del cliente. Si find_my_appointments o reschedule_appointment/cancel_appointment devuelven un error, dile al cliente que hubo un problema técnico y que el equipo lo confirma manualmente — nunca digas que ya quedó hecho si la herramienta falló.`
    : ''

  let medspaState = isMedspa ? loadMedspaState(convId) : null
  const medspaSystemBlock = isMedspa ? buildMedspaPromptModule(cfg, medspaState) : ''

  let leadState = isLynkroLead ? loadLeadState(convId) : null
  const leadSystemBlock = isLynkroLead ? buildLynkroLeadPromptModule(leadState) : ''

  const activeTools = []
  if (isMedspa) {
    activeTools.push(RESPOND_TO_PATIENT_TOOL)
  } else if (isLynkroLead) {
    activeTools.push(RESPOND_TO_LEAD_TOOL)
  } else {
    if (hasCommercePro) activeTools.push(SEARCH_PRODUCTS_TOOL)
    if (hasSquare) activeTools.push(SQUARE_GET_SERVICES_TOOL, SQUARE_BOOK_APPOINTMENT_TOOL)
    if (hasCalendarProvider) activeTools.push(FIND_MY_APPOINTMENTS_TOOL, CHECK_AVAILABILITY_TOOL, RESCHEDULE_APPOINTMENT_TOOL, CANCEL_APPOINTMENT_TOOL)
  }

  const callParams = {
    model: cfg.model || 'claude-haiku-4-5-20251001',
    max_tokens: (hasCommercePro || hasSquare || isMedspa || isLynkroLead) ? 800 : 350,
    system: buildSystemPrompt(cfg) + knowledgeText + pageCtx + commerceSystemBlock + squareSystemBlock + appointmentsSystemBlock + medspaSystemBlock + leadSystemBlock,
    messages: (isMedspa ? windowHistory(history, 20, 16) : history).map(m => ({ role: m.role, content: m.content }))
  }
  if (activeTools.length > 0) callParams.tools = activeTools
  if (isMedspa) callParams.tool_choice = { type: 'tool', name: 'respond_to_patient' }
  else if (isLynkroLead) callParams.tool_choice = { type: 'tool', name: 'respond_to_lead' }

  let response = await createMessageWithRetry(callParams)
  const discussedProductIds = []

  // Med Spa: forced tool_choice guarantees the structured block on the first
  // response — no action-tool loop needed yet (Phase 2 adds GHL booking here).
  let medspaResult = null
  if (isMedspa) {
    const block = response.content.find(b => b.type === 'tool_use' && b.name === 'respond_to_patient')
    if (block) {
      const { valid, errors } = validateAgentResponse(block.input)
      if (!valid) console.warn('[medspa] respond_to_patient validation errors:', errors)
      medspaResult = block.input
    } else {
      // Defensive fallback — should not happen with tool_choice forced, but never crash the reply path.
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
      console.warn('[medspa] model did not call respond_to_patient, falling back to raw text')
      medspaResult = {
        message_to_user: text || 'Dame un momento, ya te ayudo.',
        next_state: medspaState.current_state,
        primary_intent: 'UNCLEAR',
        lead_temperature: medspaState.lead_temperature,
        confidence: 0,
        handoff_required: false,
        follow_up_eligible: false,
        conversation_summary_update: medspaState.conversation_summary
      }
    }
  }

  // Lynkro lead qualification: same forced tool_choice pattern as medspa.
  let leadResult = null
  if (isLynkroLead) {
    const block = response.content.find(b => b.type === 'tool_use' && b.name === 'respond_to_lead')
    if (block) {
      const { valid, errors } = validateLeadResponse(block.input)
      if (!valid) console.warn('[lynkro-lead] respond_to_lead validation errors:', errors)
      leadResult = block.input
    } else {
      // Defensive fallback — should not happen with tool_choice forced, but never crash the reply path.
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
      console.warn('[lynkro-lead] model did not call respond_to_lead, falling back to raw text')
      leadResult = {
        message_to_user: text || 'Dame un momento, ya te ayudo.',
        next_state: leadState.current_state,
        handoff_required: false,
        conversation_summary_update: leadState.conversation_summary
      }
    }
  }

  // Tool-use loop (max 3 iterations to prevent runaway) — skipped for medspa/lynkro-lead (see above)
  let iterations = 0
  while (!isMedspa && !isLynkroLead && response.stop_reason === 'tool_use' && iterations < 3) {
    iterations++
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use')
    const toolResults = []

    for (const block of toolUseBlocks) {
      let resultContent
      try {
        if (block.name === 'search_products') {
          const { query, intent, product_id } = block.input
          const searchResult = buildSearchResponse(db, companyId, query, intent, product_id || null)
          discussedProductIds.push(...searchResult.products.map(p => p.id))
          resultContent = JSON.stringify(searchResult)
        } else if (block.name === 'square_get_services') {
          const token = cfg.square.access_token
          const services = await getServices(token)
          resultContent = JSON.stringify({ services })
        } else if (block.name === 'square_book_appointment') {
          const token = cfg.square.access_token
          const { service_variation_id, service_variation_version, requested_date, requested_time, customer_name, customer_phone, customer_email, note } = block.input
          console.log('[Square] book_appointment:', requested_date, requested_time, customer_name)
          const result = await squareBookAppointment(token, {
            serviceVariationId: service_variation_id,
            serviceVariationVersion: service_variation_version,
            requestedDate: requested_date,
            requestedTime: requested_time,
            customerName: customer_name,
            customerPhone: customer_phone,
            customerEmail: customer_email,
            note
          })
          console.log('[Square] booked:', result.bookingId, result.confirmedTime)
          resultContent = JSON.stringify(result)
        } else if (block.name === 'find_my_appointments') {
          const phone = visitorId?.startsWith('wa:') ? visitorId.slice(3) : (conv.lead_phone || '').replace(/\D/g, '')
          if (!phone) { resultContent = JSON.stringify({ error: 'No se pudo determinar el teléfono del cliente' }) }
          else if (cfg.calendarProvider === 'square') {
            const { getBookings, getCustomers, normalizeBooking } = await import('../services/square.js')
            const token = cfg.square.access_token
            const customers = await getCustomers(token)
            const match = customers.find(c => (c.phone_number || '').replace(/\D/g, '').endsWith(phone.slice(-10)))
            const now = new Date().toISOString()
            const in90 = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
            const bookings = match ? (await getBookings(token, now, in90)).filter(b => b.customer_id === match.id) : []
            resultContent = JSON.stringify({ appointments: bookings.map(normalizeBooking) })
          } else if (cfg.calendarProvider === 'ghl') {
            const { getAppointments, getContact } = await import('../services/ghl.js')
            const now = new Date().toISOString()
            const in90 = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
            const appts = await getAppointments(cfg.ghl.api_key, cfg.ghl.location_id, now, in90)
            const matched = []
            for (const a of appts) {
              try {
                const contact = await getContact(cfg.ghl.api_key, a.contactId)
                if ((contact.phone || '').replace(/\D/g, '').endsWith(phone.slice(-10))) matched.push(a)
              } catch {}
            }
            resultContent = JSON.stringify({ appointments: matched.map(a => ({ id: a.id, startTime: a.startTime, title: a.title })) })
          } else if (cfg.calendarProvider === 'google') {
            const { getValidAccessToken, findEventsByPhone } = await import('../services/google-calendar.js')
            const token = await getValidAccessToken(cfg)
            saveConfig(companyId, cfg) // persist a possibly-refreshed access_token/expires_at
            const events = await findEventsByPhone(token, cfg.googleCalendar.calendar_id, phone)
            resultContent = JSON.stringify({ appointments: events.map(e => ({ id: e.id, startTime: e.start?.dateTime, title: e.summary })) })
          } else {
            resultContent = JSON.stringify({ error: 'Esta empresa no tiene un proveedor de calendario soportado' })
          }
        } else if (block.name === 'check_availability') {
          const { appointment_id, start_iso, duration_minutes } = block.input
          const endISO = new Date(new Date(start_iso).getTime() + duration_minutes * 60000).toISOString()
          if (cfg.calendarProvider === 'square') {
            const { getBookings, searchAvailability } = await import('../services/square.js')
            const token = cfg.square.access_token
            const now = new Date().toISOString()
            const in90 = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
            const current = (await getBookings(token, now, in90)).find(b => b.id === appointment_id)
            if (!current) { resultContent = JSON.stringify({ error: 'Cita no encontrada' }) }
            else {
              const segment = current.appointment_segments?.[0]
              const slots = await searchAvailability(token, {
                serviceVariationId: segment?.service_variation_id,
                startAt: start_iso,
                endAt: endISO,
                locationId: current.location_id
              })
              const available = slots.some(s => Math.abs(new Date(s.startAt).getTime() - new Date(start_iso).getTime()) < 60_000)
              resultContent = JSON.stringify({ available })
            }
          } else if (cfg.calendarProvider === 'ghl') {
            const { getAppointments } = await import('../services/ghl.js')
            const windowStart = new Date(new Date(start_iso).getTime() - 60 * 60 * 1000).toISOString()
            const windowEnd = new Date(new Date(endISO).getTime() + 60 * 60 * 1000).toISOString()
            const nearby = await getAppointments(cfg.ghl.api_key, cfg.ghl.location_id, windowStart, windowEnd)
            const requestedStart = new Date(start_iso).getTime()
            const requestedEnd = new Date(endISO).getTime()
            const conflict = nearby.some(a => {
              if (a.id === appointment_id) return false // don't count the appointment being moved as a conflict with itself
              const aStart = new Date(a.startTime).getTime()
              const aEnd = new Date(a.endTime || a.startTime).getTime()
              return aStart < requestedEnd && aEnd > requestedStart
            })
            resultContent = JSON.stringify({ available: !conflict })
          } else if (cfg.calendarProvider === 'google') {
            const { getValidAccessToken, checkFreeBusy } = await import('../services/google-calendar.js')
            const token = await getValidAccessToken(cfg)
            saveConfig(companyId, cfg)
            const available = await checkFreeBusy(token, cfg.googleCalendar.calendar_id, start_iso, endISO)
            resultContent = JSON.stringify({ available })
          } else {
            resultContent = JSON.stringify({ error: 'Esta empresa no tiene un proveedor de calendario soportado' })
          }
        } else if (block.name === 'reschedule_appointment') {
          const { appointment_id, new_start_iso, new_end_iso } = block.input
          try {
            if (cfg.calendarProvider === 'square') {
              const { getBookings, updateBooking } = await import('../services/square.js')
              const token = cfg.square.access_token
              const now = new Date().toISOString()
              const in90 = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
              // appointment_id is trusted from the model's own find_my_appointments call earlier in
              // this conversation; it is not independently re-verified against the requester's phone here.
              const current = (await getBookings(token, now, in90)).find(b => b.id === appointment_id)
              if (!current) throw new Error('Cita no encontrada')
              const minNoticeHours = cfg.citas?.minNoticeHours ?? 4
              const policy = canModifyAppointment({ startTimeISO: current.start_at, minNoticeHours })
              if (!policy.allowed) { resultContent = JSON.stringify({ error: `No se puede reagendar con menos de ${minNoticeHours} horas de anticipación` }) }
              else {
                const updated = await updateBooking(token, appointment_id, { startAt: new_start_iso, version: current.version })
                resultContent = JSON.stringify({ ok: true, booking: updated })
                setImmediate(() => sendNotification({ type: 'reschedule', conversationId: convId, companyId }))
              }
            } else if (cfg.calendarProvider === 'ghl') {
              const { getAppointments, updateAppointment } = await import('../services/ghl.js')
              const now = new Date().toISOString()
              const in90 = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
              // appointment_id is trusted from the model's own find_my_appointments call earlier in
              // this conversation; it is not independently re-verified against the requester's phone here.
              const current = (await getAppointments(cfg.ghl.api_key, cfg.ghl.location_id, now, in90)).find(a => a.id === appointment_id)
              if (!current) throw new Error('Cita no encontrada')
              const minNoticeHours = cfg.citas?.minNoticeHours ?? 4
              const policy = canModifyAppointment({ startTimeISO: current.startTime, minNoticeHours })
              if (!policy.allowed) { resultContent = JSON.stringify({ error: `No se puede reagendar con menos de ${minNoticeHours} horas de anticipación` }) }
              else {
                const updated = await updateAppointment(cfg.ghl.api_key, appointment_id, { startTime: new_start_iso, endTime: new_end_iso })
                resultContent = JSON.stringify({ ok: true, appointment: updated })
                setImmediate(() => sendNotification({ type: 'reschedule', conversationId: convId, companyId }))
              }
            } else if (cfg.calendarProvider === 'google') {
              const { getValidAccessToken, getEvents, updateEvent } = await import('../services/google-calendar.js')
              const token = await getValidAccessToken(cfg)
              saveConfig(companyId, cfg)
              const now = new Date().toISOString()
              const in90 = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
              // appointment_id is trusted from the model's own find_my_appointments call earlier in
              // this conversation; it is not independently re-verified against the requester's phone here.
              const current = (await getEvents(token, cfg.googleCalendar.calendar_id, now, in90)).find(e => e.id === appointment_id)
              if (!current) throw new Error('Cita no encontrada')
              const minNoticeHours = cfg.citas?.minNoticeHours ?? 4
              const policy = canModifyAppointment({ startTimeISO: current.start?.dateTime, minNoticeHours })
              if (!policy.allowed) { resultContent = JSON.stringify({ error: `No se puede reagendar con menos de ${minNoticeHours} horas de anticipación` }) }
              else {
                const updated = await updateEvent(token, cfg.googleCalendar.calendar_id, appointment_id, { startISO: new_start_iso, endISO: new_end_iso })
                resultContent = JSON.stringify({ ok: true, event: updated })
                setImmediate(() => sendNotification({ type: 'reschedule', conversationId: convId, companyId }))
              }
            } else {
              resultContent = JSON.stringify({ error: 'Esta empresa no tiene un proveedor de calendario soportado' })
            }
          } catch (err) {
            resultContent = JSON.stringify({ error: err.message })
          }
        } else if (block.name === 'cancel_appointment') {
          const { appointment_id } = block.input
          try {
            if (cfg.calendarProvider === 'square') {
              const { getBookings, cancelBooking } = await import('../services/square.js')
              const token = cfg.square.access_token
              const now = new Date().toISOString()
              const in90 = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
              // appointment_id is trusted from the model's own find_my_appointments call earlier in
              // this conversation; it is not independently re-verified against the requester's phone here.
              const current = (await getBookings(token, now, in90)).find(b => b.id === appointment_id)
              if (!current) throw new Error('Cita no encontrada')
              const minNoticeHours = cfg.citas?.minNoticeHours ?? 4
              const policy = canModifyAppointment({ startTimeISO: current.start_at, minNoticeHours })
              if (!policy.allowed) { resultContent = JSON.stringify({ error: `No se puede cancelar con menos de ${minNoticeHours} horas de anticipación` }) }
              else {
                const cancelled = await cancelBooking(token, appointment_id, current.version)
                resultContent = JSON.stringify({ ok: true, booking: cancelled })
                setImmediate(() => sendNotification({ type: 'cancel', conversationId: convId, companyId }))
              }
            } else if (cfg.calendarProvider === 'ghl') {
              const { getAppointments, cancelAppointment } = await import('../services/ghl.js')
              const now = new Date().toISOString()
              const in90 = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
              // appointment_id is trusted from the model's own find_my_appointments call earlier in
              // this conversation; it is not independently re-verified against the requester's phone here.
              const current = (await getAppointments(cfg.ghl.api_key, cfg.ghl.location_id, now, in90)).find(a => a.id === appointment_id)
              if (!current) throw new Error('Cita no encontrada')
              const minNoticeHours = cfg.citas?.minNoticeHours ?? 4
              const policy = canModifyAppointment({ startTimeISO: current.startTime, minNoticeHours })
              if (!policy.allowed) { resultContent = JSON.stringify({ error: `No se puede cancelar con menos de ${minNoticeHours} horas de anticipación` }) }
              else {
                const cancelled = await cancelAppointment(cfg.ghl.api_key, appointment_id)
                resultContent = JSON.stringify({ ok: true, appointment: cancelled })
                setImmediate(() => sendNotification({ type: 'cancel', conversationId: convId, companyId }))
              }
            } else if (cfg.calendarProvider === 'google') {
              const { getValidAccessToken, getEvents, deleteEvent } = await import('../services/google-calendar.js')
              const token = await getValidAccessToken(cfg)
              saveConfig(companyId, cfg)
              const now = new Date().toISOString()
              const in90 = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
              // appointment_id is trusted from the model's own find_my_appointments call earlier in
              // this conversation; it is not independently re-verified against the requester's phone here.
              const current = (await getEvents(token, cfg.googleCalendar.calendar_id, now, in90)).find(e => e.id === appointment_id)
              if (!current) throw new Error('Cita no encontrada')
              const minNoticeHours = cfg.citas?.minNoticeHours ?? 4
              const policy = canModifyAppointment({ startTimeISO: current.start?.dateTime, minNoticeHours })
              if (!policy.allowed) { resultContent = JSON.stringify({ error: `No se puede cancelar con menos de ${minNoticeHours} horas de anticipación` }) }
              else {
                await deleteEvent(token, cfg.googleCalendar.calendar_id, appointment_id)
                resultContent = JSON.stringify({ ok: true })
                setImmediate(() => sendNotification({ type: 'cancel', conversationId: convId, companyId }))
              }
            } else {
              resultContent = JSON.stringify({ error: 'Esta empresa no tiene un proveedor de calendario soportado' })
            }
          } catch (err) {
            resultContent = JSON.stringify({ error: err.message })
          }
        } else {
          resultContent = JSON.stringify({ error: `Herramienta desconocida: ${block.name}` })
        }
      } catch (err) {
        console.error('[Square tool error]', block.name, err.message)
        resultContent = JSON.stringify({ error: err.message })
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultContent })
    }

    // Append assistant turn + tool results
    callParams.messages = [
      ...callParams.messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults }
    ]
    response = await client.messages.create(callParams)
  }

  const reply = isMedspa ? medspaResult.message_to_user : isLynkroLead ? leadResult.message_to_user : response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()

  // Track products discussed in this conversation
  if (discussedProductIds.length > 0) {
    const existing = db.prepare('SELECT id, products_discussed FROM commerce_conversations WHERE session_id = ? AND account_id = ?').get(convId, companyId)
    const merged = [...new Set([...(existing ? JSON.parse(existing.products_discussed || '[]') : []), ...discussedProductIds])]
    if (existing) {
      db.prepare('UPDATE commerce_conversations SET products_discussed = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), Date.now(), existing.id)
    } else {
      const lead = db.prepare('SELECT lead_email FROM conversations WHERE id = ?').get(convId)
      db.prepare(`INSERT INTO commerce_conversations
        (id, account_id, session_id, contact_id, channel, products_discussed, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(crypto.randomUUID(), companyId, convId, lead?.lead_email || null, 'web', JSON.stringify(merged), Date.now(), Date.now())
    }
  }
  const info = db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(convId, 'assistant', reply, Date.now())

  if (isMedspa) {
    medspaResult.last_meaningful_user_message = message
    medspaState = saveMedspaState(convId, medspaResult)

    if (medspaResult.primary_intent === 'OPT_OUT' || medspaResult.next_state === 'DO_NOT_CONTACT') {
      setDoNotContact(convId)
    }
    if (medspaResult.handoff_required) {
      const c = db.prepare('SELECT escalated_notified FROM conversations WHERE id = ?').get(convId)
      db.prepare('UPDATE conversations SET unresolved = 1 WHERE id = ?').run(convId)
      if (!c.escalated_notified) {
        db.prepare('UPDATE conversations SET escalated_notified = 1 WHERE id = ?').run(convId)
        setImmediate(() => sendNotification({ type: 'escalation', conversationId: convId, companyId }))
      }
    }
  } else if (isLynkroLead) {
    leadState = saveLeadState(convId, leadResult)
    if (shouldNotifyQualified(leadState)) {
      leadState = saveLeadState(convId, { qualified_notified: true })
      setImmediate(() => sendNotification({ type: 'qualified_lead', conversationId: convId, companyId }))
    }
    if (leadResult.next_state === 'DO_NOT_CONTACT') {
      setDoNotContact(convId)
    }
    if (leadResult.handoff_required) {
      const c = db.prepare('SELECT escalated_notified FROM conversations WHERE id = ?').get(convId)
      db.prepare('UPDATE conversations SET unresolved = 1 WHERE id = ?').run(convId)
      if (!c.escalated_notified) {
        db.prepare('UPDATE conversations SET escalated_notified = 1 WHERE id = ?').run(convId)
        setImmediate(() => sendNotification({ type: 'escalation', conversationId: convId, companyId }))
      }
    }
  } else if (/no (tengo|sé|conozco)|no puedo (ayudart|responder)|contacta(r)? (al|con) (el )?(equipo|negocio)|pasar tu consulta/i.test(reply)) {
    const c = db.prepare('SELECT escalated_notified FROM conversations WHERE id = ?').get(convId)
    db.prepare('UPDATE conversations SET unresolved = 1 WHERE id = ?').run(convId)
    if (!c.escalated_notified) {
      db.prepare('UPDATE conversations SET escalated_notified = 1 WHERE id = ?').run(convId)
      setImmediate(() => sendNotification({ type: 'escalation', conversationId: convId, companyId }))
    }
  }
  return { conversationId: convId, reply, button: null, messageId: info.lastInsertRowid }
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

// ============================================================
// WA SESSION LOCK — Signal Protocol sessions get corrupted (Bad MAC on
// specific contacts, silently dropped messages) if two processes ever
// hold a live Baileys socket for the same company's WhatsApp at once.
// This happens for real: `docker service update` doesn't stop the old
// Swarm task the instant the new one starts, so both auto-start every
// company's WhatsApp on boot and briefly race for the same session
// (confirmed root cause of the 2026-07-13/16 corruption incidents).
// waConnections is per-process memory, so it can't prevent this on its
// own — this lock lives in the shared SQLite DB (same volume both
// containers mount) so it works across container instances, not just
// within one process. Whoever holds a live (non-stale) lock for a
// companyId is the only process allowed to open that socket.
// ============================================================
const WA_LOCK_HOLDER = `${os.hostname()}:${process.pid}`
const WA_LOCK_STALE_MS = 90 * 1000 // ~3 missed heartbeats (health check runs every 30s)

function waLockKey(companyId) { return `wa_lock:${companyId}` }

// Atomic acquire-or-renew: succeeds if no lock exists, if we already hold
// it (renew), or if the existing holder's heartbeat is stale (assume
// dead/replaced). `changes > 0` tells us whether we actually got it —
// this single UPSERT is the only place the decision is made, so there's
// no read-then-write race window between two processes.
function tryAcquireWaLock(companyId) {
  const now = Date.now()
  const value = JSON.stringify({ holder: WA_LOCK_HOLDER, heartbeatAt: now })
  const result = db.prepare(`
    INSERT INTO server_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE json_extract(server_config.value, '$.holder') = ?
       OR json_extract(server_config.value, '$.heartbeatAt') < ?
  `).run(waLockKey(companyId), value, WA_LOCK_HOLDER, now - WA_LOCK_STALE_MS)
  return result.changes > 0
}

function releaseWaLock(companyId) {
  db.prepare(`DELETE FROM server_config WHERE key = ? AND json_extract(value, '$.holder') = ?`)
    .run(waLockKey(companyId), WA_LOCK_HOLDER)
}

// Release every lock this process holds on graceful shutdown (Swarm sends
// SIGTERM before SIGKILL on every deploy) so the replacement task can grab
// WhatsApp immediately instead of waiting out WA_LOCK_STALE_MS with nobody
// connected. Registering this listener suppresses Node's default
// terminate-on-SIGTERM behavior, so it must call process.exit() itself.
process.on('SIGTERM', async () => {
  // Close every live socket BEFORE releasing the lock. Swarm uses start-first
  // deploys, so the replacement task is already trying to acquire this lock;
  // if we release it while our WebSocket is still draining, both processes
  // briefly hold a live socket on the same device → 440 conflict storm that can
  // crash the new task (observed 2026-07-22). Ending the socket first and
  // waiting for it to actually close means the new task only connects once the
  // device is genuinely free. sock.end() closes the WS WITHOUT logging out
  // (unlike sock.logout()), so no QR re-link is needed.
  try {
    for (const conn of waConnections.values()) {
      try { conn.sock?.end(undefined) } catch {}
    }
    // Let the WS close frames flush — bounded well under Swarm's ~10s stop grace.
    await new Promise(r => setTimeout(r, 3000))
  } catch {}
  for (const companyId of waConnections.keys()) releaseWaLock(companyId)
  process.exit(0)
})

// ============================================================
// DECRYPT FAILURE ALERT — libsignal drops undecryptable WhatsApp messages
// silently (no reply attempted, nothing saved to DB). Notify admin so a
// lost message doesn't go unnoticed like the 2026-07-15/16 incident.
// ============================================================
// ============================================================
// CRITICAL ALERT — two channels, deliberately: WhatsApp alone is
// what's failing when these fire, so an email (independent of the
// WA socket entirely) is the only channel guaranteed to still work.
// ============================================================
const CRITICAL_ALERT_COOLDOWNS = {}
const CRITICAL_ALERT_COOLDOWN_MS = 5 * 60 * 1000

// Best-effort acknowledgment sent to the customer when processMessage throws,
// so a real lead never sits in total silence even when the AI reply fails.
const FALLBACK_REPLY = {
  'español': 'Recibimos tu mensaje, en breve te responderemos. 🙂',
  'inglés': "We've received your message and will reply shortly. 🙂",
  'portugués': 'Recebemos sua mensagem, em breve responderemos. 🙂',
  'francés': 'Nous avons reçu votre message, nous répondrons bientôt. 🙂',
  'hebreo': 'קיבלנו את הודעתך, נחזור אליך בקרוב. 🙂',
  'italiano': 'Abbiamo ricevuto il tuo messaggio, ti risponderemo presto. 🙂',
  'alemán': 'Wir haben deine Nachricht erhalten und antworten dir in Kürze. 🙂'
}

async function sendCriticalAlert(kind, message) {
  console.log(`[CriticalAlert] Disparado: "${kind}"`)
  const now = Date.now()
  if (now - (CRITICAL_ALERT_COOLDOWNS[kind] || 0) < CRITICAL_ALERT_COOLDOWN_MS) {
    console.log(`[CriticalAlert] Suprimido por cooldown: "${kind}"`)
    return
  }
  CRITICAL_ALERT_COOLDOWNS[kind] = now
  let cfg
  try {
    cfg = loadConfig(LYNKRO_COMPANY_ID)
  } catch (err) {
    console.log('[CriticalAlert] loadConfig falló:', err.message)
    return
  }
  const fullText = `⚠️ ${kind}\n\n${message}\n\n🕐 ${new Date().toISOString()}`

  try {
    const alertPhone = (cfg.webAlertPhone || '').replace(/\D/g, '')
    const conn = [...waConnections.values()].find(c => c.state?.status === 'open' && c.sock)
    if (alertPhone && conn) await conn.sock.sendMessage(`${alertPhone}@s.whatsapp.net`, { text: fullText })
  } catch (err) { console.log('[CriticalAlert] Canal WhatsApp falló:', err.message) }

  try {
    const mailer = getMailer(cfg)
    if (mailer) {
      await mailer.sendMail({
        from: cfg.smtpFrom || cfg.smtpUser,
        to: cfg.notifyEmail,
        subject: `⚠️ ${kind} — Lynkro`,
        html: `<pre style="font-family:monospace;white-space:pre-wrap;font-size:14px">${fullText.replace(/</g, '&lt;')}</pre>`
      })
    }
  } catch (err) { console.log('[CriticalAlert] Canal email falló:', err.message) }

  console.log(`[CriticalAlert] "${kind}" enviado`)
}

const _origConsoleError = console.error.bind(console)
console.error = (...args) => {
  _origConsoleError(...args)
  try {
    if (args.some(a => typeof a === 'string' && a.includes('Failed to decrypt message with any known session'))) {
      _origConsoleError('[CriticalAlert] Patrón de decrypt failure detectado, disparando alerta...')
      sendCriticalAlert(
        'Fallo de descifrado en WhatsApp (Bad MAC)',
        'Un mensaje entrante no pudo procesarse (sesión corrupta) y no recibió respuesta automática. Revisa el WhatsApp del negocio afectado por si alguien quedó sin respuesta.'
      ).catch(err => _origConsoleError('[CriticalAlert] sendCriticalAlert rechazó:', err?.message))
    }
  } catch (err) {
    _origConsoleError('[CriticalAlert] Error en el interceptor de console.error:', err?.message)
  }
}
_origConsoleError('[CriticalAlert] Interceptor de console.error instalado')
sendCriticalAlert(
  'DIAGNÓSTICO — arranque del sistema',
  'Mensaje de prueba automático para confirmar que las alertas críticas (WhatsApp + email) funcionan tras este despliegue. Si ves esto, el canal funciona.'
).catch(err => _origConsoleError('[CriticalAlert] Diagnóstico de arranque falló:', err?.message))

// ============================================================
// CRASH GUARD — Baileys throws uncaught errors during connection churn
// (e.g. a query 'Timed Out' Boom during a 440-conflict storm on deploy,
// observed 2026-07-22) that would otherwise kill PID 1 and drop WhatsApp
// for ~90s until a replacement task waits out the lock staleness. These are
// transient socket/protocol errors — log them but keep the process alive;
// the existing reconnect logic recovers. Only truly unknown errors are
// allowed to bring the process down (Swarm then restarts it cleanly).
// ============================================================
function isRecoverableWaError(err) {
  const msg = (err && (err.message || String(err))) || ''
  const code = err?.output?.statusCode ?? err?.statusCode
  return /Timed Out|Connection Closed|Connection Terminated|conflict|Stream Errored|rate-overlimit|not-authorized|Bad MAC|decrypt/i.test(msg)
    || [DisconnectReason.timedOut, DisconnectReason.connectionClosed, DisconnectReason.connectionLost, 440, 428, 515].includes(code)
}
process.on('unhandledRejection', (reason) => {
  _origConsoleError('[CrashGuard] unhandledRejection:', reason?.message || reason)
})
process.on('uncaughtException', (err) => {
  _origConsoleError('[CrashGuard] uncaughtException:', err?.message || err)
  if (!isRecoverableWaError(err)) {
    sendCriticalAlert('Excepción no capturada en el servidor', String(err?.stack || err?.message || err).slice(0, 600))
      .catch(() => {})
    setTimeout(() => process.exit(1), 1500) // let the alert flush, then let Swarm restart clean
  }
})

// ============================================================
// AUTO-HEAL — a WhatsApp message that fails to decrypt (Bad MAC / corrupt
// Signal session) arrives as a CIPHERTEXT stub with no content and is dropped
// silently. Baileys' own sendRetryRequest handles transient cases, but a
// PERMANENTLY corrupt session keeps failing every retry forever (the exact
// symptom behind the 2026-06/07 lost-lead incidents). Track decrypt failures
// per contact; once one crosses the threshold, delete that contact's session
// (cache + disk via the cacheable keystore) so their NEXT message re-negotiates
// a fresh session from scratch — no human, no QR, no restart.
// ============================================================
const WA_BADMAC_THRESHOLD = 3            // failures before we intervene (lets Baileys retry first)
const WA_BADMAC_WINDOW_MS = 10 * 60 * 1000
const WA_BADMAC_RESET_COOLDOWN_MS = 10 * 60 * 1000 // don't thrash the same contact
const _badMacHits = new Map()            // `${companyId}:${user}` -> [timestamps]
const _lastSessionReset = new Map()      // `${companyId}:${user}` -> ts

async function resetCorruptSession(companyId, conn, remoteJid) {
  try {
    const user = String(remoteJid).split('@')[0].split(':')[0]
    const authDir = path.join(waBaseDir, companyId)
    let addrs = []
    try {
      addrs = fs.readdirSync(authDir)
        .filter(f => f.startsWith(`session-${user}.`) && f.endsWith('.json'))
        .map(f => f.slice('session-'.length, -'.json'.length))
    } catch {}
    if (!addrs.length) addrs = [`${user}.0`] // fallback: at least the primary device
    if (conn._sigKeys) {
      const del = {}
      for (const a of addrs) del[a] = null
      await conn._sigKeys.set({ session: del }) // evicts in-memory cache AND deletes files
    }
    console.log(`[WA:${companyId}] Auto-heal: sesión reseteada para ${user} (${addrs.length} addr) — re-negocia al próximo mensaje`)
    sendCriticalAlert(
      'Auto-reparación de sesión WhatsApp',
      `Se detectó corrupción persistente (Bad MAC) del contacto ${user} (empresa ${companyId}). Su sesión se reseteó automáticamente; el próximo mensaje de ese contacto re-negociará una sesión nueva y debería procesarse con normalidad.`
    ).catch(() => {})
  } catch (err) {
    console.log(`[WA:${companyId}] Auto-heal falló para ${remoteJid}:`, err.message)
  }
}

function recordBadMacAndMaybeHeal(companyId, conn, remoteJid) {
  const user = String(remoteJid).split('@')[0].split(':')[0]
  const key = `${companyId}:${user}`
  const now = Date.now()
  const hits = (_badMacHits.get(key) || []).filter(t => now - t < WA_BADMAC_WINDOW_MS)
  hits.push(now)
  _badMacHits.set(key, hits)
  const lastReset = _lastSessionReset.get(key) || 0
  if (hits.length >= WA_BADMAC_THRESHOLD && now - lastReset > WA_BADMAC_RESET_COOLDOWN_MS) {
    _lastSessionReset.set(key, now)
    _badMacHits.set(key, [])
    resetCorruptSession(companyId, conn, remoteJid)
  }
}

export async function startBuiltinWhatsApp(companyId) {
  const conn = getWaConn(companyId)
  // Company migrated to Evolution API transport → never open the in-process
  // builtin socket for it. A single WhatsApp number linked to BOTH builtin and
  // Evolution would double-receive (duplicate replies) and 440-conflict. This
  // one gate covers every caller: boot-loop, 30s retry-loop, watchdog, QR endpoint.
  if (usesEvolution(loadConfig(companyId))) return
  // Reentry guard: the 30s watchdog (checkWaStuckReconnect) and the retry loop
  // can both call this for the same company in the same tick. conn.sock isn't
  // assigned until after two awaits below, so both would pass a `!conn.sock`
  // check and create a SECOND live socket — two sockets on one session fight
  // forever over a 440 conflict. The DB lock doesn't help (same holder → true).
  if (conn._starting) return
  if (!tryAcquireWaLock(companyId)) {
    console.log(`[WA:${companyId}] No se inicia: otro proceso ya tiene la sesión activa (lock ocupado) — se reintentará solo si ese lock queda obsoleto`)
    return
  }
  conn._starting = true
  const authDir = path.join(waBaseDir, companyId)
  try {
    fs.mkdirSync(authDir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    const { version } = await fetchLatestBaileysVersion()

    // Keep a direct reference to the cacheable signal keystore so the auto-heal
    // path can evict a corrupted contact's session (cache + disk) on demand.
    const sigKeys = makeCacheableSignalKeyStore(state.keys, SILENT_LOGGER)
    conn._sigKeys = sigKeys
    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: sigKeys },
      printQRInTerminal: false,
      logger: SILENT_LOGGER,
      browser: ['Mi Agente IA', 'Chrome', '120.0.0'],
      markOnlineOnConnect: false,
    })
    conn.sock = sock

    sock.ev.on('creds.update', saveCreds)

    conn._stateSince = Date.now()
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        const dataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 1, errorCorrectionLevel: 'M' })
        conn.state = { status: 'qr', qr: dataUrl, phone: null }
        conn._stateSince = Date.now()
        console.log(`[WA:${companyId}] QR listo`)
      }
      if (connection === 'open') {
        const phone = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || null
        conn.state = { status: 'open', qr: null, phone }
        conn._stateSince = Date.now()
        console.log(`[WA:${companyId}] Conectado: ${phone}`)
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        const loggedOut = code === DisconnectReason.loggedOut
        conn.state = { status: loggedOut ? 'logged_out' : 'disconnected', qr: null, phone: null }
        conn._stateSince = Date.now()
        console.log(`[WA:${companyId}] Desconectado código:${code} reintento:${!loggedOut}`)
        if (loggedOut) releaseWaLock(companyId) // done with this company on this process — let a fresh login (or another process) take the lock immediately
        if (!loggedOut) setTimeout(() => startBuiltinWhatsApp(companyId), 5000)
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        // Auto-heal: a message that failed to decrypt (Bad MAC / corrupt session)
        // comes through as a CIPHERTEXT stub (StubType 2) with no decrypted
        // content — msg.message is null, so it would be skipped below. Track it
        // per contact BEFORE that skip; persistent failures trigger a session
        // reset so the contact's next message re-negotiates cleanly.
        if (msg.messageStubType === 2 && msg.key?.remoteJid && !msg.key.fromMe) {
          const badJid = msg.key.remoteJid
          if (!badJid.endsWith('@g.us')) recordBadMacAndMaybeHeal(companyId, conn, badJid)
        }
        if (!msg.message) continue
        const remoteJid = msg.key.remoteJid
        if (remoteJid.endsWith('@g.us')) continue

        let text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.ephemeralMessage?.message?.conversation
          || null

        const audioMsg = msg.message?.audioMessage || msg.message?.ephemeralMessage?.message?.audioMessage
        if (!text?.trim() && audioMsg && !msg.key.fromMe) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {})
            text = await transcribeAudioBuffer(buffer, audioMsg.mimetype)
            if (text?.trim()) console.log(`[WA:${companyId}] Nota de voz transcrita: "${text.slice(0, 80)}"`)
          } catch (err) {
            console.error(`[WA:${companyId}] Error transcribiendo audio:`, err.message)
          }
        }

        if (!text?.trim()) continue
        const phone = remoteJid.replace('@s.whatsapp.net', '')
        const visitorId = `wa:${phone}`

        // Handle commands sent FROM the business phone (fromMe)
        if (msg.key.fromMe) {
          const cmd = text.trim()
          if (cmd === '*' || cmd === '**') {
            const conv = db.prepare("SELECT id FROM conversations WHERE visitor_id = ? AND company_id = ? AND channel = 'whatsapp' ORDER BY updated_at DESC LIMIT 1").get(visitorId, companyId)
            if (conv) {
              const mode = cmd === '*' ? 1 : 0
              db.prepare('UPDATE conversations SET human_mode = ? WHERE id = ?').run(mode, conv.id)
              console.log(`[WA:${companyId}] human_mode=${mode} para ${visitorId}`)
            }
          }
          continue // never process fromMe messages through AI
        }

        // Web chat relay — two methods:
        // 1) Reply (quote) the alert message in WhatsApp → extract #shortId from quoted text
        // 2) Manual: type #shortId message (legacy, still supported)
        const quotedText = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation
          || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text
          || ''
        const quotedIdMatch = quotedText.match(/#([a-f0-9]{8})\b/i)
        const directRelayMatch = text.trim().match(/^#([a-f0-9]{8})\s+([\s\S]+)$/i)

        if (quotedIdMatch || directRelayMatch) {
          const shortId = (quotedIdMatch ? quotedIdMatch[1] : directRelayMatch[1]).toLowerCase()
          const replyText = directRelayMatch ? directRelayMatch[2].trim() : text.trim()
          const webConv = db.prepare("SELECT id FROM conversations WHERE id LIKE ? AND company_id = ? AND channel = 'web' ORDER BY updated_at DESC LIMIT 1").get(shortId + '%', companyId)
          if (webConv) {
            if (replyText === '*') {
              db.prepare('UPDATE conversations SET human_mode = 1 WHERE id = ?').run(webConv.id)
              await sock.sendMessage(remoteJid, { text: `⏸ IA pausada en web chat.` })
            } else if (replyText === '**') {
              db.prepare('UPDATE conversations SET human_mode = 0 WHERE id = ?').run(webConv.id)
              await sock.sendMessage(remoteJid, { text: `▶ IA reactivada en web chat.` })
            } else {
              db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(webConv.id, 'assistant', replyText, Date.now())
              db.prepare('UPDATE conversations SET updated_at = ?, human_mode = 1 WHERE id = ?').run(Date.now(), webConv.id)
              await sock.sendMessage(remoteJid, { text: `✅ Enviado al visitante.` })
            }
            console.log(`[WebRelay:${companyId}] Relay ${shortId} → "${replyText.substring(0, 50)}"`)
          } else {
            await sock.sendMessage(remoteJid, { text: `⚠️ No encontré conversación web #${shortId}.` })
          }
          continue
        }

        try {
          const result = await processMessage({ companyId, message: text.trim(), visitorId, channel: 'whatsapp' })
          if (result?.reply) {
            const waText = result.button
              ? `${result.reply}\n\n👉 *${result.button.label}*\n${result.button.url}`
              : result.reply
            await sock.sendMessage(remoteJid, { text: waText })
          }
        } catch (err) {
          console.error(`[WA:${companyId}] Error:`, err.message)
          sendCriticalAlert(
            'Mensaje de WhatsApp sin respuesta automática',
            `Empresa: ${companyId}\nDe: ${phone}\nMensaje: "${text.trim().slice(0, 200)}"\nError: ${err.message}`
          ).catch(() => {})
          try {
            const fallbackCfg = loadConfig(companyId)
            const fallback = FALLBACK_REPLY[fallbackCfg.language] || FALLBACK_REPLY['español']
            await sock.sendMessage(remoteJid, { text: fallback })
          } catch {}
        }
      }
    })
  } catch (err) {
    console.error(`[WA:${companyId}] Error iniciando:`, err.message)
    conn.state.status = 'disconnected'
    setTimeout(() => startBuiltinWhatsApp(companyId), 10000)
  } finally {
    conn._starting = false
  }
}

// ============================================================
// WA HEALTH CHECK — Baileys' 'open' state doesn't guarantee the
// underlying socket is still alive; a zombie socket can sit in
// state 'open' forever with no close event firing, silently
// dropping every incoming message with zero trace. Every few
// minutes, probe each "open" connection with a lightweight
// presence update; if it doesn't complete in time, force-close
// the socket so the existing close-handler reconnect logic
// (already deduped, single path) takes over — never call
// startBuiltinWhatsApp directly here to avoid a second socket
// racing the one the close handler will spawn.
// ============================================================
const WA_HEALTH_CHECK_INTERVAL_MS = 30 * 1000
const WA_HEALTH_CHECK_TIMEOUT_MS = 8 * 1000
// If a connection sits in any non-'open' state (connecting/disconnected/qr)
// this long without ever reaching 'open' or a fresh 'close' event, something
// got stuck between reconnect attempts — e.g. makeWASocket() itself hanging
// mid-handshake, which never fires connection.update at all, so neither the
// close-handler's setTimeout nor the health check (which only watches 'open'
// connections) would ever notice on their own.
const WA_STUCK_THRESHOLD_MS = 2 * 60 * 1000

async function checkWaConnHealth(companyId, conn) {
  if (conn.state?.status !== 'open' || !conn.sock) return
  try {
    await Promise.race([
      conn.sock.sendPresenceUpdate('available'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), WA_HEALTH_CHECK_TIMEOUT_MS))
    ])
  } catch (err) {
    console.log(`[WA:${companyId}] Health check falló (${err.message}) — cerrando socket zombie para forzar reconexión`)
    try { conn.sock?.end(new Error('health-check-failed')) } catch (e) { console.error(`[WA:${companyId}] Error cerrando socket zombie:`, e.message) }
  }
}

function checkWaStuckReconnect(companyId, conn) {
  if (conn.state?.status === 'open' || conn.state?.status === 'logged_out') return
  // A lock-blocked company at boot lands in 'waiting'/'connecting' with
  // _stateSince never stamped. `Date.now() - 0` then reads as ~55 years, so the
  // watchdog would force-restart immediately and spawn a duplicate socket.
  // Stamp it now and let the next cycles measure a real age instead.
  if (!conn._stateSince) { conn._stateSince = Date.now(); return }
  const stuckFor = Date.now() - conn._stateSince
  if (stuckFor < WA_STUCK_THRESHOLD_MS) return
  conn._stateSince = Date.now() // reset immediately so a slow restart can't retrigger this every cycle
  console.log(`[WA:${companyId}] Atascado en estado "${conn.state?.status}" por ${Math.round(stuckFor / 1000)}s — forzando reinicio`)
  if (conn.sock) {
    try { conn.sock.end(new Error('stuck-reconnect-watchdog')) } catch (e) { console.error(`[WA:${companyId}] Error cerrando socket atascado:`, e.message) }
  } else {
    conn._starting = false // clear any stale in-flight guard so this recovery restart isn't blocked
    // No socket was ever created for this cycle (e.g. makeWASocket() itself
    // hung) — nothing will emit a close event to trigger the normal reconnect
    // path, so this is the one case where calling startBuiltinWhatsApp
    // directly here is safe: there's no live socket it could race against.
    startBuiltinWhatsApp(companyId).catch(err => console.error(`[WA:${companyId}] Error reiniciando tras atasco:`, err.message))
  }
}

setInterval(() => {
  for (const [companyId, conn] of waConnections) {
    if (conn.state?.status === 'logged_out') continue
    tryAcquireWaLock(companyId) // renew heartbeat so another process can't mistake us for dead
    checkWaConnHealth(companyId, conn).catch(err => console.error(`[WA:${companyId}] Error en health check:`, err.message))
    checkWaStuckReconnect(companyId, conn)
  }
  // Retry companies whose lock was held by someone else last time we tried
  // (e.g. the old task during a deploy overlap) — once that lock goes
  // stale, this is what actually recovers the connection, since nothing
  // else calls startBuiltinWhatsApp again for a company that never got
  // a socket in the first place.
  try {
    if (fs.existsSync(waBaseDir)) {
      for (const cid of fs.readdirSync(waBaseDir)) {
        if (!fs.existsSync(path.join(waBaseDir, cid, 'creds.json'))) continue
        const conn = waConnections.get(cid)
        if (!conn || !conn.sock) startBuiltinWhatsApp(cid).catch(err => console.error(`[WA:${cid}] Error reintentando arranque:`, err.message))
      }
    }
  } catch {}
}, WA_HEALTH_CHECK_INTERVAL_MS)

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
        messages: [{ role: 'user', content: `Eres "${cfg.agentName || 'Asistente'}" de "${cfg.businessName}". Escribe UN mensaje de seguimiento corto y natural para retomar esta conversación. Responde en el mismo idioma que el cliente usó en la conversación de abajo — nunca cambies de idioma. Sin emojis, sin listas, máximo 2 oraciones:\n\n${context}` }]
      })
      const retargetMsg = resp.content[0].text.trim()
      if (conv.channel === 'whatsapp') {
        const conn = waConnections.get(conv.company_id)
        if (conn?.sock && conn.state?.status === 'open') {
          await conn.sock.sendMessage(conv.visitor_id.replace('wa:', ''), { text: retargetMsg })
        } else {
          await sendWhatsApp(cfg, conv.visitor_id.replace('wa:', ''), retargetMsg)
        }
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

// ============================================================
// LYNKRO FOLLOW-UP JOB — qualification flow follow-ups
// ============================================================

// Phases: early = calificación (bot_count 1-2), mid = número de impacto mostrado (3), late = demo ofrecida (4+)
// Copy agnóstica de rubro y orientada a agendar el próximo paso concreto.
const LYNKRO_FU = {
  fu1: {
    early: '¿Alcanzaste a ver mi mensaje? Sin robarte tiempo: ¿cuántos mensajes de clientes sientes que se te quedan sin responder a la semana?',
    mid:   '¿Qué te pareció el número? Con solo unos pocos mensajes perdidos por semana, el monto al mes suele sorprender. ¿Te muestro cómo lo resolvería el sistema con tu negocio real?',
    late:  'Quedamos en que te mostraba el sistema en vivo — son 15 min, sin compromiso, y lo ves con tu caso real. ¿Lo agendamos?'
  },
  fu2: {
    early: 'Sin apuro. Si me cuentas a qué se dedica tu negocio, te armo el cálculo de cuánto podrías estar dejando sobre la mesa cada mes. Un estimado alcanza.',
    mid:   'Ese número es siendo conservador — la mayoría deja escapar más de lo que cree. ¿Le damos 15 minutos para verlo en vivo con tu caso?',
    late:  'Sé que andas ocupado. ¿Lo dejamos agendado y listo? Eliges el horario que te quede y lo vemos en vivo, sin compromiso.'
  },
  fu3: 'Una última para cerrar el tema: ¿sigue siendo prioridad dejar de perder esos clientes que se van sin respuesta, o lo retomamos más adelante?'
}

// Follow-up post-demo (Etapa 4C) — se dispara 24h después de que un humano marca
// "Demo hecho" en el dashboard (state.demo_done + state.demo_done_at), no antes.
const POST_DEMO_MSG = 'Gracias por el tiempo del demo 🙌 ¿Qué te quedó dando vueltas después de verlo? Si hay algo que no quedó claro o que te frena, prefiero saberlo directo antes que asumir. Sin presión, solo quiero entender tu punto.'

// Etapa 6 — retomar 30/60/90 días con un ángulo nuevo cada vez. La base de tiempo
// es el ÚLTIMO mensaje del lead (no updated_at, que nuestros propios envíos mueven).
function reengSituation(lq) {
  const neg = lq?.business_type ? `tu ${lq.business_type}` : 'tu negocio'
  return `Hola, ¿cómo va todo? La última vez me contabas de ${neg}. ¿Cambió algo en cómo manejas los mensajes con tus clientes, o sigue más o menos igual? Lo pregunto sin intención de venderte nada — solo por saber si el tema sigue ahí.`
}
function reengGuide(cfg) {
  const base = 'Hola 👋 Armamos una guía gratis de 7 puntos para responder a tus clientes en menos de 2 minutos, sin contratar a nadie nuevo. Te la dejo por si te sirve para tu operación'
  const tail = ' — sin compromiso, cero venta detrás.'
  return cfg?.reengageGuideUrl ? `${base}: ${cfg.reengageGuideUrl}${tail}` : `${base}${tail}`
}
function reengCase(lq, cfg) {
  const byVertical = {
    clinica_estetica: 'Hace poco una clínica en Brickell bajó su tiempo de respuesta de 4 horas a 90 segundos y recuperó 11 citas que se le escapaban, en el primer mes.',
    salon_belleza: 'Hace poco un salón dejó de perder clientas que reservaban con la competencia solo porque no alcanzaban a contestar a tiempo — el sistema les respondía al instante.',
    ecommerce: 'Hace poco una tienda recuperó ventas que se le perdían en preguntas de producto que quedaban sin responder — el sistema contestaba al toque y cerraba.'
  }
  const base = byVertical[lq?.vertical] || 'Hace poco un negocio como el tuyo dejó de perder clientes por no responder a tiempo — el sistema contesta al instante, como lo harías tú.'
  const intro = 'Hola 👋 '
  const outro = ' No sé si tu situación cambió, pero quería compartirte el caso por si te resulta útil'
  return cfg?.reengageCaseUrl ? `${intro}${base}${outro}: ${cfg.reengageCaseUrl}` : `${intro}${base}${outro}.`
}

// Envío de un follow-up de Lynkro por el canal correcto (WhatsApp builtin/Twilio o Instagram).
async function sendLynkroFU(conv, cfg, text) {
  if (conv.channel === 'whatsapp') {
    const conn = waConnections.get(conv.company_id)
    if (conn?.sock && conn.state?.status === 'open') {
      const rawJid = conv.visitor_id.replace('wa:', '')
      const jid = rawJid.includes('@') ? rawJid : `${rawJid}@s.whatsapp.net`
      const result = await conn.sock.sendMessage(jid, { text })
      console.log(`[Lynkro FU] sendMessage result=${result ? result.key?.id : 'null'}`)
    } else {
      console.log(`[Lynkro FU] no conn or not open for company ${conv.company_id}`)
      await sendWhatsApp(cfg, conv.visitor_id.replace('wa:', ''), text)
    }
  } else {
    await sendInstagram(cfg.igAccessToken, conv.visitor_id.replace('ig:', ''), text)
  }
}

export async function runLynkroFollowUp() {
  const now = Date.now()
  const H4  = 4  * 60 * 60 * 1000
  const H24 = 24 * 60 * 60 * 1000
  const D3  = 3  * 24 * 60 * 60 * 1000
  const D7  = 7  * 24 * 60 * 60 * 1000
  const D30 = 30 * 24 * 60 * 60 * 1000
  const D60 = 60 * 24 * 60 * 60 * 1000
  const D90 = 90 * 24 * 60 * 60 * 1000

  const convs = db.prepare(`
    SELECT id, visitor_id, channel, updated_at, flow_state, company_id
    FROM conversations
    WHERE company_id = ?
      AND channel IN ('whatsapp','instagram')
      AND human_mode = 0
      AND do_not_contact = 0
  `).all(LYNKRO_COMPANY_ID)

  const cfg = loadConfig(LYNKRO_COMPANY_ID)

  for (const conv of convs) {
    try {
      const state = conv.flow_state ? JSON.parse(conv.flow_state) : {}
      // Legacy: leads ya agotados por la cadencia vieja (>=30d silencio) tienen
      // nurture=true; se saltan para NO disparar una ráfaga de reactivaciones en
      // el deploy. Los leads que se enfríen de acá en adelante usan reeng30/60/90.
      if (state.nurture) continue

      const lq = state.leadQuali || {}

      // (1) Post-demo (Etapa 4C): 24h después de que un humano marca "Demo hecho"
      // en el dashboard. Independiente del silencio — se envía aunque el lead haya
      // respondido, porque es una invitación a dar feedback del demo.
      if (state.demo_done && state.demo_done_at && !state.post_demo_sent && (now - state.demo_done_at) >= H24) {
        await sendLynkroFU(conv, cfg, POST_DEMO_MSG)
        state.post_demo_sent = true
        db.prepare('UPDATE conversations SET flow_state = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(state), now, conv.id)
        db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(conv.id, 'assistant', POST_DEMO_MSG, now)
        console.log(`[Lynkro FU] post_demo → ${conv.visitor_id}`)
        continue
      }

      // Only follow up when last message was from the bot (lead hasn't replied)
      const lastMsg = db.prepare('SELECT role FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1').get(conv.id)
      if (!lastMsg || lastMsg.role !== 'assistant') continue

      // Detect phase: early=calificación, mid=shock factor shown, late=demo offered
      const { bot_count } = db.prepare(`SELECT SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END) as bot_count FROM messages WHERE conversation_id = ?`).get(conv.id)
      const phase = bot_count >= 4 ? 'late' : bot_count === 3 ? 'mid' : 'early'

      // Temperatura del lead (leadQuali.temperature). Un lead FRIO ("el mes que
      // viene", sin prisa) recibe UN solo seguimiento suave (fu1) y no se le
      // insiste más en la cadencia corta; igual entra a la reactivación 30/60/90.
      const isCold = lq.temperature === 'FRIO'

      // Cadencia corta = desde la última actividad (updated_at, que nuestros propios
      // envíos mueven). Cadencia larga (Etapa 6) = desde el ÚLTIMO mensaje del lead,
      // que es estable y no se corre cuando el bot manda un follow-up.
      const elapsed = now - conv.updated_at
      const lu = db.prepare("SELECT MAX(created_at) as t FROM messages WHERE conversation_id = ? AND role = 'user'").get(conv.id)
      const elapsedUser = now - (lu?.t || conv.updated_at)
      let fuKey = null
      let fuText = null

      if      (elapsed >= H4  && elapsed < H24 && !state.fu1) { fuKey = 'fu1'; fuText = LYNKRO_FU.fu1[phase] }
      else if (!isCold && elapsed >= H24 && elapsed < D3  && !state.fu2) { fuKey = 'fu2'; fuText = LYNKRO_FU.fu2[phase] }
      else if (!isCold && elapsed >= D3  && elapsed < D7  && !state.fu3) { fuKey = 'fu3'; fuText = LYNKRO_FU.fu3 }
      // Etapa 6 — reactivación con ángulo nuevo. Descendente para que un lead ya
      // muy frío (p.ej. 100 días) reciba solo el ángulo más reciente, no los tres.
      else if (elapsedUser >= D90 && !state.reeng90) { fuKey = 'reeng90'; fuText = reengCase(lq, cfg) }
      else if (elapsedUser >= D60 && elapsedUser < D90 && !state.reeng60) { fuKey = 'reeng60'; fuText = reengGuide(cfg) }
      else if (elapsedUser >= D30 && elapsedUser < D60 && !state.reeng30) { fuKey = 'reeng30'; fuText = reengSituation(lq) }

      if (!fuKey || !fuText) continue

      // En etapas de demo/cierre (mid/late), adjunta el link de agendamiento para
      // que el próximo paso quede a un clic. Las reactivaciones (reeng*) NO lo llevan:
      // son de valor/curiosidad, no de push a agenda.
      if (!fuKey.startsWith('reeng') && phase !== 'early' && cfg.bookingUrl) fuText += `\n\nAgenda aquí: ${cfg.bookingUrl}`

      await sendLynkroFU(conv, cfg, fuText)

      state[fuKey] = true
      db.prepare('UPDATE conversations SET flow_state = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(state), now, conv.id)
      db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(conv.id, 'assistant', fuText, now)
      console.log(`[Lynkro FU] ${fuKey} → ${conv.visitor_id} (phase:${phase})`)
    } catch (e) { console.error('[Lynkro FU]', e.message) }
  }
}
setInterval(runLynkroFollowUp, 30 * 60 * 1000)

export const chatRouter = express.Router()

// ============================================================
// INBOX — multi-company conversations for admin
// ============================================================
chatRouter.get('/inbox/conversations', requireAdmin, (req, res) => {
  const allCompanies = req.allowedCompanies === null
    ? db.prepare("SELECT id, name FROM companies WHERE active=1").all()
    : db.prepare(`SELECT id, name FROM companies WHERE id IN (${(req.allowedCompanies||[]).map(()=>'?').join(',') || "''"}) AND active=1`).all(req.allowedCompanies || [])

  const rows = []
  for (const co of allCompanies) {
    const convs = db.prepare(`
      SELECT c.id, c.visitor_id, c.channel, c.human_mode, c.created_at, c.updated_at,
        ? as company_id, ? as company_name,
        (SELECT role    FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) as last_role,
        (SELECT content FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) as last_content
      FROM conversations c
      WHERE c.company_id=? AND c.channel='web'
      ORDER BY c.updated_at DESC LIMIT 50
    `).all(co.id, co.name, co.id)
    rows.push(...convs)
  }
  rows.sort((a, b) => b.updated_at - a.updated_at)
  res.json(rows.slice(0, 200))
})

chatRouter.get('/inbox/conversations/:id', requireAdmin, (req, res) => {
  const { companyId } = req.query
  if (!companyId) return res.status(400).json({ error: 'Falta companyId' })
  const conv = db.prepare('SELECT id, human_mode, channel, visitor_id FROM conversations WHERE id=? AND company_id=?').get(req.params.id, companyId)
  if (!conv) return res.status(404).json({ error: 'No encontrada' })
  const msgs = db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id=? ORDER BY created_at ASC').all(req.params.id)
  res.json({ conv, msgs })
})

chatRouter.post('/inbox/conversations/:id/reply', requireAdmin, async (req, res) => {
  const { text, companyId } = req.body
  if (!text?.trim() || !companyId) return res.status(400).json({ error: 'Falta texto o companyId' })
  const conv = db.prepare('SELECT id, channel, visitor_id FROM conversations WHERE id=? AND company_id=?').get(req.params.id, companyId)
  if (!conv) return res.status(404).json({ error: 'No encontrada' })
  const now = Date.now()
  db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(conv.id, 'assistant', text.trim(), now)
  db.prepare('UPDATE conversations SET human_mode=1, updated_at=? WHERE id=?').run(now, conv.id)
  const company = db.prepare('SELECT config FROM companies WHERE id=?').get(companyId)
  const cfg = company?.config ? JSON.parse(company.config) : {}
  try {
    if (conv.channel === 'whatsapp') await sendWhatsApp(cfg, conv.visitor_id.replace('wa:', ''), text.trim())
    else if (conv.channel === 'instagram') await sendInstagram(cfg.igAccessToken, conv.visitor_id.replace('ig:', ''), text.trim())
  } catch (e) { console.error('[inbox reply]', e.message) }
  res.json({ ok: true })
})

chatRouter.post('/inbox/conversations/:id/human-mode', requireAdmin, (req, res) => {
  const { mode, companyId } = req.body
  if (!companyId) return res.status(400).json({ error: 'Falta companyId' })
  const conv = db.prepare('SELECT id FROM conversations WHERE id=? AND company_id=?').get(req.params.id, companyId)
  if (!conv) return res.status(404).json({ error: 'No encontrada' })
  db.prepare('UPDATE conversations SET human_mode=? WHERE id=?').run(mode ? 1 : 0, req.params.id)
  res.json({ ok: true })
})

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
  const channel = req.query.channel || null
  const rows = db.prepare(`
    SELECT c.id, c.visitor_id, c.channel, c.unresolved, c.human_mode, c.created_at, c.updated_at,
      (SELECT role FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_role,
      (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_content
    FROM conversations c
    WHERE c.company_id = ?${channel ? " AND c.channel = ?" : ''}
    ORDER BY c.updated_at DESC LIMIT 150
  `).all(channel ? [req.company.id, channel] : [req.company.id])
  res.json(rows)
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
  const now2 = Date.now()
  db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(conv.id, 'assistant', text.trim(), now2)
  if (conv.channel === 'web') {
    db.prepare('UPDATE conversations SET human_mode = 1, updated_at = ? WHERE id = ?').run(now2, conv.id)
  }
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
chatRouter.get('/chat/poll', withCompany, (req, res) => {
  const { conversationId, after } = req.query
  if (!conversationId) return res.json({ messages: [] })
  const since = parseInt(after) || 0
  const conv = db.prepare('SELECT human_mode FROM conversations WHERE id = ? AND company_id = ?').get(conversationId, req.company.id)
  if (!conv) return res.json({ messages: [] })
  const messages = db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id = ? AND created_at > ? ORDER BY created_at ASC').all(conversationId, since)
  res.json({ messages, human_mode: conv.human_mode })
})

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
      const hasSquareDemo = !!(cfg.square?.access_token)
      const squareSysDemo = hasSquareDemo
        ? `\n\nTIENES ACCESO AL SISTEMA DE CITAS DE SQUARE. Flujo OBLIGATORIO:\n1) Usa square_get_services para mostrar los servicios disponibles.\n2) En un mismo mensaje pide: nombre completo y teléfono del cliente.\n3) Cuando tengas servicio + nombre + teléfono, pregunta la fecha y hora preferida.\n4) Llama a square_book_appointment — el sistema reserva el slot más cercano disponible automáticamente.\nNUNCA pidas correo electrónico. NUNCA muestres horarios antes de tener nombre y teléfono. NUNCA inventes disponibilidad.`
        : ''
      const demoCallParams = {
        model: cfg.model || 'claude-haiku-4-5-20251001',
        max_tokens: hasSquareDemo ? 800 : 350,
        system: buildSystemPrompt(cfg) + knowledgeText + '\n\n[MODO DEMO]' + squareSysDemo,
        messages: msgs
      }
      if (hasSquareDemo) demoCallParams.tools = [SQUARE_GET_SERVICES_TOOL, SQUARE_BOOK_APPOINTMENT_TOOL]
      let demoResp = await client.messages.create(demoCallParams)
      let demoIterations = 0
      while (demoResp.stop_reason === 'tool_use' && demoIterations < 3) {
        demoIterations++
        const toolBlocks = demoResp.content.filter(b => b.type === 'tool_use')
        const toolResults = []
        for (const block of toolBlocks) {
          let resultContent
          try {
            const token = cfg.square.access_token
            if (block.name === 'square_get_services') {
              const services = await getServices(token)
              resultContent = JSON.stringify({ services })
            } else if (block.name === 'square_book_appointment') {
              const { service_variation_id, service_variation_version, requested_date, requested_time, customer_name, customer_phone, customer_email, note } = block.input
              console.log('[Square demo] book_appointment:', requested_date, requested_time, customer_name)
              const result = await squareBookAppointment(token, {
                serviceVariationId: service_variation_id,
                serviceVariationVersion: service_variation_version,
                requestedDate: requested_date,
                requestedTime: requested_time,
                customerName: customer_name,
                customerPhone: customer_phone,
                customerEmail: customer_email,
                note
              })
              console.log('[Square demo] booked:', result.bookingId, result.confirmedTime)
              resultContent = JSON.stringify(result)
            } else {
              resultContent = JSON.stringify({ error: `Herramienta desconocida: ${block.name}` })
            }
          } catch (err) {
            console.error('[Square demo error]', block.name, err.message)
            resultContent = JSON.stringify({ error: err.message })
          }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultContent })
        }
        demoCallParams.messages = [...demoCallParams.messages, { role: 'assistant', content: demoResp.content }, { role: 'user', content: toolResults }]
        demoResp = await client.messages.create(demoCallParams)
      }
      const reply = demoResp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
      return res.json({ reply, history: [...msgs, { role: 'assistant', content: reply }] })
    }

    const isNewSession = !conversationId
    const result = await processMessage({ companyId: req.company.id, message, conversationId, visitorId, channel: 'web', pageUrl, pageTitle, isNewSession })
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
    const cfg = company.config
    const data = ev.data || ev
    const jid = data?.key?.remoteJid || ''
    if (!jid || jid.includes('@g.us')) return
    const phone = jid.split('@')[0]
    const visitorId = `wa:${phone}`

    let text = data.message?.conversation
      || data.message?.extendedTextMessage?.text
      || data.message?.ephemeralMessage?.message?.conversation
      || data.message?.imageMessage?.caption || ''

    // Commands sent FROM the business phone (fromMe)
    if (data?.key?.fromMe) {
      const cmd = text.trim()
      if (cmd === '*' || cmd === '**') {
        const conv = db.prepare("SELECT id FROM conversations WHERE visitor_id = ? AND company_id = ? AND channel = 'whatsapp' ORDER BY updated_at DESC LIMIT 1").get(visitorId, company.id)
        if (conv) {
          const mode = cmd === '*' ? 1 : 0
          db.prepare('UPDATE conversations SET human_mode = ? WHERE id = ?').run(mode, conv.id)
          console.log(`[WA webhook:${company.id}] human_mode=${mode} para ${visitorId}`)
        }
        return
      }
      // Business initiated (not a command) — create conversation with human_mode=1 so AI won't respond when client replies
      const existing = db.prepare("SELECT id FROM conversations WHERE visitor_id = ? AND channel = 'whatsapp' AND company_id = ? ORDER BY updated_at DESC LIMIT 1").get(visitorId, company.id)
      if (!existing) {
        const newId = crypto.randomUUID()
        const now = Date.now()
        db.prepare('INSERT INTO conversations (id, visitor_id, channel, created_at, updated_at, company_id, human_mode) VALUES (?, ?, ?, ?, ?, ?, 1)').run(newId, visitorId, 'whatsapp', now, now, company.id)
        console.log('[WA webhook] Business initiated — human_mode=1 for', visitorId)
      }
      return
    }

    // Voice note: no text but an audio message → download from Evolution + transcribe
    const audioMsg = data.message?.audioMessage || data.message?.ephemeralMessage?.message?.audioMessage
    if (!text.trim() && audioMsg) {
      try {
        const buffer = await fetchEvolutionMediaBuffer(cfg, data)
        if (buffer) {
          text = await transcribeAudioBuffer(buffer, audioMsg.mimetype)
          if (text?.trim()) console.log(`[WA webhook:${company.id}] Nota de voz transcrita: "${text.slice(0, 80)}"`)
        }
      } catch (err) { console.error(`[WA webhook:${company.id}] Error transcribiendo audio:`, err.message) }
    }
    if (!text.trim()) {
      // A voice note we couldn't transcribe (no quota, provider error, empty)
      // must not leave the lead in silence — ask them to type instead.
      if (audioMsg) {
        const fb = cfg.language === 'english'
          ? "Sorry, I couldn't process your voice note 🙏 Could you type your message instead?"
          : "Perdón, no pude escuchar tu audio 🙏 ¿Me lo escribís por texto?"
        await sendWhatsApp(cfg, phone, fb)
      }
      return
    }

    // Web chat relay — reply (quote) the alert message → #shortId, or manual "#shortId message"
    const quotedText = data.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation
      || data.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text
      || ''
    const quotedIdMatch = quotedText.match(/#([a-f0-9]{8})\b/i)
    const directRelayMatch = text.trim().match(/^#([a-f0-9]{8})\s+([\s\S]+)$/i)
    if (quotedIdMatch || directRelayMatch) {
      const shortId = (quotedIdMatch ? quotedIdMatch[1] : directRelayMatch[1]).toLowerCase()
      const replyText = directRelayMatch ? directRelayMatch[2].trim() : text.trim()
      const webConv = db.prepare("SELECT id FROM conversations WHERE id LIKE ? AND company_id = ? AND channel = 'web' ORDER BY updated_at DESC LIMIT 1").get(shortId + '%', company.id)
      if (webConv) {
        if (replyText === '*') {
          db.prepare('UPDATE conversations SET human_mode = 1 WHERE id = ?').run(webConv.id)
          await sendWhatsApp(cfg, phone, `⏸ IA pausada en web chat.`)
        } else if (replyText === '**') {
          db.prepare('UPDATE conversations SET human_mode = 0 WHERE id = ?').run(webConv.id)
          await sendWhatsApp(cfg, phone, `▶ IA reactivada en web chat.`)
        } else {
          db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(webConv.id, 'assistant', replyText, Date.now())
          db.prepare('UPDATE conversations SET updated_at = ?, human_mode = 1 WHERE id = ?').run(Date.now(), webConv.id)
          await sendWhatsApp(cfg, phone, `✅ Enviado al visitante.`)
        }
        console.log(`[WebRelay:${company.id}] Relay ${shortId} → "${replyText.substring(0, 50)}"`)
      } else {
        await sendWhatsApp(cfg, phone, `⚠️ No encontré conversación web #${shortId}.`)
      }
      return
    }

    // Normal inbound → AI
    const result = await processMessage({ companyId: company.id, message: text.trim(), visitorId, channel: 'whatsapp' })
    if (result?.reply) {
      const waText = result.button
        ? `${result.reply}\n\n👉 *${result.button.label}*\n${result.button.url}`
        : result.reply
      await sendWhatsApp(cfg, phone, waText)
    }
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

  const clearAndRestart = () => {
    if (conn.sock) { try { conn.sock.end(new Error('reset')) } catch {} conn.sock = null }
    const authDir = path.join(waBaseDir, cid)
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
    conn.state = { status: 'connecting', qr: null, phone: null }
    startBuiltinWhatsApp(cid).catch(console.error)
  }

  if (conn.state.status !== 'connecting') {
    if (['logged_out', 'disconnected', 'waiting'].includes(conn.state.status)) {
      clearAndRestart()
    } else {
      conn.state.status = 'connecting'
      startBuiltinWhatsApp(cid).catch(console.error)
    }
  }

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (conn.state.status === 'qr') return res.json({ status: 'qr', qr: conn.state.qr })
    if (conn.state.status === 'open') return res.json({ status: 'open', phone: conn.state.phone })
    if (conn.state.status === 'logged_out') { clearAndRestart() }
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
  const state = signState({ companyId: req.company.id })
  const scope = 'instagram_business_basic,instagram_business_manage_messages'
  const url = `https://www.instagram.com/oauth/authorize?client_id=${igAppId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&response_type=code&state=${state}`
  res.redirect(url)
})

// Safely embeds a value inside an inline <script> block as a JS string literal.
function jsStringLiteral(v) {
  return JSON.stringify(String(v ?? '')).replace(/</g, '\\u003C')
}

// OAuth step 2: Instagram redirects back with code
chatRouter.get('/instagram/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error || !code || !state) return res.send(`<script>window.opener?.postMessage({igError:${jsStringLiteral(error || 'cancelled')}}, '*'); window.close();</script>`)
  const parsed = verifyState(state)
  if (!parsed) return res.send('Estado inválido')
  const { companyId } = parsed
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
    res.send(`<script>window.opener?.postMessage({igOk:true,igUsername:${jsStringLiteral(igUsername)},igPageId:${jsStringLiteral(igUserId)}}, '*'); window.close();</script>`)
  } catch (err) {
    console.error('[Instagram OAuth]', err.message)
    res.send(`<script>window.opener?.postMessage({igError:${jsStringLiteral(err.message)}},'*'); window.close();</script>`)
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
        // Acepta */** (convención WhatsApp) y ///// para que el comando de pausa sea igual en todos los canales
        if (text === '/' || text === '//' || text === '*' || text === '**') {
          const visitorId = `ig:${recipientId}`
          const conv = db.prepare("SELECT id FROM conversations WHERE visitor_id = ? AND company_id = ? AND channel = 'instagram' ORDER BY updated_at DESC LIMIT 1").get(visitorId, company.id)
          if (conv) {
            const mode = (text === '/' || text === '*') ? 1 : 0
            db.prepare('UPDATE conversations SET human_mode = ? WHERE id = ?').run(mode, conv.id)
            const ack = mode ? '⏸ IA pausada. Tú tienes el control.' : '▶ IA reactivada.'
            await sendInstagram(cfg.igAccessToken, recipientId, ack)
            console.log(`[Instagram] human_mode=${mode} para ${visitorId}`)
          }
        } else {
          // Business initiated conversation — create with human_mode=1 so AI won't respond when client replies
          const visitorId = `ig:${recipientId}`
          const existing = db.prepare("SELECT id FROM conversations WHERE visitor_id = ? AND company_id = ? AND channel = 'instagram' ORDER BY updated_at DESC LIMIT 1").get(visitorId, company.id)
          if (!existing) {
            const newId = crypto.randomUUID()
            const now = Date.now()
            db.prepare('INSERT INTO conversations (id, visitor_id, channel, created_at, updated_at, company_id, human_mode) VALUES (?, ?, ?, ?, ?, ?, 1)').run(newId, visitorId, 'instagram', now, now, company.id)
            console.log('[Instagram] Business initiated — human_mode=1 for', visitorId)
          }
        }
        continue
      }

      try {
        const result = await processMessage({ companyId: company.id, message: text, visitorId: `ig:${senderId}`, channel: 'instagram' })
        if (result?.reply) {
          if (result.button) await sendInstagramButton(cfg.igAccessToken, senderId, result.reply, result.button)
          else await sendInstagram(cfg.igAccessToken, senderId, result.reply)
        }
      } catch (err) { console.error('[Instagram]', err.message) }
    }
  }
})
