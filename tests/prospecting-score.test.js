import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computePainScore, painTier } from '../services/prospecting-score.js'

describe('computePainScore', () => {
  test('negocio perfecto (web, muchas reseñas, buen rating, horario) → 0', () => {
    const score = computePainScore({ has_website: 1, reviews_count: 200, rating: 4.8, has_hours: 1 })
    assert.equal(score, 0)
  })

  test('sin sitio web suma 3', () => {
    const score = computePainScore({ has_website: 0, reviews_count: 200, rating: 4.8, has_hours: 1 })
    assert.equal(score, 3)
  })

  test('menos de 20 reseñas suma 2', () => {
    const score = computePainScore({ has_website: 1, reviews_count: 5, rating: 4.8, has_hours: 1 })
    assert.equal(score, 2)
  })

  test('rating menor a 4.0 suma 2', () => {
    const score = computePainScore({ has_website: 1, reviews_count: 200, rating: 3.5, has_hours: 1 })
    assert.equal(score, 2)
  })

  test('rating ausente (null) cuenta igual que rating bajo', () => {
    const score = computePainScore({ has_website: 1, reviews_count: 200, rating: null, has_hours: 1 })
    assert.equal(score, 2)
  })

  test('sin horario publicado suma 1', () => {
    const score = computePainScore({ has_website: 1, reviews_count: 200, rating: 4.8, has_hours: 0 })
    assert.equal(score, 1)
  })

  test('el peor caso posible suma 8', () => {
    const score = computePainScore({ has_website: 0, reviews_count: 0, rating: null, has_hours: 0 })
    assert.equal(score, 8)
  })

  test('reviews_count ausente se trata como 0', () => {
    const score = computePainScore({ has_website: 1, reviews_count: undefined, rating: 4.8, has_hours: 1 })
    assert.equal(score, 2)
  })
})

describe('painTier', () => {
  test('score alto (>=6) es hi', () => { assert.equal(painTier(8), 'hi'); assert.equal(painTier(6), 'hi') })
  test('score medio (3-5) es md', () => { assert.equal(painTier(5), 'md'); assert.equal(painTier(3), 'md') })
  test('score bajo (<3) es lo', () => { assert.equal(painTier(2), 'lo'); assert.equal(painTier(0), 'lo') })
})
