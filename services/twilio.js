// services/twilio.js — Twilio REST API wrapper for outbound SMS.
// No SDK dependency — Twilio's Messages API is a single POST endpoint.
const API_BASE = 'https://api.twilio.com/2010-04-01'

export function authHeader(accountSid, authToken) {
  return 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64')
}

export function buildMessageBody(fromNumber, toPhone, text) {
  return new URLSearchParams({ From: fromNumber, To: toPhone, Body: text })
}

export function formatTwilioError(fnName, status, data) {
  return `Twilio ${fnName} failed: ${data?.message || status}`
}

// Lead phones are stored in whatever shape the channel captured them: WhatsApp
// gives full country code, a web form may give "(786) 555-1234", and @lid
// conversations store a WhatsApp pseudo-ID that is not a phone at all.
// Returns null when the value can't be a real number so the caller can refuse
// before burning a Twilio request.
// ponytail: bare 10 digits assume +1 (US/CA) — change DEFAULT_CC if the
// customer base moves off North America.
const DEFAULT_CC = '1'
export function toE164(phone = '') {
  const raw = String(phone).trim()
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null
  if (raw.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null
  if (digits.length === 10) return `+${DEFAULT_CC}${digits}`
  if (digits.length < 8 || digits.length > 15) return null
  return `+${digits}`
}

// The numbers actually bought in this Twilio account, so the admin picks a
// valid From instead of typing one that Twilio will reject at send time.
export async function listNumbers(accountSid, authToken) {
  const res = await fetch(`${API_BASE}/Accounts/${accountSid}/IncomingPhoneNumbers.json?PageSize=100`, {
    headers: { Authorization: authHeader(accountSid, authToken) }
  })
  const data = await res.json()
  if (!res.ok) throw new Error(formatTwilioError('listNumbers', res.status, data))
  return (data.incoming_phone_numbers || []).map(n => ({
    phoneNumber: n.phone_number,
    friendlyName: n.friendly_name || n.phone_number,
    sms: !!n.capabilities?.sms
  }))
}

export async function getAccountInfo(accountSid, authToken) {
  const res = await fetch(`${API_BASE}/Accounts/${accountSid}.json`, {
    headers: { Authorization: authHeader(accountSid, authToken) }
  })
  const data = await res.json()
  if (!res.ok) throw new Error(formatTwilioError('getAccountInfo', res.status, data))
  return data
}

export async function sendSMS(accountSid, authToken, fromNumber, toPhone, text) {
  const res = await fetch(`${API_BASE}/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(accountSid, authToken),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: buildMessageBody(fromNumber, toPhone, text).toString()
  })
  const data = await res.json()
  if (!res.ok) throw new Error(formatTwilioError('sendSMS', res.status, data))
  return data
}
