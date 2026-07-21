import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { matchKeywordTrigger } from '../services/keyword-trigger.js'

function cfgWith(triggers) { return { keywordTriggers: triggers } }

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
