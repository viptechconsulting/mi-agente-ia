// services/prospecting-scraper.js — Paso "Scrapea": 100 negocios reales en
// minutos, vía Apify (actor de Google Maps) en vez de la Google Places API.
import crypto from 'crypto'
import { db } from '../db.js'
import { runApifyActor } from './apify.js'
import { computePainScore } from './prospecting-score.js'

const DEFAULT_ACTOR_ID = 'compass~crawler-google-places'
const DEFAULT_LIMIT = 100

function actorId() {
  return process.env.APIFY_GMAPS_ACTOR_ID || DEFAULT_ACTOR_ID
}

// Input del actor "Google Maps Scraper" (compass/crawler-google-places).
export function buildGmapsSearchInput(niche, city, limit = DEFAULT_LIMIT) {
  return {
    searchStringsArray: [niche],
    locationQuery: city,
    maxCrawledPlacesPerSearch: limit,
    language: 'es',
    skipClosedPlaces: true
  }
}

function first(item, ...keys) {
  for (const k of keys) {
    const v = item?.[k]
    if (v !== null && v !== undefined && v !== '') return v
  }
  return null
}

// El actor no trae un campo de Instagram dedicado — cuando el "sitio web"
// del negocio en Google Maps es en realidad un perfil de Instagram, lo
// tratamos como su Instagram y NO como sitio web real (para el pain_score,
// un negocio que solo vive en Instagram cuenta como "sin sitio web").
function splitWebsiteAndInstagram(rawWebsite) {
  if (!rawWebsite) return { website: null, instagram: null }
  if (/instagram\.com/i.test(rawWebsite)) return { website: null, instagram: rawWebsite }
  return { website: rawWebsite, instagram: null }
}

function hasPublishedHours(item) {
  const hours = first(item, 'openingHours', 'opening_hours')
  return Array.isArray(hours) && hours.length > 0
}

export function normalizeGmapsItem(item) {
  const rawWebsite = first(item, 'website', 'url')
  const { website, instagram } = splitWebsiteAndInstagram(rawWebsite)
  return {
    name: first(item, 'title', 'name'),
    phone: first(item, 'phoneUnformatted', 'phone', 'phoneNumber'),
    website,
    instagram,
    address: first(item, 'address', 'street'),
    category: first(item, 'categoryName', 'category'),
    rating: first(item, 'totalScore', 'rating'),
    reviews_count: first(item, 'reviewsCount', 'reviews_count') ?? 0,
    has_hours: hasPublishedHours(item) ? 1 : 0,
    has_website: website ? 1 : 0
  }
}

function insertProspect(batchId, normalized) {
  const now = Date.now()
  const id = crypto.randomUUID()
  const pain_score = computePainScore(normalized)
  db.prepare(`
    INSERT INTO prospects (
      id, batch_id, name, phone, website, instagram, address, category,
      rating, reviews_count, has_hours, has_website, pain_score, status,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, batchId, normalized.name, normalized.phone, normalized.website,
    normalized.instagram, normalized.address, normalized.category,
    normalized.rating, normalized.reviews_count, normalized.has_hours,
    normalized.has_website, pain_score, 'new', now, now
  )
  return id
}

export async function runProspectingBatch({ niche, city, serviceOffered, limit = DEFAULT_LIMIT }) {
  if (!niche || !city) throw new Error('niche y city son obligatorios')

  const batchId = crypto.randomUUID()
  const now = Date.now()
  db.prepare(`
    INSERT INTO prospect_batches (id, niche, city, service_offered, status, created_at)
    VALUES (?,?,?,?,?,?)
  `).run(batchId, niche, city, serviceOffered || null, 'running', now)

  try {
    const input = buildGmapsSearchInput(niche, city, limit)
    const items = await runApifyActor(actorId(), input)
    const normalized = items.map(normalizeGmapsItem).filter(n => n.name)
    for (const n of normalized) insertProspect(batchId, n)

    db.prepare(`
      UPDATE prospect_batches SET status = 'completed', total_scraped = ? WHERE id = ?
    `).run(normalized.length, batchId)

    return { batchId, totalScraped: normalized.length }
  } catch (err) {
    db.prepare(`
      UPDATE prospect_batches SET status = 'failed', error = ? WHERE id = ?
    `).run(err.message, batchId)
    throw err
  }
}
