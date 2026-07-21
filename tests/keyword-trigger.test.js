import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { db } from '../db.js'
import {
  matchKeywordTrigger, getActiveTriggerFlow, startTriggerFlow, advanceTriggerFlow, clearTriggerFlow
} from '../services/keyword-trigger.js'

function cfgWith(triggers) { return { keywordTriggers: triggers } }

function makeConversation() {
  const id = crypto.randomUUID()
  const now = Date.now()
  db.prepare('INSERT INTO conversations (id, visitor_id, channel, created_at, updated_at, company_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'test-visitor', 'web', now, now, 'test-company')
  return id
}

describe('matchKeywordTrigger', () => {
  test('matchType contains: coincide si la palabra aparece en cualquier parte', () => {
    const cfg = cfgWith([{ keywords: ['precio'], matchType: 'contains', type: 'response', response: 'Info de precios' }])
    const result = matchKeywordTrigger(cfg, 'hola, cuál es el precio del servicio?')
    assert.equal(result.index, 0)
    assert.equal(result.trigger.response, 'Info de precios')
  })

  test('matchType word: NO coincide si la palabra clave es substring de otra palabra', () => {
    const cfg = cfgWith([{ keywords: ['demo'], matchType: 'word', type: 'response', response: 'x' }])
    assert.equal(matchKeywordTrigger(cfg, 'esto es una democracia'), null)
  })

  test('matchType word: SÍ coincide si es palabra completa', () => {
    const cfg = cfgWith([{ keywords: ['demo'], matchType: 'word', type: 'response', response: 'x' }])
    assert.ok(matchKeywordTrigger(cfg, 'quiero ver una demo'))
  })

  test('matchType exact: solo coincide si el mensaje completo es la palabra clave', () => {
    const cfg = cfgWith([{ keywords: ['SI'], matchType: 'exact', type: 'response', response: 'x' }])
    assert.ok(matchKeywordTrigger(cfg, '  si  '))
    assert.equal(matchKeywordTrigger(cfg, 'si quiero'), null)
  })

  test('caseSensitive: distingue mayúsculas cuando está activado', () => {
    const cfg = cfgWith([{ keywords: ['DEMO'], matchType: 'contains', caseSensitive: true, type: 'response', response: 'x' }])
    assert.equal(matchKeywordTrigger(cfg, 'quiero una demo'), null)
    assert.ok(matchKeywordTrigger(cfg, 'quiero una DEMO'))
  })

  test('sin match, retorna null', () => {
    const cfg = cfgWith([{ keywords: ['precio'], matchType: 'contains', type: 'response', response: 'x' }])
    assert.equal(matchKeywordTrigger(cfg, 'hola buenas'), null)
  })

  test('sin keywordTriggers configurados, retorna null sin lanzar error', () => {
    assert.equal(matchKeywordTrigger({}, 'cualquier cosa'), null)
  })

  test('retorna el índice del trigger que matchea entre varios', () => {
    const cfg = cfgWith([
      { keywords: ['info'], matchType: 'contains', type: 'response', response: 'a' },
      { keywords: ['precio'], matchType: 'contains', type: 'response', response: 'b' }
    ])
    const result = matchKeywordTrigger(cfg, 'cuál es el precio')
    assert.equal(result.index, 1)
    assert.equal(result.trigger.response, 'b')
  })
})

describe('keyword trigger flow state', () => {
  test('sin flujo activo, getActiveTriggerFlow retorna null', () => {
    const convId = makeConversation()
    assert.equal(getActiveTriggerFlow(convId), null)
  })

  test('startTriggerFlow guarda triggerIndex y arranca en step 1', () => {
    const convId = makeConversation()
    startTriggerFlow(convId, 2)
    assert.deepEqual(getActiveTriggerFlow(convId), { triggerIndex: 2, step: 1 })
  })

  test('advanceTriggerFlow avanza el step sin tocar triggerIndex', () => {
    const convId = makeConversation()
    startTriggerFlow(convId, 0)
    advanceTriggerFlow(convId, 2)
    assert.deepEqual(getActiveTriggerFlow(convId), { triggerIndex: 0, step: 2 })
  })

  test('clearTriggerFlow borra el estado', () => {
    const convId = makeConversation()
    startTriggerFlow(convId, 0)
    clearTriggerFlow(convId)
    assert.equal(getActiveTriggerFlow(convId), null)
  })

  test('convive con flow_state usado por otra feature sin pisarlo (namespace leadQuali)', () => {
    const convId = makeConversation()
    db.prepare('UPDATE conversations SET flow_state = ? WHERE id = ?').run(JSON.stringify({ leadQuali: { current_state: 'OPENING' } }), convId)
    startTriggerFlow(convId, 0)
    const row = db.prepare('SELECT flow_state FROM conversations WHERE id = ?').get(convId)
    const blob = JSON.parse(row.flow_state)
    assert.deepEqual(blob.leadQuali, { current_state: 'OPENING' })
    assert.deepEqual(blob.keywordTrigger, { triggerIndex: 0, step: 1 })
  })
})
