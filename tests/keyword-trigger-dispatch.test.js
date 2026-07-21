// tests/keyword-trigger-dispatch.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { db, saveConfig, createCompany } from '../db.js'
import { processMessage } from '../routes/chat.js'

function makeTestCompany() {
  const id = crypto.randomUUID()
  createCompany({ id, name: 'Test Co ' + id.slice(0, 8) })
  return id
}

describe('processMessage: keyword triggers', () => {
  test('activador tipo response con botón: responde exacto y devuelve el botón, sin llamar a la IA', async () => {
    const companyId = makeTestCompany()
    saveConfig(companyId, {
      keywordTriggers: [{
        keywords: ['precio'], matchType: 'contains', type: 'response',
        response: 'Nuestros planes arrancan en $99/mes.',
        button: { label: 'Ver planes', url: 'https://example.com/planes' }
      }]
    })
    const result = await processMessage({ companyId, message: 'cuál es el precio?', visitorId: 'wa:test1', channel: 'whatsapp' })
    assert.equal(result.reply, 'Nuestros planes arrancan en $99/mes.')
    assert.deepEqual(result.button, { label: 'Ver planes', url: 'https://example.com/planes' })
  })

  test('activador tipo response sin botón: button es null', async () => {
    const companyId = makeTestCompany()
    saveConfig(companyId, {
      keywordTriggers: [{ keywords: ['horario'], matchType: 'contains', type: 'response', response: 'Abrimos 9 a 6.' }]
    })
    const result = await processMessage({ companyId, message: 'cuál es su horario?', visitorId: 'wa:test2', channel: 'whatsapp' })
    assert.equal(result.reply, 'Abrimos 9 a 6.')
    assert.equal(result.button, null)
  })

  test('activador tipo flow: primer mensaje envía steps[0], el siguiente mensaje avanza a steps[1]', async () => {
    const companyId = makeTestCompany()
    saveConfig(companyId, {
      keywordTriggers: [{
        keywords: ['demo'], matchType: 'word', type: 'flow',
        steps: [{ message: 'Paso 1: contame de tu negocio' }, { message: 'Paso 2: ¿cuántos empleados tenés?' }]
      }]
    })
    const first = await processMessage({ companyId, message: 'quiero una demo', visitorId: 'wa:test3', channel: 'whatsapp' })
    assert.equal(first.reply, 'Paso 1: contame de tu negocio')
    const second = await processMessage({ companyId, conversationId: first.conversationId, message: 'tengo una peluquería', visitorId: 'wa:test3', channel: 'whatsapp' })
    assert.equal(second.reply, 'Paso 2: ¿cuántos empleados tenés?')
  })

  test('mensaje que no matchea ningún activador sigue el flujo normal hacia la IA (sin short-circuit)', async () => {
    const companyId = makeTestCompany()
    saveConfig(companyId, { keywordTriggers: [{ keywords: ['precio'], matchType: 'contains', type: 'response', response: 'x' }] })
    try {
      const result = await processMessage({ companyId, message: 'hola buenas tardes', visitorId: 'wa:test4', channel: 'whatsapp' })
      assert.equal(result.button, null)
      assert.ok(typeof result.reply === 'string')
    } catch (err) {
      // Sin una API key de Anthropic válida en este entorno, se espera que la llamada real
      // a Claude falle — pero que el error venga de la capa de Anthropic (no de un bug propio)
      // confirma que el activador NO interceptó el mensaje y sí llegó hasta la IA.
      assert.ok(err.status === 401 || /api key/i.test(err.message || ''), `error inesperado (no parece venir de Anthropic): ${err.message}`)
    }
  })
})
