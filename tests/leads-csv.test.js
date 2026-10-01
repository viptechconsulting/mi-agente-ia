// tests/leads-csv.test.js
// El CSV de leads lo abre la clienta en Excel. Lo que no puede romperse: que un
// mensaje con comas/comillas/saltos no descuadre las columnas, y que lo que
// escribió el lead no se ejecute como fórmula al abrir el archivo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCsv } from '../routes/chat.js'

const sinBom = s => s.replace(/^﻿/, '')
const filas = csv => sinBom(csv).split('\r\n')

test('cabecera y una fila normal', () => {
  const csv = buildCsv(['Nombre', 'Teléfono'], [['Ana', '+17863830513']])
  assert.deepEqual(filas(csv), ['"Nombre","Teléfono"', '"Ana","+17863830513"'])
})

test('lleva BOM para que Excel respete los acentos', () => {
  assert.ok(buildCsv(['Teléfono'], []).startsWith('﻿'))
})

test('comas y comillas dentro del mensaje no parten la columna', () => {
  const msg = 'Hola, quiero la sesión de "Glass Skin", ¿cuánto sale?'
  const csv = buildCsv(['Nombre', 'Consulta'], [['Ana', msg]])
  const fila = filas(csv)[1]
  assert.equal(fila, `"Ana","Hola, quiero la sesión de ""Glass Skin"", ¿cuánto sale?"`)
  assert.equal(fila.split('","').length, 2, 'siguen siendo 2 columnas')
})

test('un mensaje que empieza por = no se ejecuta como fórmula en Excel', () => {
  // El contenido lo escribe un desconocido por WhatsApp: es entrada no confiable.
  for (const peligroso of ['=1+1', '+SUM(A1)', '-2+3', '@SUM(A1)']) {
    const fila = filas(buildCsv(['Consulta'], [[peligroso]]))[1]
    assert.equal(fila, `"'${peligroso}"`, `${peligroso} debe quedar neutralizado`)
  }
})

test('un teléfono internacional NO se neutraliza (es la columna principal)', () => {
  for (const tel of ['+17863830513', '+1 786 383-0513', '+34 (91) 123 45 67']) {
    assert.equal(filas(buildCsv(['Teléfono'], [[tel]]))[1], `"${tel}"`, `${tel} debe salir limpio`)
  }
})

test('un mensaje que solo menciona un precio no se toca', () => {
  const fila = filas(buildCsv(['Consulta'], [['Cuesta $99 o menos?']]))[1]
  assert.equal(fila, '"Cuesta $99 o menos?"')
})

test('un nombre o mensaje con saltos de línea sigue siendo UNA fila', () => {
  // Pasa de verdad: hay leads guardados con "Melissa\nWhatsApp" como nombre.
  const csv = buildCsv(['Nombre', 'Consulta'], [['Melissa\nWhatsApp', 'Hola\n\nquiero info']])
  const f = filas(csv)
  assert.equal(f.length, 2, 'cabecera + 1 fila, no 4 líneas sueltas')
  assert.equal(f[1], '"Melissa WhatsApp","Hola quiero info"')
})

test('null y undefined salen como celda vacía, no como "null"', () => {
  assert.equal(filas(buildCsv(['A', 'B'], [[null, undefined]]))[1], '"",""')
})
