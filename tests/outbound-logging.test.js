// tests/outbound-logging.test.js
// Bug #3: los webhooks descartaban todo mensaje SALIENTE del negocio/humano
// (WhatsApp fromMe / IG echo) → el historial quedaba de un solo lado ("a ciegas").
// recordOutboundMessage lo registra como 'assistant', con dedupe del eco del bot.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { db } from '../db.js'
import { recordOutboundMessage } from '../routes/chat.js'

const COMPANY = 'test-outbound-co'
const msgs = id => db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id").all(id)

describe('recordOutboundMessage: registra el saliente del negocio', () => {
  test('crea shell (human_mode=1) y guarda el saliente como assistant', () => {
    const vid = 'wa:' + crypto.randomUUID().slice(0, 10)
    const id = recordOutboundMessage(COMPANY, 'whatsapp', vid, '¿En qué ciudad estás?')
    assert.ok(id)
    const conv = db.prepare('SELECT human_mode FROM conversations WHERE id = ?').get(id)
    assert.equal(conv.human_mode, 1)
    assert.deepEqual(msgs(id), [{ role: 'assistant', content: '¿En qué ciudad estás?' }])
  })

  test('reusa la conversación existente y NO duplica el eco idéntico del bot', () => {
    const vid = 'ig:' + crypto.randomUUID().slice(0, 10)
    const id1 = recordOutboundMessage(COMPANY, 'instagram', vid, 'Hola, gracias por escribir')
    const id2 = recordOutboundMessage(COMPANY, 'instagram', vid, 'Hola, gracias por escribir') // eco idéntico
    assert.equal(id1, id2, 'misma conversación')
    assert.equal(msgs(id1).length, 1, 'el eco idéntico no debe duplicarse')
  })

  test('dos salientes distintos sí quedan ambos', () => {
    const vid = 'wa:' + crypto.randomUUID().slice(0, 10)
    const id = recordOutboundMessage(COMPANY, 'whatsapp', vid, 'Primero')
    recordOutboundMessage(COMPANY, 'whatsapp', vid, 'Segundo')
    assert.deepEqual(msgs(id).map(m => m.content), ['Primero', 'Segundo'])
  })

  test('texto vacío se ignora (no crea conversación ni mensaje)', () => {
    assert.equal(recordOutboundMessage(COMPANY, 'whatsapp', 'wa:empty', '   '), null)
  })
})
