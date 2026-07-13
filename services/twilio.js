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
