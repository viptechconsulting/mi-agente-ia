// tests/qr-imagen.test.js
// Un cliente vio esto en pantalla al intentar escanear:
//   "skIExsEJPgn3yM=,HslxPDSpk9G3793nWFCYbz..."
// No es un error: es el contenido que va DENTRO del QR, la cadena de
// emparejamiento que Evolution manda en `code`. Lo que no puede romperse es que
// algo así vuelva a salir hacia un <img>: de aquí sale una imagen o sale null.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { qrComoImagen } from '../routes/chat.js'

// La cadena real que reportó el cliente.
const CADENA_CRUDA = 'skIExsEJPgn3yM=,HslxPDSpk9G3793nWFCYbzMkhcuDbss+7wKROTw29Sc=,66nBDXL8I048fGS+d84nr7I90uhyozQP0XH6CxFyNxI=,s5QscsLpqCo7Qika14GnYVHnbILz3CAYF3hvjGJ6kcQ='

describe('qrComoImagen', () => {
  test('un data URL ya listo pasa tal cual', async () => {
    const url = 'data:image/png;base64,iVBORw0KGgo='
    assert.equal(await qrComoImagen({ base64: url }), url)
  })

  test('PNG en base64 sin prefijo: se le pone el prefijo', async () => {
    const pelado = 'iVBORw0KGgo' + 'A'.repeat(200)
    assert.equal(await qrComoImagen({ base64: pelado }), 'data:image/png;base64,' + pelado)
  })

  test('solo `code`: dibujamos el QR nosotros', async () => {
    const out = await qrComoImagen({ code: CADENA_CRUDA })
    assert.ok(out?.startsWith('data:image/png;base64,'), 'debe ser una imagen PNG')
    assert.ok(out.length > 500, 'y una imagen de verdad, no un sello vacío')
  })

  test('la cadena cruda NUNCA sale como texto', async () => {
    for (const resp of [{ code: CADENA_CRUDA }, { base64: CADENA_CRUDA }, { qrcode: { code: CADENA_CRUDA } }]) {
      const out = await qrComoImagen(resp)
      assert.ok(!out || out.startsWith('data:image'), 'solo imagen o null')
      assert.ok(!out || !out.includes(','.repeat(1)) || out.startsWith('data:image'), 'nunca el texto pelado')
      if (out) assert.ok(!out.includes('HslxPDSpk9G3793nWFCYbz'), 'la cadena no puede viajar como src')
    }
  })

  test('base64 y code a la vez: gana la imagen que ya viene hecha', async () => {
    const url = 'data:image/png;base64,iVBORw0KGgo='
    assert.equal(await qrComoImagen({ base64: url, code: CADENA_CRUDA }), url)
  })

  test('anidado en qrcode.base64, como lo manda otra versión', async () => {
    const url = 'data:image/png;base64,iVBORw0KGgo='
    assert.equal(await qrComoImagen({ qrcode: { base64: url } }), url)
  })

  test('sin nada útil devuelve null, no un string raro', async () => {
    for (const resp of [{}, null, undefined, { base64: '' }, { base64: '   ' }, { instance: { state: 'open' } }]) {
      assert.equal(await qrComoImagen(resp), null, JSON.stringify(resp))
    }
  })

  test('un pairingCode no se confunde con un QR', async () => {
    // Es el código de 8 caracteres para vincular por número, otro mecanismo.
    assert.equal(await qrComoImagen({ pairingCode: 'ABCD1234' }), null)
  })
})
