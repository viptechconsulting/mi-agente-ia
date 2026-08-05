import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { splitVideoMessage } from '../services/wa-media.js'

describe('splitVideoMessage (WhatsApp inline video)', () => {
  test('splits the real presentation message into video + caption', () => {
    const text = '¡Hola! Claro, te dejo una presentación rápida para que veas de qué va 👇 https://chat.lynkro.io/lynkro-presentacion.mp4 — y cuéntame, ¿a qué se dedica tu negocio?'
    const r = splitVideoMessage(text)
    assert.equal(r.mediaUrl, 'https://chat.lynkro.io/lynkro-presentacion.mp4')
    assert.ok(!r.caption.includes('.mp4'))
    assert.ok(r.caption.includes('¿a qué se dedica tu negocio?'))
    assert.ok(!/ {2,}/.test(r.caption), 'no double spaces after stripping the URL')
  })
  test('handles a query string on the URL', () => {
    const r = splitVideoMessage('mira esto https://x.com/a.webm?v=2 ok')
    assert.equal(r.mediaUrl, 'https://x.com/a.webm?v=2')
  })
  test('returns null when there is no video URL', () => {
    assert.equal(splitVideoMessage('hola, ¿a qué te dedicás?'), null)
    assert.equal(splitVideoMessage('agenda acá https://calendly.com/lynkro/15min'), null)
    assert.equal(splitVideoMessage(''), null)
  })
})
