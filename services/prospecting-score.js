// services/prospecting-score.js — Paso "Filtra": a quién atacamos primero
//
// Regla exacta del playbook (slide "El filtro de dolor"):
//   +3  si NO tiene sitio web
//   +2  si reseñas < 20
//   +2  si rating < 4.0
//   +1  si no tiene horario publicado
// Puntúa 0-8. Mayor score = más roto = se le escribe primero.

export function computePainScore(prospect) {
  const hasWebsite = !!prospect.has_website
  const reviewsCount = prospect.reviews_count ?? 0
  // Sin rating (null/undefined) se trata como señal de presencia digital
  // débil, igual que un rating bajo — no hay forma de distinguir "buen
  // negocio sin reseñas" de "negocio invisible en Google" sin más datos.
  const rating = prospect.rating
  const hasHours = !!prospect.has_hours

  let score = 0
  if (!hasWebsite) score += 3
  if (reviewsCount < 20) score += 2
  if (rating == null || rating < 4.0) score += 2
  if (!hasHours) score += 1
  return score
}

export function painTier(score) {
  if (score >= 6) return 'hi'
  if (score >= 3) return 'md'
  return 'lo'
}
