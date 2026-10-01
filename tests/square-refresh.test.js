// tests/square-refresh.test.js
// El access_token de Square caduca a los 30 días. Lo que no puede romperse:
// que se renueve ANTES de caducar, que el refresh_token nuevo se persista (si
// se pierde, el negocio tiene que reconectar a mano) y que una conexión vieja
// sin refresh_token no reviente la llamada.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getValidAccessToken } from '../services/square.js'
import { loadConfig, saveConfig, createCompany, deleteCompany } from '../db.js'

const COMPANY = 'test-square-refresh'
const enDias = d => new Date(Date.now() + d * 86400000).toISOString()

const fetchReal = globalThis.fetch
let llamadas = []

function stubFetch(respuesta) {
  globalThis.fetch = async (url, opts) => {
    llamadas.push({ url: String(url), body: JSON.parse(opts.body) })
    return { ok: true, json: async () => respuesta }
  }
}

beforeEach(() => {
  llamadas = []
  try { createCompany({ id: COMPANY, name: 'Test Square Refresh' }) } catch {}
})

afterEach(() => {
  globalThis.fetch = fetchReal
  try { deleteCompany(COMPANY) } catch {}
})

test('token vigente: lo devuelve sin llamar a Square', async () => {
  saveConfig(COMPANY, { square: { access_token: 'tok-vivo', refresh_token: 'ref-1', expires_at: enDias(20) } })
  stubFetch({})
  const tok = await getValidAccessToken(COMPANY)
  assert.equal(tok, 'tok-vivo')
  assert.equal(llamadas.length, 0, 'no debe renovar un token que aún sirve')
})

test('renueva antes de caducar, no después', async () => {
  // Dentro del margen de 1 día: hay que renovar YA, no esperar al 401.
  saveConfig(COMPANY, { square: { access_token: 'tok-viejo', refresh_token: 'ref-1', expires_at: enDias(0.5) } })
  stubFetch({ access_token: 'tok-nuevo', refresh_token: 'ref-2', expires_at: enDias(30) })

  const tok = await getValidAccessToken(COMPANY)
  assert.equal(tok, 'tok-nuevo')
  assert.equal(llamadas[0].body.grant_type, 'refresh_token')
  assert.equal(llamadas[0].body.refresh_token, 'ref-1')
})

test('persiste el refresh_token nuevo (si se pierde, hay que reconectar a mano)', async () => {
  saveConfig(COMPANY, { square: { access_token: 'tok-viejo', refresh_token: 'ref-1', expires_at: enDias(-1) } })
  stubFetch({ access_token: 'tok-nuevo', refresh_token: 'ref-2', expires_at: enDias(30) })

  await getValidAccessToken(COMPANY)

  const guardado = loadConfig(COMPANY).square
  assert.equal(guardado.access_token, 'tok-nuevo')
  assert.equal(guardado.refresh_token, 'ref-2', 'el refresh_token rotado tiene que quedar guardado')
  assert.ok(guardado.refreshed_at, 'debe registrar cuándo se renovó')
})

test('si Square no manda refresh_token nuevo, conserva el que había', async () => {
  saveConfig(COMPANY, { square: { access_token: 'tok-viejo', refresh_token: 'ref-1', expires_at: enDias(-1) } })
  stubFetch({ access_token: 'tok-nuevo', expires_at: enDias(30) })

  await getValidAccessToken(COMPANY)
  assert.equal(loadConfig(COMPANY).square.refresh_token, 'ref-1', 'no puede quedarse sin refresh_token')
})

test('conexión vieja sin refresh_token: devuelve lo que hay en vez de reventar', async () => {
  // BeGlam y Glow MedSpa están así desde el 8-jul-2026. Que el 401 de Square
  // lo diga, no una excepción aquí que tumbe toda la respuesta del agente.
  saveConfig(COMPANY, { square: { access_token: 'tok-caducado', expires_at: enDias(-40) } })
  stubFetch({})
  const tok = await getValidAccessToken(COMPANY)
  assert.equal(tok, 'tok-caducado')
  assert.equal(llamadas.length, 0)
})

test('sin conexión de Square: falla claro', async () => {
  saveConfig(COMPANY, { square: null })
  await assert.rejects(() => getValidAccessToken(COMPANY), /no está conectado/)
})
