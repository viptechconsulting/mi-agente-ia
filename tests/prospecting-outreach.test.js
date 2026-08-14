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

  test('lang=en genera el opener en inglés', () => {
    const text = buildOpenerMessage({ name: 'Rayo Auto Shop' }, ['issue 1', 'issue 2', 'issue 3'], { senderName: 'Diego', lang: 'en' })
    assert.ok(text.startsWith('Hi Rayo Auto Shop 👋'))
    assert.match(text, /for FREE/)
    assert.doesNotMatch(text, /GRATIS/)
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

  test('lang=en genera los seguimientos en inglés', () => {
    assert.match(buildFollowupMessage({ name: 'Hernandez Mechanics' }, 2, 'en'), /watch the video/)
    assert.match(buildFollowupMessage({ name: 'Hernandez Mechanics' }, 7, 'en'), /last time I'll reach out/)
  })
})
