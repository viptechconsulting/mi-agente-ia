// services/apify.js — cliente genérico de Apify (sin dependencia npm nueva)
//
// Mismo endpoint que ya usa el skill generador-reels/scripts/scrape_reels.py:
// run-sync-get-dataset-items corre el actor y devuelve el dataset en la misma
// respuesta — sin webhooks ni polling. Apify limita ese endpoint a ~5 minutos
// de ejecución; para scrapes más grandes que ese límite, correr el actor
// async (POST /v2/acts/{actorId}/runs) y hacer polling sobre
// GET /v2/actor-runs/{runId} + GET /v2/datasets/{datasetId}/items no está
// implementado aquí todavía — es la vía a seguir si run-sync empieza a
// cortarse por timeout en batches grandes.

const API_BASE = 'https://api.apify.com/v2'
const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000

export function getApifyToken() {
  const token = process.env.APIFY_TOKEN
  if (!token) throw new Error('APIFY_TOKEN no está configurado')
  return token
}

// actorId puede venir como "owner/name" o "owner~name" (Apify acepta ambos
// formatos en la URL, pero normalizamos a "~" que es el que usa la API REST).
function normalizeActorId(actorId) {
  return String(actorId).replace('/', '~')
}

export async function runApifyActor(actorId, input, { token, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const apifyToken = token || getApifyToken()
  const url = `${API_BASE}/acts/${normalizeActorId(actorId)}/run-sync-get-dataset-items?token=${apifyToken}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input || {}),
      signal: controller.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Apify actor ${actorId} respondió ${res.status}: ${text.slice(0, 500)}`)
    }
    const items = await res.json()
    return Array.isArray(items) ? items : []
  } finally {
    clearTimeout(timer)
  }
}
