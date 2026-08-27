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

describe('verifyTwilioSignature — inbound webhook auth', () => {
  // Vector from Twilio's own docs for the signing algorithm.
  const TOKEN = '12345'
  const URL = 'https://mycompany.com/myapp.php?foo=1&bar=2'
  const PARAMS = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675309', Digits: '1234', From: '+14158675309', To: '+18005551212' }

  const sign = async (token, url, params) => {
    const { buildSignatureBase } = await import('../services/twilio.js')
    const { createHmac } = await import('node:crypto')
    return createHmac('sha1', token).update(Buffer.from(buildSignatureBase(url, params), 'utf8')).digest('base64')
  }

  test('buildSignatureBase appends params sorted by key, not by insertion order', async () => {
    const { buildSignatureBase } = await import('../services/twilio.js')
    const shuffled = { To: 'b', CallSid: 'a', From: 'c' }
    assert.equal(buildSignatureBase('https://x/y', shuffled), 'https://x/yCallSidaFromcTob')
  })

  test('accepts a correctly signed request', async () => {
    const { verifyTwilioSignature } = await import('../services/twilio.js')
    assert.equal(verifyTwilioSignature(TOKEN, URL, PARAMS, await sign(TOKEN, URL, PARAMS)), true)
  })

  test('rejects a tampered body — the whole point of signing', async () => {
    const { verifyTwilioSignature } = await import('../services/twilio.js')
    const sig = await sign(TOKEN, URL, PARAMS)
    assert.equal(verifyTwilioSignature(TOKEN, URL, { ...PARAMS, Digits: '9999' }, sig), false)
  })

  test('rejects a signature made with a different auth token', async () => {
    const { verifyTwilioSignature } = await import('../services/twilio.js')
    assert.equal(verifyTwilioSignature(TOKEN, URL, PARAMS, await sign('otro-token', URL, PARAMS)), false)
  })

  test('rejects when the URL differs (replay against another route)', async () => {
    const { verifyTwilioSignature } = await import('../services/twilio.js')
    const sig = await sign(TOKEN, URL, PARAMS)
    assert.equal(verifyTwilioSignature(TOKEN, 'https://mycompany.com/otra', PARAMS, sig), false)
  })

  test('fails closed on missing token or signature', async () => {
    const { verifyTwilioSignature } = await import('../services/twilio.js')
    const sig = await sign(TOKEN, URL, PARAMS)
    assert.equal(verifyTwilioSignature('', URL, PARAMS, sig), false)
    assert.equal(verifyTwilioSignature(TOKEN, URL, PARAMS, ''), false)
    assert.equal(verifyTwilioSignature(TOKEN, URL, PARAMS, undefined), false)
  })

  test('rejects a signature of the wrong length without throwing', async () => {
    const { verifyTwilioSignature } = await import('../services/twilio.js')
    assert.equal(verifyTwilioSignature(TOKEN, URL, PARAMS, 'corta'), false)
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
