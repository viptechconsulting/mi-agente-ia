// services/appointments.js — provider-agnostic appointment policy shared by
// the reschedule/cancel tool handlers in routes/chat.js

export function canModifyAppointment({ startTimeISO, nowISO, minNoticeHours = 4 }) {
  const start = new Date(startTimeISO).getTime()
  const now = new Date(nowISO || Date.now()).getTime()
  const hoursUntil = (start - now) / (1000 * 60 * 60)
  return { allowed: hoursUntil >= minNoticeHours, hoursUntil: Math.round(hoursUntil * 100) / 100 }
}
