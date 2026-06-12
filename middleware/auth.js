// middleware/auth.js
import crypto from 'crypto'
import { db, getCompany, getCompanyByToken, listCompanies } from '../db.js'

function resolveCompany(req) {
  const token = req.query.token || req.body?.token
  if (token) {
    const c = getCompanyByToken(token)
    if (c) return c
  }
  const explicit = req.headers['x-company-id'] || req.query.companyId || req.query.slug || req.body?.companyId
  if (explicit) {
    const c = getCompany(explicit)
    if (c) return c
  }
  try {
    const host = (req.headers.host || '').split(':')[0]
    const parts = host.split('.')
    if (parts.length >= 3) {
      const sub = parts[0]
      if (sub && sub !== 'www' && sub !== 'chat') {
        const c = getCompany(sub)
        if (c) return c
      }
    }
  } catch {}
  return getCompany('default') || getCompany(listCompanies()[0]?.id)
}

export function withCompany(req, res, next) {
  const c = resolveCompany(req)
  if (!c) return res.status(404).json({ error: 'Empresa no encontrada' })
  if (!c.active) return res.status(403).json({ error: 'Empresa desactivada' })
  if (c.expires_at && Date.now() > c.expires_at) return res.status(403).json({ error: 'Esta demo ha expirado' })
  if (req.allowedCompanies && !req.allowedCompanies.includes(c.id)) {
    return res.status(403).json({ error: 'No tienes acceso a esta empresa' })
  }
  req.company = c
  next()
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = stored.split(':')
    return crypto.timingSafeEqual(
      Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex')),
      Buffer.from(hash)
    )
  } catch { return false }
}

export function requireAdmin(req, res, next) {
  const pw    = (req.headers['x-admin-password'] || req.query.adminPassword || '')
  const email = (req.headers['x-admin-email']    || req.query.adminEmail    || '').toLowerCase().trim()

  // 1) Super-admin via env vars
  if (process.env.ADMIN_PASSWORD && pw === process.env.ADMIN_PASSWORD) {
    const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase()
    if (!adminEmail || !email || email === adminEmail) {
      req.isSuperAdmin = true
      req.allowedCompanies = null // null = acceso a todo
      return next()
    }
  }

  // 2) Sub-usuario en DB
  if (email) {
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email)
    if (user && verifyPassword(pw, user.password_hash)) {
      req.isSuperAdmin = false
      req.userId = user.id
      req.userEmail = user.email
      req.allowedCompanies = JSON.parse(user.company_ids || '[]')
      return next()
    }
  }

  return res.status(401).json({ error: 'No autorizado' })
}
