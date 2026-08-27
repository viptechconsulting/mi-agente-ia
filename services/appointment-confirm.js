// services/appointment-confirm.js — confirmación de citas en 2 pasos y
// registro de asistencia. La fuente de verdad de la asistencia es el panel
// (alguien marca Asistió / No vino), no el calendario externo: Square y GHL
// solo dicen que la cita existe, no si la persona apareció.
import { db } from '../db.js'

// ── Clasificación de la respuesta ────────────────────────────────
// Nunca adivina. Ante la mínima duda devuelve 'unclear' y el mensaje sigue su
// camino normal al agente, que sabe reagendar y cancelar. Marcar mal una cita
// como confirmada es peor que no marcarla: el hueco no se recupera.
// El fin de palabra va con \p{L} y no con \b: \b se apoya en [A-Za-z0-9_], así
// que "sí" y "ahí estaré" quedaban afuera porque í y é no son ASCII.
const AFIRMATIVO = /^(s[ií]|sip|sii+|claro|ok(ey|ay)?|dale|listo|perfecto|confirmo|confirmad[oa]|ah[ií]\s+estar[eé]|all[ií]\s+estar[eé]|nos\s+vemos|yes|yep|yeah|sure|1)(?![\p{L}\p{N}])/iu
const NEGATIVO = /(cancel(ar|o|a|e|en)?|reagend|reprogram|posponer|mover\s+(la\s+)?cita|cambiar\s+(la\s+)?(cita|hora|fecha)|otro\s+d[ií]a|no\s+(voy|puedo|podr[eé]|alcanzo|llego|me\s+queda)|reschedul|can'?t\s+make|won'?t\s+make)/i
// "no" a secas es una cancelación; "no sé si pueda" no lo es — ahí todavía hay
// margen para insistir con el segundo aviso, así que debe quedar pendiente.
const NEGATIVO_SOLO = /^(no|nope|negativo)\s*[.!]*$/i

// Un texto largo casi nunca es una confirmación limpia: es una pregunta, una
// excusa con matices o dos cosas a la vez. Eso lo resuelve mejor el agente.
const MAX_LEN = 80

export function classifyConfirmation(text = '') {
  const t = String(text).trim()
  if (!t) return 'unclear'
  // Cancelar/reagendar se detecta a cualquier largo: es la señal más valiosa,
  // porque libera el cupo.
  if (NEGATIVO.test(t)) return 'declined'
  if (t.length > MAX_LEN) return 'unclear'
  if (NEGATIVO_SOLO.test(t)) return 'declined'
  if (AFIRMATIVO.test(t)) return 'confirmed'
  return 'unclear'
}

// ── Estado por cita ──────────────────────────────────────────────
export function upsertAppointment({ companyId, appointmentId, contactId, contactName, phone, startTime }) {
  db.prepare(`
    INSERT INTO appointment_status (company_id, appointment_id, contact_id, contact_name, phone, start_time, first_sent_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(company_id, appointment_id) DO UPDATE SET
      contact_id = excluded.contact_id,
      contact_name = excluded.contact_name,
      phone = excluded.phone,
      start_time = excluded.start_time
  `).run(companyId, appointmentId, contactId || null, contactName || null, phone || null, startTime || null)
}

// El teléfono se guarda ya normalizado a dígitos para que el cruce con el
// mensaje entrante no dependa del formato que trajo cada canal.
export function findPendingByPhone(companyId, phone) {
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits.length < 8) return null
  const tail = digits.slice(-10)
  return db.prepare(`
    SELECT * FROM appointment_status
    WHERE company_id = ? AND confirm_state = 'pending'
      AND start_time > datetime('now')
      AND phone IS NOT NULL AND replace(replace(replace(replace(phone,'+',''),'-',''),' ',''),'(','') LIKE ?
    ORDER BY start_time ASC LIMIT 1
  `).get(companyId, `%${tail}`)
}

export function setConfirmState(companyId, appointmentId, state) {
  db.prepare(`
    UPDATE appointment_status SET confirm_state = ?, confirmed_at = datetime('now')
    WHERE company_id = ? AND appointment_id = ?
  `).run(state, companyId, appointmentId)
}

// Citas que ya recibieron el primer aviso, siguen sin respuesta, todavía no
// pasaron, y llevan al menos `hours` esperando. Ese es el segundo intento.
export function pendingSecondTouch(companyId, hours = 6) {
  return db.prepare(`
    SELECT * FROM appointment_status
    WHERE company_id = ? AND confirm_state = 'pending'
      AND second_sent_at IS NULL
      AND first_sent_at <= datetime('now', ?)
      AND start_time > datetime('now')
    ORDER BY start_time ASC
  `).all(companyId, `-${hours} hours`)
}

export function markSecondSent(companyId, appointmentId) {
  db.prepare(`
    UPDATE appointment_status SET second_sent_at = datetime('now')
    WHERE company_id = ? AND appointment_id = ?
  `).run(companyId, appointmentId)
}

// ── Asistencia y métrica ─────────────────────────────────────────
export function markAttendance(companyId, appointmentId, attendance) {
  if (!['showed', 'noshow'].includes(attendance)) throw new Error('Asistencia inválida')
  const r = db.prepare(`
    UPDATE appointment_status SET attendance = ?, attendance_at = datetime('now')
    WHERE company_id = ? AND appointment_id = ?
  `).run(attendance, companyId, appointmentId)
  return r.changes > 0
}

export function listForAttendance(companyId, days = 7) {
  return db.prepare(`
    SELECT * FROM appointment_status
    WHERE company_id = ? AND start_time <= datetime('now')
      AND start_time >= datetime('now', ?)
    ORDER BY start_time DESC
  `).all(companyId, `-${days} days`)
}

// Las tasas se calculan solo sobre citas ya marcadas: contar las no marcadas
// como asistidas inflaría el resultado y volvería la métrica inútil.
export function noShowStats(companyId, days = 30) {
  const rows = db.prepare(`
    SELECT confirm_state, attendance FROM appointment_status
    WHERE company_id = ? AND start_time >= datetime('now', ?) AND start_time <= datetime('now')
  `).all(companyId, `-${days} days`)

  const total = rows.length
  const marcadas = rows.filter(r => r.attendance).length
  const noshow = rows.filter(r => r.attendance === 'noshow').length
  const showed = rows.filter(r => r.attendance === 'showed').length
  const confirmadas = rows.filter(r => r.confirm_state === 'confirmed').length

  // Cruce que justifica la feature: ¿asisten más los que confirmaron?
  const conf = rows.filter(r => r.confirm_state === 'confirmed' && r.attendance)
  const sinConf = rows.filter(r => r.confirm_state !== 'confirmed' && r.attendance)
  const rate = (arr) => arr.length ? Math.round(arr.filter(r => r.attendance === 'noshow').length / arr.length * 100) : null

  return {
    total, marcadas, sinMarcar: total - marcadas, showed, noshow, confirmadas,
    noShowRate: marcadas ? Math.round(noshow / marcadas * 100) : null,
    confirmRate: total ? Math.round(confirmadas / total * 100) : null,
    noShowRateConfirmados: rate(conf),
    noShowRateSinConfirmar: rate(sinConf)
  }
}
