// jobs/campaign-scheduler.js — Daily campaign runner + appointment reminders via GHL
// Imported by sync-scheduler.js

import { db, loadConfig } from '../db.js'
import { getAllContacts, getAppointments, getContact, normalizePhone, fillTemplate } from '../services/ghl.js'
import { sendWhatsApp, sendSMS } from '../routes/chat.js'
import { upsertAppointment, pendingSecondTouch, markSecondSent } from '../services/appointment-confirm.js'

// ────────────────────────────────────────────────────────────
// DB table (idempotent)
// ────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS campaign_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id    TEXT NOT NULL,
    contact_id    TEXT NOT NULL,
    campaign_type TEXT NOT NULL,
    appointment_id TEXT,
    sent_at       TEXT NOT NULL DEFAULT (datetime('now')),
    channel       TEXT,
    status        TEXT DEFAULT 'sent',
    error         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_clog_lookup
    ON campaign_log(company_id, campaign_type, contact_id);
`)

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────
function alreadySent(companyId, contactId, type, withinDays = 90) {
  const since = new Date(Date.now() - withinDays * 86400000).toISOString()
  const row = db.prepare(`
    SELECT 1 FROM campaign_log
    WHERE company_id=? AND contact_id=? AND campaign_type=? AND sent_at>=?
  `).get(companyId, contactId, type, since)
  return !!row
}

function alreadySentAppointment(companyId, appointmentId, type) {
  const row = db.prepare(`
    SELECT 1 FROM campaign_log WHERE company_id=? AND appointment_id=? AND campaign_type=?
  `).get(companyId, appointmentId, type)
  return !!row
}

function logSent(companyId, contactId, type, channel, appointmentId = null, error = null) {
  db.prepare(`
    INSERT INTO campaign_log(company_id,contact_id,campaign_type,appointment_id,channel,status,error)
    VALUES(?,?,?,?,?,?,?)
  `).run(companyId, contactId, type, appointmentId, channel, error ? 'error' : 'sent', error)
}

async function send(cfg, phone, msg, companyId, contactId, type, channel, apptId = null) {
  const normalized = normalizePhone(phone)
  if (!normalized) { logSent(companyId, contactId, type, channel, apptId, 'no_phone'); return }
  try {
    await sendWhatsApp(cfg, normalized, msg)
    logSent(companyId, contactId, type, channel, apptId)
  } catch (e) {
    logSent(companyId, contactId, type, channel, apptId, e.message)
  }
}

function contactName(c) {
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || 'cliente'
}

// ────────────────────────────────────────────────────────────
// Campaign runners
// ────────────────────────────────────────────────────────────

async function runInactive(companyId, cfg, apiKey, locationId, campCfg, appointments180) {
  if (!campCfg?.enabled) return
  const days = parseInt(campCfg.delay) || 45
  const cutoff = new Date(Date.now() - days * 86400000)
  // Build map: contactId → last appointment date
  const lastAppt = {}
  for (const a of appointments180) {
    const d = new Date(a.startTime || a.start)
    if (!lastAppt[a.contactId] || d > lastAppt[a.contactId]) lastAppt[a.contactId] = d
  }
  const contacts = await getAllContacts(apiKey, locationId)
  const businessName = cfg.businessName || cfg.name || 'tu negocio'
  for (const c of contacts) {
    const phone = normalizePhone(c.phone || '')
    if (!phone) continue
    const last = lastAppt[c.id]
    if (last && last > cutoff) continue // still active
    if (!last && new Date(c.dateAdded) > cutoff) continue // new contact, not inactive yet
    if (alreadySent(companyId, c.id, 'inactive', days + 30)) continue
    const daysSince = last ? Math.floor((Date.now() - last) / 86400000) : null
    const msg = fillTemplate(campCfg.message, {
      nombre: contactName(c), dias: daysSince || days, negocio: businessName,
      link_reserva: cfg.bookingUrl || '', servicio: ''
    })
    await send(cfg, phone, msg, companyId, c.id, 'inactive', 'whatsapp')
  }
}

async function runBirthday(companyId, cfg, apiKey, locationId, campCfg) {
  if (!campCfg?.enabled) return
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const contacts = await getAllContacts(apiKey, locationId)
  const businessName = cfg.businessName || cfg.name || 'tu negocio'
  for (const c of contacts) {
    if (!c.dateOfBirth) continue
    const dob = c.dateOfBirth.replace(/\D/g, '-').split('-')
    // Handle both YYYY-MM-DD and MM-DD-YYYY
    let [cm, cd] = dob.length >= 3
      ? (dob[0].length === 4 ? [dob[1], dob[2]] : [dob[0], dob[1]])
      : [null, null]
    if (!cm || !cd) continue
    if (cm.padStart(2,'0') !== mm || cd.padStart(2,'0') !== dd) continue
    if (alreadySent(companyId, c.id, 'birthday', 365)) continue
    const msg = fillTemplate(campCfg.message, {
      nombre: contactName(c), descuento: campCfg.discount || '',
      negocio: businessName, link_reserva: cfg.bookingUrl || ''
    })
    await send(cfg, normalizePhone(c.phone || ''), msg, companyId, c.id, 'birthday', 'whatsapp')
  }
}

async function runReview(companyId, cfg, apiKey, locationId, campCfg, appointments180) {
  if (!campCfg?.enabled) return
  const days = parseInt(campCfg.delay) || 3
  const windowStart = new Date(Date.now() - (days + 1) * 86400000).toISOString()
  const windowEnd   = new Date(Date.now() - days * 86400000).toISOString()
  const businessName = cfg.businessName || cfg.name || 'tu negocio'
  const relevant = appointments180.filter(a => {
    const t = a.startTime || a.start
    return t >= windowStart && t <= windowEnd
  })
  const seen = new Set()
  for (const a of relevant) {
    if (!a.contactId || seen.has(a.contactId)) continue
    seen.add(a.contactId)
    if (alreadySent(companyId, a.contactId, 'review', 365)) continue
    const c = await getContact(apiKey, a.contactId).catch(() => null)
    if (!c) continue
    const msg = fillTemplate(campCfg.message, {
      nombre: contactName(c), negocio: businessName,
      link_resena: campCfg.reviewLink || campCfg.review_link || '', servicio: a.title || ''
    })
    await send(cfg, normalizePhone(c.phone || ''), msg, companyId, a.contactId, 'review', 'whatsapp', a.id)
  }
}

async function runPostConsult(companyId, cfg, apiKey, locationId, campCfg, appointments180) {
  if (!campCfg?.enabled) return
  const days = parseInt(campCfg.delay) || 3
  const windowStart = new Date(Date.now() - (days + 1) * 86400000).toISOString()
  const windowEnd   = new Date(Date.now() - days * 86400000).toISOString()
  const businessName = cfg.businessName || cfg.name || 'tu negocio'
  const relevant = appointments180.filter(a => {
    const t = a.startTime || a.start
    return t >= windowStart && t <= windowEnd
  })
  const seen = new Set()
  for (const a of relevant) {
    if (!a.contactId || seen.has(a.contactId)) continue
    seen.add(a.contactId)
    if (alreadySent(companyId, a.contactId, 'post_consult', 30)) continue
    const c = await getContact(apiKey, a.contactId).catch(() => null)
    if (!c) continue
    const msg = fillTemplate(campCfg.message, {
      nombre: contactName(c), negocio: businessName,
      servicio: a.title || '', dias: days, link_reserva: cfg.bookingUrl || ''
    })
    await send(cfg, normalizePhone(c.phone || ''), msg, companyId, a.contactId, 'post_consult', 'whatsapp', a.id)
  }
}

async function runWinback(companyId, cfg, apiKey, locationId, campCfg, appointments180) {
  if (!campCfg?.enabled) return
  const days = parseInt(campCfg.delay) || 120
  const cutoff = new Date(Date.now() - days * 86400000)
  const lastAppt = {}
  for (const a of appointments180) {
    const d = new Date(a.startTime || a.start)
    if (!lastAppt[a.contactId] || d > lastAppt[a.contactId]) lastAppt[a.contactId] = d
  }
  const contacts = await getAllContacts(apiKey, locationId)
  const businessName = cfg.businessName || cfg.name || 'tu negocio'
  for (const c of contacts) {
    const phone = normalizePhone(c.phone || '')
    if (!phone) continue
    const last = lastAppt[c.id]
    if (last && last > cutoff) continue
    if (!last && new Date(c.dateAdded) > cutoff) continue
    if (alreadySent(companyId, c.id, 'winback', 365)) continue
    const msg = fillTemplate(campCfg.message, {
      nombre: contactName(c), negocio: businessName,
      link_reserva: cfg.bookingUrl || '', descuento: campCfg.discount || ''
    })
    await send(cfg, phone, msg, companyId, c.id, 'winback', 'whatsapp')
  }
}

// ────────────────────────────────────────────────────────────
// Appointment reminders (24h and day-of) — runs daily at 7am
// ────────────────────────────────────────────────────────────
async function runAppointmentReminders(companyId, cfg, apiKey, locationId, citasCfg) {
  const now = new Date()
  // Tomorrow window (for 24h reminder)
  const tmrStart = new Date(now); tmrStart.setDate(tmrStart.getDate() + 1); tmrStart.setHours(0,0,0,0)
  const tmrEnd   = new Date(tmrStart); tmrEnd.setHours(23,59,59,999)
  // Today window (for day-of reminder)
  const todayStart = new Date(now); todayStart.setHours(0,0,0,0)
  const todayEnd   = new Date(now); todayEnd.setHours(23,59,59,999)

  const businessName = cfg.businessName || cfg.name || 'tu negocio'

  async function sendReminder(appts, type, msgTemplate) {
    if (!msgTemplate) return
    for (const a of appts) {
      if (!a.contactId) continue
      if (alreadySentAppointment(companyId, a.id, type)) continue
      const c = await getContact(apiKey, a.contactId).catch(() => null)
      if (!c) continue
      const apptDate = new Date(a.startTime || a.start)
      const msg = fillTemplate(msgTemplate, {
        nombre: contactName(c), negocio: businessName,
        servicio: a.title || '', link_reserva: cfg.bookingUrl || '',
        fecha: apptDate.toLocaleDateString('es-US', { weekday:'long', month:'long', day:'numeric' }),
        hora:  apptDate.toLocaleTimeString('es-US', { hour:'2-digit', minute:'2-digit' })
      })
      const normalized = normalizePhone(c.phone || '')
      await send(cfg, normalized, msg, companyId, a.contactId, type, 'whatsapp', a.id)
      await sendSMS(cfg, normalized, msg)
      // Solo el aviso de 24h abre la ventana de confirmación: el del mismo día
      // ya no da tiempo a reasignar el cupo si la persona dice que no viene.
      if (type === 'cita_24h') {
        upsertAppointment({
          companyId, appointmentId: a.id, contactId: a.contactId,
          contactName: contactName(c), phone: normalized,
          startTime: apptDate.toISOString()
        })
      }
    }
  }

  if (citasCfg?.reminder_24h?.enabled) {
    const appts = await getAppointments(apiKey, locationId, tmrStart.toISOString(), tmrEnd.toISOString())
    await sendReminder(appts, 'cita_24h', citasCfg.reminder_24h.message)
  }
  if (citasCfg?.reminder_day?.enabled) {
    const appts = await getAppointments(apiKey, locationId, todayStart.toISOString(), todayEnd.toISOString())
    await sendReminder(appts, 'cita_day', citasCfg.reminder_day.message)
  }
}

// ────────────────────────────────────────────────────────────
// Segundo paso de la confirmación — corre cada hora
// ────────────────────────────────────────────────────────────
// El primer aviso sale 24h antes junto al recordatorio. Si a las 6 horas la
// persona no dijo ni sí ni no, se insiste una vez. Una sola: el objetivo es
// enterarse a tiempo de que no viene, no perseguir a nadie.
const SEGUNDO_AVISO_HORAS = 6
const SEGUNDO_AVISO_DEFAULT = 'Hola {nombre}, no llegamos a confirmar tu cita de {fecha} a las {hora}. ¿Nos confirmás si podés venir? Respondé SÍ para confirmar, o avisanos si preferís moverla.'

export async function runConfirmationSecondTouch() {
  const companies = db.prepare('SELECT id, config FROM companies WHERE active = 1').all()
  for (const co of companies) {
    let cfg
    try { cfg = JSON.parse(co.config || '{}') } catch { continue }
    const citas = cfg.citas || {}
    if (!citas.reminder_24h?.enabled || citas.confirm_second?.enabled === false) continue

    const horas = Number(citas.confirm_second?.hours) || SEGUNDO_AVISO_HORAS
    const plantilla = citas.confirm_second?.message || SEGUNDO_AVISO_DEFAULT
    const pendientes = pendingSecondTouch(co.id, horas)
    if (!pendientes.length) continue

    console.log(`[confirm-2] ${co.id.substring(0, 8)}: ${pendientes.length} cita(s) sin confirmar`)
    for (const a of pendientes) {
      if (!a.phone) { markSecondSent(co.id, a.appointment_id); continue }
      const d = new Date(a.start_time)
      const msg = fillTemplate(plantilla, {
        nombre: a.contact_name || 'cliente',
        negocio: cfg.businessName || 'tu negocio',
        fecha: d.toLocaleDateString('es-US', { weekday: 'long', month: 'long', day: 'numeric' }),
        hora: d.toLocaleTimeString('es-US', { hour: '2-digit', minute: '2-digit' }),
        link_reserva: cfg.bookingUrl || ''
      })
      try {
        await sendWhatsApp(cfg, a.phone, msg)
        await sendSMS(cfg, a.phone, msg)
      } catch (e) {
        console.error('[confirm-2]', e.message)
      }
      // Se marca pase lo que pase: si el envío falla, insistir cada hora sería
      // peor que perder un aviso.
      markSecondSent(co.id, a.appointment_id)
      logSent(co.id, a.contact_id || a.appointment_id, 'cita_confirm_2', 'whatsapp', a.appointment_id)
    }
  }
}

// ────────────────────────────────────────────────────────────
// Main runner — called by scheduler
// ────────────────────────────────────────────────────────────
export async function runAllCampaigns() {
  const companies = db.prepare('SELECT id, config FROM companies WHERE active = 1').all()
  for (const co of companies) {
    try {
      const cfg = JSON.parse(co.config || '{}')
      if (!cfg.ghl?.api_key || !cfg.ghl?.location_id) continue
      const { api_key, location_id } = cfg.ghl
      const campaigns = cfg.campaigns || {}
      const citas     = cfg.citas || {}

      console.log(`[campaign-scheduler] Running for company ${co.id}`)

      // Pull last 180 days of appointments once (shared by multiple campaigns)
      const start180 = new Date(Date.now() - 180 * 86400000).toISOString()
      const now      = new Date().toISOString()
      const appointments180 = await getAppointments(api_key, location_id, start180, now).catch(() => [])

      await runInactive(co.id, cfg, api_key, location_id, campaigns.inactive, appointments180)
      await runBirthday(co.id, cfg, api_key, location_id, campaigns.birthday)
      await runReview(co.id, cfg, api_key, location_id, campaigns.review, appointments180)
      await runPostConsult(co.id, cfg, api_key, location_id, campaigns.post_consult, appointments180)
      await runWinback(co.id, cfg, api_key, location_id, campaigns.winback, appointments180)
      await runAppointmentReminders(co.id, cfg, api_key, location_id, citas)

    } catch (err) {
      console.error(`[campaign-scheduler] Error company ${co.id}:`, err.message)
    }
  }
}

// ────────────────────────────────────────────────────────────
// SQUARE runners
// ────────────────────────────────────────────────────────────
export async function runSquareCampaigns(companyId, cfg) {
  if (!cfg.square?.access_token) return
  const { getCustomers, getBookings, normalizeCustomer, normalizeBooking } = await import('../services/square.js')
  const campaigns = cfg.campaigns || {}
  const citas     = cfg.citas || {}
  const tok = cfg.square.access_token

  // Pull bookings last 180 days
  const start180 = new Date(Date.now() - 180 * 86400000).toISOString()
  const rawBookings = await getBookings(tok, start180, new Date().toISOString()).catch(() => [])
  const appointments = rawBookings.map(normalizeBooking)

  const rawContacts = await getCustomers(tok).catch(() => [])
  const contacts = rawContacts.map(normalizeCustomer)

  // Build lastAppt map
  const lastAppt = {}
  for (const a of appointments) {
    const d = new Date(a.startTime)
    if (!lastAppt[a.contactId] || d > lastAppt[a.contactId]) lastAppt[a.contactId] = d
  }

  const businessName = cfg.businessName || cfg.name || ''

  // Inactive
  if (campaigns.inactive?.enabled) {
    const days = parseInt(campaigns.inactive.delay) || 45
    const cutoff = new Date(Date.now() - days * 86400000)
    for (const c of contacts) {
      if (!c.phone) continue
      const last = lastAppt[c.id]
      if (last && last > cutoff) continue
      if (alreadySent(companyId, `sq_${c.id}`, 'inactive', days + 30)) continue
      const msg = fillTemplate(campaigns.inactive.message, { nombre: c.name, dias: days, negocio: businessName, link_reserva: cfg.bookingUrl || '' })
      await send(cfg, c.phone, msg, companyId, `sq_${c.id}`, 'inactive', 'whatsapp')
    }
  }

  // Birthday
  if (campaigns.birthday?.enabled) {
    const now = new Date()
    const mm = String(now.getMonth() + 1).padStart(2,'0')
    const dd = String(now.getDate()).padStart(2,'0')
    for (const c of contacts) {
      if (!c.birthday || !c.phone) continue
      const [, cm, cd] = (c.birthday || '').split('-')
      if (!cm || !cd) continue
      if (cm !== mm || cd !== dd) continue
      if (alreadySent(companyId, `sq_${c.id}`, 'birthday', 365)) continue
      const msg = fillTemplate(campaigns.birthday.message, { nombre: c.name, descuento: campaigns.birthday.discount || '', negocio: businessName })
      await send(cfg, c.phone, msg, companyId, `sq_${c.id}`, 'birthday', 'whatsapp')
    }
  }

  // Review + Post-consult (appointment-based)
  for (const [type, campCfg, delayDays] of [['review', campaigns.review, 3], ['post_consult', campaigns.post_consult, 3]]) {
    if (!campCfg?.enabled) continue
    const days = parseInt(campCfg.delay) || delayDays
    const ws = new Date(Date.now() - (days + 1) * 86400000).toISOString()
    const we = new Date(Date.now() - days * 86400000).toISOString()
    const relevant = appointments.filter(a => a.startTime >= ws && a.startTime <= we)
    const seen = new Set()
    for (const a of relevant) {
      if (!a.contactId || seen.has(a.contactId)) continue
      seen.add(a.contactId)
      if (alreadySent(companyId, `sq_${a.contactId}`, type, 90)) continue
      const c = contacts.find(x => x.id === a.contactId)
      if (!c?.phone) continue
      const msg = fillTemplate(campCfg.message, { nombre: c.name, negocio: businessName, servicio: a.title, dias: days, link_reserva: cfg.bookingUrl || '', link_resena: campCfg.reviewLink || '' })
      await send(cfg, c.phone, msg, companyId, `sq_${a.contactId}`, type, 'whatsapp', a.id)
    }
  }

  // Appointment reminders
  await runAppointmentReminders(companyId, cfg, null, null, citas, appointments, contacts)
}

// ────────────────────────────────────────────────────────────
// QBO runners — invoice paid → review/post-consult trigger
// ────────────────────────────────────────────────────────────
export async function runQBOCampaigns(companyId, cfg) {
  if (!cfg.qbo?.access_token) return
  const campaigns = cfg.campaigns || {}
  let accessToken = cfg.qbo.access_token
  const realmId = cfg.qbo.realm_id

  // Refresh token if needed
  try {
    const { refreshAccessToken, getPaidInvoices, getCustomers } = await import('../services/qbo.js')
    // Check token expiry (QBO tokens last 1h) — always try to refresh
    const newTokens = await refreshAccessToken(cfg.qbo.refresh_token).catch(() => null)
    if (newTokens?.access_token) {
      accessToken = newTokens.access_token
      cfg.qbo.access_token = newTokens.access_token
      if (newTokens.refresh_token) cfg.qbo.refresh_token = newTokens.refresh_token
      saveConfig(companyId, cfg)
    }

    const since7 = new Date(Date.now() - 8 * 86400000)
    const invoices = await getPaidInvoices(accessToken, realmId, since7).catch(() => [])
    if (!invoices.length) return

    const customers = await getCustomers(accessToken, realmId).catch(() => [])
    const custMap = Object.fromEntries(customers.map(c => [c.id, c]))
    const businessName = cfg.businessName || cfg.name || ''

    for (const inv of invoices) {
      const c = custMap[inv.customerId]
      if (!c?.phone) continue
      const paidDaysAgo = Math.floor((Date.now() - new Date(inv.paidDate)) / 86400000)

      // Post-consult (3 days after paid invoice)
      if (campaigns.post_consult?.enabled && paidDaysAgo >= (parseInt(campaigns.post_consult.delay) || 3)) {
        if (!alreadySent(companyId, `qbo_${c.id}`, 'post_consult', 90)) {
          const msg = fillTemplate(campaigns.post_consult.message, { nombre: c.name, negocio: businessName, servicio: 'servicio', dias: paidDaysAgo, link_reserva: cfg.bookingUrl || '' })
          await send(cfg, c.phone, msg, companyId, `qbo_${c.id}`, 'post_consult', 'whatsapp', inv.id)
        }
      }
      // Review (7 days after paid invoice)
      if (campaigns.review?.enabled && paidDaysAgo >= (parseInt(campaigns.review.delay) || 7)) {
        if (!alreadySent(companyId, `qbo_${c.id}`, 'review', 365)) {
          const msg = fillTemplate(campaigns.review.message, { nombre: c.name, negocio: businessName, link_resena: campaigns.review.reviewLink || '', servicio: '' })
          await send(cfg, c.phone, msg, companyId, `qbo_${c.id}`, 'review', 'whatsapp', inv.id)
        }
      }
    }
  } catch(e) {
    console.error(`[qbo-campaigns] company ${companyId}:`, e.message)
  }
}
