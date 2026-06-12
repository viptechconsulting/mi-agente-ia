// middleware/auth.js
import crypto from 'crypto'
import { db } from '../db.js'

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
