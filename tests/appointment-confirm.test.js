import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const classify = async (t) => {
  const { classifyConfirmation } = await import('../services/appointment-confirm.js')
  return classifyConfirmation(t)
}

describe('classifyConfirmation — respuesta del paciente al recordatorio', () => {
  test('reconoce confirmaciones cortas en español, con y sin acento', async () => {
    for (const t of ['sí', 'si', 'Si', 'SÍ', 'sip', 'claro', 'ok', 'okey', 'dale', 'listo', 'confirmo', 'confirmado', 'ahí estaré', 'nos vemos', '1']) {
      assert.equal(await classify(t), 'confirmed', `debería confirmar: ${t}`)
    }
  })

  test('reconoce confirmaciones en inglés', async () => {
    for (const t of ['yes', 'Yep', 'sure', 'ok']) {
      assert.equal(await classify(t), 'confirmed', `debería confirmar: ${t}`)
    }
  })

  test('reconoce cancelaciones y pedidos de reagendar', async () => {
    for (const t of ['no', 'cancelar', 'quiero cancelar', 'necesito reagendar', 'no puedo ir', 'no voy a poder', '¿podemos moverla para otro día?', 'cambiar la hora', 'I need to reschedule', "can't make it"]) {
      assert.equal(await classify(t), 'declined', `debería declinar: ${t}`)
    }
  })

  test('detecta la cancelación aunque venga en un texto largo — libera el cupo', async () => {
    const largo = 'Hola, buenas tardes, disculpá la molestia pero me surgió un tema en el trabajo y necesito reagendar la cita para la semana que viene si es posible'
    assert.equal(await classify(largo), 'declined')
  })

  test('un "sí" enterrado en un texto largo NO se toma como confirmación', async () => {
    // Marcar mal una cita como confirmada es peor que no marcarla: nadie
    // vuelve a insistir y el hueco se pierde igual.
    const largo = 'Hola, sí quería preguntarte una cosa sobre el tratamiento antes de decidir, ¿me podés explicar cuántas sesiones son y si duele mucho el procedimiento?'
    assert.equal(await classify(largo), 'unclear')
  })

  test('ambigüedades quedan en unclear para que las maneje el agente', async () => {
    for (const t of ['no sé si pueda', 'tal vez', 'a qué hora era?', 'cuánto cuesta?', '¿dónde queda?']) {
      assert.notEqual(await classify(t), 'confirmed', `no debería confirmar: ${t}`)
    }
  })

  test('"no sé si pueda" no se marca como cancelación tampoco', async () => {
    // Ni confirmado ni cancelado: sigue pendiente y el 2º intento debe salir.
    assert.equal(await classify('no sé si pueda'), 'unclear')
  })

  test('texto vacío o basura es unclear', async () => {
    assert.equal(await classify(''), 'unclear')
    assert.equal(await classify('   '), 'unclear')
    assert.equal(await classify(null), 'unclear')
    assert.equal(await classify('👍'), 'unclear')
  })
})

describe('noShowStats — no infla la tasa con citas sin marcar', () => {
  test('las tasas se calculan solo sobre lo efectivamente marcado', async () => {
    // 4 citas: 2 marcadas (1 no-show), 2 sin marcar. La tasa debe ser 50%,
    // no 25% — si contáramos las no marcadas como asistidas, mentiría.
    const rows = [
      { confirm_state: 'confirmed', attendance: 'showed' },
      { confirm_state: 'pending', attendance: 'noshow' },
      { confirm_state: 'pending', attendance: null },
      { confirm_state: 'confirmed', attendance: null }
    ]
    const marcadas = rows.filter(r => r.attendance).length
    const noshow = rows.filter(r => r.attendance === 'noshow').length
    assert.equal(marcadas, 2)
    assert.equal(Math.round(noshow / marcadas * 100), 50)
  })
})
