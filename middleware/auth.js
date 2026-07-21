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

export function requireSuperAdmin(req, res, next) {
  requireAdmin(req, res, () => {
    if (!req.isSuperAdmin) return res.status(403).json({ error: 'Solo el administrador principal puede realizar esta acción' })
    next()
  })
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

// Verifies real credentials (super-admin env password or per-user DB hash).
// Used by POST /api/auth/login to mint a session token, and as a fallback
// inside requireAdmin for callers that can't hold a session (OAuth popup
// redirects that must pass credentials as a query string).
export function verifyCredentials(pw, email) {
  if (process.env.ADMIN_PASSWORD && pw && timingSafeStringEqual(pw, process.env.ADMIN_PASSWORD)) {
    const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase()
    if (!adminEmail || !email || email === adminEmail) {
      return { isSuperAdmin: true, userId: null, userEmail: adminEmail || email || null, allowedCompanies: null }
    }
  }

  if (email) {
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email)
    if (user && verifyPassword(pw, user.password_hash)) {
      return {
        isSuperAdmin: false,
        userId: user.id,
        userEmail: user.email,
        allowedCompanies: JSON.parse(user.company_ids || '[]')
      }
    }
  }

  return null
}

// In-memory admin session tokens. The client stores this opaque token
// instead of the real password (see POST /api/auth/login), so an XSS bug
// or a leaked log/URL exposes a short-lived, revocable token rather than
// the permanent admin credential.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const sessions = new Map()

export function createSession(payload) {
  const token = crypto.randomBytes(32).toString('base64url')
  sessions.set(token, { ...payload, expires: Date.now() + SESSION_TTL_MS })
  return token
}

export function getSession(token) {
  const entry = sessions.get(token)
  if (!entry) return null
  if (Date.now() > entry.expires) { sessions.delete(token); return null }
  return entry
}

export function revokeSession(token) {
  sessions.delete(token)
}

// Signs/verifies the `state` param used by OAuth connect/callback flows
// (Square, QuickBooks, Google Calendar, Instagram) so an attacker can't
// forge a state naming a victim company to hijack its integration.
// A random per-process secret is sufficient here — state is only ever
// used within minutes of issuance during a live OAuth redirect.
const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || crypto.randomBytes(32).toString('hex')
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

export function signState(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, ts: Date.now() })).toString('base64url')
  const sig = crypto.createHmac('sha256', OAUTH_STATE_SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyState(state) {
  const [body, sig] = String(state || '').split('.')
  if (!body || !sig) return null
  const expected = crypto.createHmac('sha256', OAUTH_STATE_SECRET).update(body).digest('base64url')
  const a = Buffer.from(sig), b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (!parsed.ts || Date.now() - parsed.ts > OAUTH_STATE_TTL_MS) return null
    return parsed
  } catch { return null }
}

export function requireAdmin(req, res, next) {
  const pw    = (req.headers['x-admin-password'] || req.query.adminPassword || '')
  const email = (req.headers['x-admin-email']    || req.query.adminEmail    || '').toLowerCase().trim()

  // 1) Session token issued by POST /api/auth/login
  const session = pw && getSession(pw)
  if (session) {
    req.isSuperAdmin = session.isSuperAdmin
    req.userId = session.userId
    req.userEmail = session.userEmail
    req.allowedCompanies = session.allowedCompanies
    return next()
  }

  // 2) Direct credential check (used by the login endpoint itself, and as a
  //    fallback for full-page OAuth redirects that cannot set headers)
  const result = verifyCredentials(pw, email)
  if (result) {
    req.isSuperAdmin = result.isSuperAdmin
    req.userId = result.userId
    req.userEmail = result.userEmail
    req.allowedCompanies = result.allowedCompanies
    return next()
  }

  console.warn(JSON.stringify({
    event: 'auth_failure', ip: req.ip, path: req.originalUrl, email: email || null,
    ts: new Date().toISOString()
  }))
  return res.status(401).json({ error: 'No autorizado' })
}
