import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

describe('twilio service — pure helpers', () => {
  test('authHeader base64-encodes accountSid:authToken as Basic auth', async () => {
    const { authHeader } = await import('../services/twilio.js')
    const header = authHeader('ACxxxx', 'secrettoken')
    assert.ok(header.startsWith('Basic '))
    const decoded = Buffer.from(header.slice(6), 'base64').toString()
    assert.equal(decoded, 'ACxxxx:secrettoken')
  })

  test('buildMessageBody produces correct form-encoded fields', async () => {
    const { buildMessageBody } = await import('../services/twilio.js')
    const body = buildMessageBody('+15550001111', '+15550002222', 'Tu cita es mañana a las 3pm')
    assert.equal(body.get('From'), '+15550001111')
    assert.equal(body.get('To'), '+15550002222')
    assert.equal(body.get('Body'), 'Tu cita es mañana a las 3pm')
  })

  test('formatTwilioError prefers the API message over the status code', async () => {
    const { formatTwilioError } = await import('../services/twilio.js')
    const msg = formatTwilioError('sendSMS', 400, { message: 'Invalid To phone number' })
    assert.equal(msg, 'Twilio sendSMS failed: Invalid To phone number')
  })

  test('formatTwilioError falls back to the status code when no message', async () => {
    const { formatTwilioError } = await import('../services/twilio.js')
    const msg = formatTwilioError('getAccountInfo', 401, {})
    assert.equal(msg, 'Twilio getAccountInfo failed: 401')
  })
})

describe('toE164 — lead phone normalization', () => {
  test('keeps an already-E.164 number and strips formatting', async () => {
    const { toE164 } = await import('../services/twilio.js')
    assert.equal(toE164('+1 (786) 555-1234'), '+17865551234')
    assert.equal(toE164('+54 9 11 2345-6789'), '+5491123456789')
  })

  test('assumes +1 for a bare 10-digit US number', async () => {
    const { toE164 } = await import('../services/twilio.js')
    assert.equal(toE164('(786) 555-1234'), '+17865551234')
    assert.equal(toE164('7865551234'), '+17865551234')
  })

  test('prefixes + for a bare number that already carries a country code', async () => {
    const { toE164 } = await import('../services/twilio.js')
    assert.equal(toE164('17865551234'), '+17865551234')
    assert.equal(toE164('5491123456789'), '+5491123456789')
  })

  test('rejects values that cannot be a phone number', async () => {
    const { toE164 } = await import('../services/twilio.js')
    assert.equal(toE164(''), null)
    assert.equal(toE164(null), null)
    assert.equal(toE164('1234567'), null)             // too short
    assert.equal(toE164('1234567890123456'), null)    // too long — WhatsApp @lid pseudo-id
    assert.equal(toE164('sin telefono'), null)
    assert.equal(toE164('+123'), null)                // explicit + but not a real number
  })
})
