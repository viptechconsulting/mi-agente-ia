import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildOpenerMessage, buildFollowupMessage } from '../services/prospecting-outreach.js'

describe('buildOpenerMessage', () => {
  test('saluda con el nombre completo del negocio, no con la primera palabra', () => {
    const prospect = { name: 'Taller El Rayo' }
    const text = buildOpenerMessage(prospect, ['problema 1', 'problema 2', 'problema 3'], { senderName: 'Diego', videoUrl: 'https://x.com' })
    assert.ok(text.startsWith('Hola Taller El Rayo 👋'))
    assert.ok(!text.startsWith('Hola Taller 👋'))
  })

  test('usa problemas por defecto si no hay auditoría', () => {
    const text = buildOpenerMessage({ name: 'Negocio X' }, [])
    assert.match(text, /su página no abre bien en celular/)
  })
})

describe('buildFollowupMessage', () => {
  test('día 2 y día 7 saludan con el nombre completo del negocio', () => {
    const prospect = { name: 'Mecánica Hernández' }
    assert.ok(buildFollowupMessage(prospect, 2).startsWith('Mecánica Hernández,'))
    assert.ok(buildFollowupMessage(prospect, 7).startsWith('Mecánica Hernández,'))
  })

  test('día inválido lanza error', () => {
    assert.throws(() => buildFollowupMessage({ name: 'X' }, 3))
  })
})
