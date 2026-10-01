// tests/booking-link.test.js
// El negocio agenda con su calendario público (bookingUrl), no con la API.
// Lo que no puede romperse: que el link viaje ENTERO en el prompt (si se corta
// o se reescribe, el cliente recibe un link muerto) y que el agente tenga
// prohibido pedir fecha/hora o inventar que ya agendó.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBookingLinkPrompt } from '../routes/chat.js'

const URL_BEGLAM = 'https://book.squareup.com/appointments/59nxwn7zb4swvb/location/LZWE96EKE6XWE/services/F75PMDM2VSFEGB7XTDRBCYIJ'

test('el link va completo y en su propia línea', () => {
  const p = buildBookingLinkPrompt(URL_BEGLAM)
  assert.ok(p.includes(URL_BEGLAM), 'el link debe aparecer literal, sin recortar')
  assert.ok(p.includes(`\n${URL_BEGLAM}\n`), 'el link debe ir solo en su línea')
})

test('prohíbe pedir fecha/hora, proponer horarios e inventar la reserva', () => {
  const p = buildBookingLinkPrompt(URL_BEGLAM)
  assert.match(p, /NUNCA le preguntes "¿qué día y hora te queda mejor\?"/)
  assert.match(p, /NUNCA le propongas horarios tú/)
  assert.match(p, /NUNCA le digas que ya le agendaste/)
})
