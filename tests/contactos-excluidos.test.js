// tests/contactos-excluidos.test.js
// La IA no debe contestarle a familia, amigos ni proveedores. Lo que no puede
// romperse: que el mismo contacto se reconozca escrito de cualquier forma
// (+1 786…, 1786…, 786…), que un LID no se confunda con un teléfono, y que la
// lista vacía no excluya a nadie — eso dejaría muda toda la cuenta.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { claveContacto, estaExcluido, agregarExcluido, listaExcluidos } from '../routes/chat.js'

describe('claveContacto: normaliza cualquier forma del mismo contacto', () => {
  test('el mismo número escrito de seis formas da la misma clave', () => {
    const esperada = claveContacto('+1 786 383 0513')
    assert.ok(esperada)
    for (const v of ['+17863830513', '17863830513', '7863830513', '786-383-0513', 'wa:17863830513', '17863830513@s.whatsapp.net']) {
      assert.equal(claveContacto(v), esperada, `${v} debería ser el mismo contacto`)
    }
  })

  test('quita el sufijo de dispositivo', () => {
    assert.equal(claveContacto('17863830513:12@s.whatsapp.net'), claveContacto('+17863830513'))
  })

  test('un LID se compara entero, no como teléfono', () => {
    // Recortarle "los últimos 10 dígitos" a un LID inventa un número que podría
    // chocar con el de otra persona.
    const lid = claveContacto('wa:101112254337143@lid')
    assert.equal(lid, '101112254337143@lid')
    assert.notEqual(lid, claveContacto('2254337143'))
  })

  test('vacío y basura no producen clave', () => {
    for (const v of ['', '   ', null, undefined]) assert.equal(claveContacto(v), null)
  })
})

describe('estaExcluido', () => {
  const cfg = { excludedNumbers: ['+1 786 383 0513', '584147750745'] }

  test('excluye aunque el número llegue en otro formato', () => {
    assert.equal(estaExcluido(cfg, 'wa:17863830513'), true)
    assert.equal(estaExcluido(cfg, 'wa:584147750745@s.whatsapp.net'), true)
  })

  test('no excluye a quien no está en la lista', () => {
    assert.equal(estaExcluido(cfg, 'wa:19542602747'), false)
  })

  test('con LID usa el lead_phone, que es donde está el número', () => {
    // El visitorId no lleva el número; sin este camino la lista no serviría de
    // nada en las cuentas que ya migraron a LID.
    assert.equal(estaExcluido(cfg, 'wa:101112254337143@lid', '+17863830513'), true)
    assert.equal(estaExcluido(cfg, 'wa:101112254337143@lid', '+19542602747'), false)
  })

  test('lista vacía no excluye a NADIE', () => {
    for (const vacia of [{}, { excludedNumbers: [] }, { excludedNumbers: '' }, { excludedNumbers: null }]) {
      assert.equal(estaExcluido(vacia, 'wa:17863830513'), false, JSON.stringify(vacia))
    }
  })

  test('acepta la lista como texto, no solo como array', () => {
    assert.equal(estaExcluido({ excludedNumbers: '+17863830513\n584147750745' }, 'wa:17863830513'), true)
  })

  test('una entrada basura en la lista no excluye a todo el mundo', () => {
    assert.equal(estaExcluido({ excludedNumbers: ['', '   ', 'abc'] }, 'wa:17863830513'), false)
  })
})

describe('agregarExcluido (lo que hace el comando "me")', () => {
  test('agrega y conserva lo que ya había', () => {
    const { cfg, yaEstaba } = agregarExcluido({ excludedNumbers: ['584147750745'] }, '+17863830513')
    assert.equal(yaEstaba, false)
    assert.deepEqual(cfg.excludedNumbers, ['584147750745', '+17863830513'])
    assert.equal(estaExcluido(cfg, 'wa:17863830513'), true)
  })

  test('no duplica aunque venga en otro formato', () => {
    const { cfg, yaEstaba } = agregarExcluido({ excludedNumbers: ['+1 786 383 0513'] }, '17863830513')
    assert.equal(yaEstaba, true)
    assert.equal(cfg.excludedNumbers.length, 1)
  })

  test('sobre una config sin lista previa', () => {
    const { cfg } = agregarExcluido({}, '+17863830513')
    assert.deepEqual(cfg.excludedNumbers, ['+17863830513'])
  })

  test('un LID también se puede excluir', () => {
    const { cfg, clave } = agregarExcluido({}, 'wa:101112254337143@lid')
    assert.equal(clave, '101112254337143@lid')
    assert.equal(estaExcluido(cfg, 'wa:101112254337143@lid'), true)
  })

  test('un identificador inservible no ensucia la lista', () => {
    const { clave, cfg } = agregarExcluido({ excludedNumbers: ['584147750745'] }, '')
    assert.equal(clave, null)
    assert.deepEqual(cfg.excludedNumbers, ['584147750745'])
  })
})

test('listaExcluidos ignora las filas vacías', () => {
  assert.deepEqual(listaExcluidos({ excludedNumbers: '+17863830513\n\n  \n584147750745' }).length, 2)
})
