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
  // Antes el shell nacía con human_mode=1. Como la reactivación automática se
  // quitó a propósito, escribir primero desde el teléfono del negocio dejaba al
  // agente mudo en ese chat PARA SIEMPRE, sin que nadie lo pidiera. En los
  // números que además se usan a mano eso apagaba media cuenta.
  test('crea shell con la IA ACTIVA y guarda el saliente como assistant', () => {
    const vid = 'wa:' + crypto.randomUUID().slice(0, 10)
    const id = recordOutboundMessage(COMPANY, 'whatsapp', vid, '¿En qué ciudad estás?')
    assert.ok(id)
    const conv = db.prepare('SELECT human_mode FROM conversations WHERE id = ?').get(id)
    assert.equal(conv.human_mode, 0, 'si es 1 el agente nunca responde en ese chat')
    assert.deepEqual(msgs(id), [{ role: 'assistant', content: '¿En qué ciudad estás?' }])
  })

  test('una pausa puesta a propósito se respeta: el saliente no la levanta', () => {
    const vid = 'wa:' + crypto.randomUUID().slice(0, 10)
    const id = recordOutboundMessage(COMPANY, 'whatsapp', vid, 'Primero')
    db.prepare('UPDATE conversations SET human_mode = 1 WHERE id = ?').run(id) // como el comando `*`
    const id2 = recordOutboundMessage(COMPANY, 'whatsapp', vid, 'Segundo')
    assert.equal(id2, id, 'misma conversación')
    assert.equal(db.prepare('SELECT human_mode FROM conversations WHERE id = ?').get(id).human_mode, 1)
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
