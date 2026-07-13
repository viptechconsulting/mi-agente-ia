// services/google-calendar.js — Google Calendar OAuth + event CRUD for
// reschedule/cancel. Mirrors the OAuth pattern already used in services/qbo.js.
import { getServerSetting } from '../db.js'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const CAL_BASE = 'https://www.googleapis.com/calendar/v3'
const SCOPE = 'https://www.googleapis.com/auth/calendar.events'

function redirectUri() {
  return process.env.GOOGLE_CALLBACK_URL || 'https://chat.lynkro.io/api/google-calendar/callback'
}
function clientId()     { return process.env.GOOGLE_CLIENT_ID     || getServerSetting('google_client_id')     || '' }
function clientSecret() { return process.env.GOOGLE_CLIENT_SECRET || getServerSetting('google_client_secret') || '' }

export function hasCredentials() {
  return !!(clientId() && clientSecret())
}

export function getOAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // forces refresh_token on every consent, not just the first
    state: state ?? '',
  })
  return `${AUTH_URL}?${params}`
}

export async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(),
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
  if (!res.ok) throw new Error(`Google exchangeCode failed (${res.status}): ${await res.text()}`)
  return res.json() // { access_token, refresh_token, expires_in, ... }
}

export async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId(),
    client_secret: clientSecret(),
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
  if (!res.ok) throw new Error(`Google refreshAccessToken failed (${res.status}): ${await res.text()}`)
  return res.json() // { access_token, expires_in, ... } — no new refresh_token on refresh
}

// Returns a valid access token, refreshing (and persisting) it if it's expired
// or about to expire. cfg.googleCalendar must be { access_token, refresh_token,
// expires_at (ms epoch), calendar_id }. Caller is responsible for saving cfg
// back via saveConfig() after this mutates cfg.googleCalendar.expires_at/access_token.
export async function getValidAccessToken(cfg) {
  const gc = cfg.googleCalendar
  if (!gc?.refresh_token) throw new Error('Google Calendar no está conectado para esta empresa')
  if (gc.access_token && gc.expires_at && Date.now() < gc.expires_at - 60_000) {
    return gc.access_token
  }
  const tokens = await refreshAccessToken(gc.refresh_token)
  gc.access_token = tokens.access_token
  gc.expires_at = Date.now() + (tokens.expires_in * 1000)
  return gc.access_token
}

export async function getEvents(accessToken, calendarId, timeMinISO, timeMaxISO) {
  const params = new URLSearchParams({
    timeMin: timeMinISO, timeMax: timeMaxISO,
    singleEvents: 'true', orderBy: 'startTime', maxResults: '50'
  })
  const res = await fetch(`${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Google getEvents failed: ${data.error?.message || res.status}`)
  return data.items || []
}

// Best-effort match: Google Calendar events have no structured "customer phone"
// field, so this searches the event description for the phone's digits. Weaker
// than the Square/GHL customer-record match — only reliable if whatever process
// created the event put the phone number in the description (common for manual
// bookings and most external booking widgets that sync to Google Calendar).
export async function findEventsByPhone(accessToken, calendarId, phone) {
  const digits = String(phone).replace(/\D/g, '')
  const now = new Date()
  const in90days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
  const events = await getEvents(accessToken, calendarId, now.toISOString(), in90days.toISOString())
  return events.filter(e => (e.description || '').replace(/\D/g, '').includes(digits))
}

export async function checkFreeBusy(accessToken, calendarId, startISO, endISO) {
  const res = await fetch(`${CAL_BASE}/freeBusy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeMin: startISO, timeMax: endISO, items: [{ id: calendarId }] })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Google checkFreeBusy failed: ${data.error?.message || res.status}`)
  const busy = data.calendars?.[calendarId]?.busy || []
  return busy.length === 0
}

export async function updateEvent(accessToken, calendarId, eventId, { startISO, endISO }) {
  const res = await fetch(`${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: { dateTime: startISO }, end: { dateTime: endISO } })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Google updateEvent failed: ${data.error?.message || res.status}`)
  return data
}

export async function deleteEvent(accessToken, calendarId, eventId) {
  const res = await fetch(`${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok && res.status !== 410) throw new Error(`Google deleteEvent failed: ${res.status}`) // 410 = already gone, treat as success
  return true
}
