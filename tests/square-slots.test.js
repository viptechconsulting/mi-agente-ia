// tests/square-slots.test.js
// square_get_slots existe para que el agente OFREZCA horarios reales en vez de
// preguntar "¿qué día te queda mejor?". Lo que se puede romper en silencio es el
// agrupado: zona horaria de Miami, tope de días/horarios y el filtro from_date.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupSquareSlots } from '../routes/chat.js'

const slot = iso => ({ startAt: iso })

test('agrupa por día calendario de Miami, no por UTC', () => {
  // 2026-07-10T01:30:00Z son las 9:30 PM del 9 de julio en Miami (EDT, -04:00).
  const { dias } = groupSquareSlots([slot('2026-07-10T01:30:00Z'), slot('2026-07-10T14:00:00Z')])
  assert.deepEqual(dias.map(d => d.date), ['2026-07-09', '2026-07-10'])
  assert.deepEqual(dias[0].horarios, ['9:30 PM'])
  assert.deepEqual(dias[1].horarios, ['10:00 AM'])
})

test('respeta el horario de invierno (EST, -05:00)', () => {
  // Misma hora UTC, pero en enero Miami está en -05:00 → 8:30 PM del día 9.
  const { dias } = groupSquareSlots([slot('2026-01-10T01:30:00Z')])
  assert.equal(dias[0].date, '2026-01-09')
  assert.equal(dias[0].horarios[0], '8:30 PM')
})

test('ordena y recorta a maxDays días y maxPerDay horarios', () => {
  const slots = []
  for (let d = 10; d < 20; d++) for (let h = 14; h < 21; h++) slots.push(slot(`2026-07-${d}T${h}:00:00Z`))
  const { dias } = groupSquareSlots(slots.reverse(), { maxDays: 3, maxPerDay: 2 })
  assert.equal(dias.length, 3)
  assert.deepEqual(dias.map(d => d.date), ['2026-07-10', '2026-07-11', '2026-07-12'])
  for (const d of dias) assert.equal(d.horarios.length, 2)
  assert.deepEqual(dias[0].horarios, ['10:00 AM', '11:00 AM']) // los más tempranos primero
})

test('from_date descarta los días anteriores al pedido', () => {
  const slots = [slot('2026-07-09T14:00:00Z'), slot('2026-07-11T14:00:00Z')]
  const { dias } = groupSquareSlots(slots, { fromDate: '2026-07-10' })
  assert.deepEqual(dias.map(d => d.date), ['2026-07-11'])
})

test('sin disponibilidad devuelve un aviso, no una lista vacía muda', () => {
  const r = groupSquareSlots([])
  assert.deepEqual(r.dias, [])
  assert.match(r.aviso, /Sin disponibilidad/)
})
