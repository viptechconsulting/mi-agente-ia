import dotenv from 'dotenv';
dotenv.config({ override: true });
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import multer from 'multer';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import PDFDocument from 'pdfkit';
import nodemailer from 'nodemailer';
import {
  db, loadConfig, saveConfig, buildSystemPrompt,
  listCompanies, getCompany, createCompany, updateCompanyMeta, deleteCompany, findCompanyByWaInstance
} from './db.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const assetsDir = path.join(__dirname, 'data', 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
app.use('/assets', express.static(assetsDir, { maxAge: '1h' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// COMPANY RESOLUTION
// ============================================================
function resolveCompany(req) {
  // 1) Explicit
  const explicit = req.headers['x-company-id'] || req.query.companyId || req.query.slug || req.body?.companyId;
  if (explicit) {
    const c = getCompany(explicit);
    if (c) return c;
  }
  // 2) Subdomain (e.g. acme.chat.lynkro.io -> slug "acme")
  try {
    const host = (req.headers.host || '').split(':')[0];
    const parts = host.split('.');
    if (parts.length >= 3) {
      const sub = parts[0];
      if (sub && sub !== 'www' && sub !== 'chat') {
        const c = getCompany(sub);
        if (c) return c;
      }
    }
  } catch {}
  // 3) Fallback: default
  return getCompany('default') || getCompany(listCompanies()[0]?.id);
}

function withCompany(req, res, next) {
  const c = resolveCompany(req);
  if (!c) return res.status(404).json({ error: 'Empresa no encontrada' });
  if (!c.active) return res.status(403).json({ error: 'Empresa desactivada' });
  req.company = c;
  next();
}

function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (!process.env.ADMIN_PASSWORD || pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// ============================================================
// HELPERS
// ============================================================
function chunkText(text, size = 800, overlap = 100) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  for (let i = 0; i < clean.length; i += size - overlap) chunks.push(clean.slice(i, i + size));
  return chunks;
}

function sanitizeFTS(q) {
  return q.replace(/["']/g, ' ').split(/\s+/).filter(w => w.length > 2).slice(0, 10).map(w => `"${w}"`).join(' OR ');
}

function searchKnowledge(companyId, query, limit = 5) {
  const q = sanitizeFTS(query);
  if (!q) return [];
  try {
    return db.prepare(`
      SELECT c.title, c.content FROM chunks c
      JOIN documents d ON d.id = c.doc_id
      WHERE chunks MATCH ? AND d.company_id = ?
      ORDER BY rank LIMIT ?
    `).all(q, companyId, limit);
  } catch { return []; }
}

function extractContacts(text) {
  const emails = [...(text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [])];
  const phones = [...(text.match(/(?:\+?\d[\d\s\-().]{7,}\d)/g) || [])];
  return { emails, phones };
}

// ============================================================
// PUBLIC: widget config
// ============================================================
app.get('/api/config/public', withCompany, (req, res) => {
  const cfg = req.company.config;
  res.json({
    companyId: req.company.id,
    slug: req.company.slug,
    businessName: cfg.businessName,
    welcomeMessage: cfg.welcomeMessage,
    accentColor: cfg.accentColor,
    bgColor: cfg.bgColor,
    userBubbleColor: cfg.userBubbleColor,
    logoUrl: cfg.logoUrl,
    avatarUrl: cfg.avatarUrl,
    widgetPosition: cfg.widgetPosition,
    quickReplies: cfg.quickReplies || []
  });
});

// ============================================================
// COMPANIES (admin)
// ============================================================
app.get('/api/companies', requireAdmin, (req, res) => res.json(listCompanies()));

app.post('/api/companies', requireAdmin, (req, res) => {
  const { name, slug } = req.body;
  if (!name) return res.status(400).json({ error: 'Falta nombre' });
  try { res.json(createCompany({ name, slug })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.patch('/api/companies/:id', requireAdmin, (req, res) => {
  try { res.json(updateCompanyMeta(req.params.id, req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/companies/:id', requireAdmin, (req, res) => {
  try { deleteCompany(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ============================================================
// CONFIG (admin, per-company)
// ============================================================
app.get('/api/config', requireAdmin, withCompany, (req, res) => res.json(req.company.config));
app.post('/api/config', requireAdmin, withCompany, (req, res) => res.json(saveConfig(req.company.id, req.body)));

// ============================================================
// UPLOADS (per-company asset folder)
// ============================================================
const uploadImage = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(assetsDir, req.company?.id || 'default');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.png';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
});

app.post('/api/upload/image', requireAdmin, withCompany, uploadImage.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta archivo' });
  res.json({ url: `/assets/${req.company.id}/${req.file.filename}` });
});

// ============================================================
// CONVERSATIONS (scoped to company)
// ============================================================
app.get('/api/conversations', requireAdmin, withCompany, (req, res) => {
  res.json(db.prepare('SELECT id, visitor_id, channel, unresolved, created_at, updated_at FROM conversations WHERE company_id = ? ORDER BY updated_at DESC LIMIT 100').all(req.company.id));
});
app.get('/api/conversations/:id', requireAdmin, withCompany, (req, res) => {
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND company_id = ?').get(req.params.id, req.company.id);
  if (!conv) return res.status(404).json({ error: 'No encontrada' });
  res.json(db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(req.params.id));
});

app.post('/api/conversations/:id/resolve', requireAdmin, withCompany, (req, res) => {
  db.prepare('UPDATE conversations SET unresolved = 0 WHERE id = ? AND company_id = ?').run(req.params.id, req.company.id);
  res.json({ ok: true });
});

// ============================================================
// KNOWLEDGE DOCS (scoped to company)
// ============================================================
app.get('/api/docs', requireAdmin, withCompany, (req, res) => {
  const docs = db.prepare('SELECT d.id, d.title, d.source, d.created_at, (SELECT COUNT(*) FROM chunks WHERE doc_id = d.id) as chunks FROM documents d WHERE d.company_id = ? ORDER BY created_at DESC').all(req.company.id);
  res.json(docs);
});

app.post('/api/docs/text', requireAdmin, withCompany, (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Falta título o contenido' });
  const info = db.prepare('INSERT INTO documents (title, source, created_at, company_id) VALUES (?, ?, ?, ?)').run(title, 'text', Date.now(), req.company.id);
  const insert = db.prepare('INSERT INTO chunks (doc_id, title, content) VALUES (?, ?, ?)');
  chunkText(content).forEach(c => insert.run(info.lastInsertRowid, title, c));
  res.json({ id: info.lastInsertRowid });
});

app.post('/api/docs/pdf', requireAdmin, withCompany, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Falta archivo' });
    const title = req.body.title || req.file.originalname;
    const parsed = await pdfParse(req.file.buffer);
    if (!parsed.text.trim()) return res.status(400).json({ error: 'PDF sin texto extraíble' });
    const info = db.prepare('INSERT INTO documents (title, source, created_at, company_id) VALUES (?, ?, ?, ?)').run(title, 'pdf', Date.now(), req.company.id);
    const insert = db.prepare('INSERT INTO chunks (doc_id, title, content) VALUES (?, ?, ?)');
    const chunks = chunkText(parsed.text);
    chunks.forEach(c => insert.run(info.lastInsertRowid, title, c));
    res.json({ id: info.lastInsertRowid, chunks: chunks.length });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.delete('/api/docs/:id', requireAdmin, withCompany, (req, res) => {
  const id = req.params.id;
  const doc = db.prepare('SELECT id FROM documents WHERE id = ? AND company_id = ?').get(id, req.company.id);
  if (!doc) return res.status(404).json({ error: 'No encontrado' });
  db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ============================================================
// RATINGS
// ============================================================
app.post('/api/rate', (req, res) => {
  const { conversationId, messageId, rating } = req.body;
  if (!conversationId || ![1, -1].includes(rating)) return res.status(400).json({ error: 'Datos inválidos' });
  db.prepare('INSERT INTO ratings (conversation_id, message_id, rating, created_at) VALUES (?, ?, ?, ?)')
    .run(conversationId, messageId || null, rating, Date.now());
  if (rating === -1) db.prepare('UPDATE conversations SET unresolved = 1 WHERE id = ?').run(conversationId);
  res.json({ ok: true });
});

// ============================================================
// DASHBOARD (scoped)
// ============================================================
app.get('/api/dashboard', requireAdmin, withCompany, (req, res) => {
  const cid = req.company.id;
  const now = Date.now();
  const dayAgo = now - 86400000;
  const weekAgo = now - 7 * 86400000;

  const stat = (sql, ...p) => db.prepare(sql).get(...p) || {};
  const totalConvs = stat('SELECT COUNT(*) as c FROM conversations WHERE company_id = ?', cid).c;
  const byChannel = db.prepare("SELECT COALESCE(channel,'web') as ch, COUNT(*) as c FROM conversations WHERE company_id = ? GROUP BY ch").all(cid);
  const convsToday = stat('SELECT COUNT(*) as c FROM conversations WHERE company_id = ? AND created_at > ?', cid, dayAgo).c;
  const convsWeek = stat('SELECT COUNT(*) as c FROM conversations WHERE company_id = ? AND created_at > ?', cid, weekAgo).c;
  const totalMsgs = stat('SELECT COUNT(*) as c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.company_id = ?', cid).c;
  const userMsgs = stat("SELECT COUNT(*) as c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.company_id = ? AND m.role = 'user'", cid).c;
  const up = stat("SELECT COUNT(*) as c FROM ratings r JOIN conversations c ON c.id = r.conversation_id WHERE c.company_id = ? AND r.rating = 1", cid).c;
  const down = stat("SELECT COUNT(*) as c FROM ratings r JOIN conversations c ON c.id = r.conversation_id WHERE c.company_id = ? AND r.rating = -1", cid).c;
  const satisfaction = (up + down) ? Math.round((up / (up + down)) * 100) : null;
  const unresolved = stat('SELECT COUNT(*) as c FROM conversations WHERE company_id = ? AND unresolved = 1', cid).c;

  const topQuestions = db.prepare(`
    SELECT LOWER(TRIM(m.content)) as q, COUNT(*) as count
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.company_id = ? AND m.role = 'user' AND LENGTH(m.content) < 200
    GROUP BY q ORDER BY count DESC LIMIT 10
  `).all(cid);

  const unresolvedList = db.prepare(`
    SELECT c.id, c.created_at, c.visitor_id,
      (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'user' ORDER BY id DESC LIMIT 1) as last_user_msg
    FROM conversations c WHERE c.company_id = ? AND c.unresolved = 1
    ORDER BY c.updated_at DESC LIMIT 20
  `).all(cid);

  const activity = db.prepare(`
    SELECT strftime('%Y-%m-%d', datetime(created_at/1000, 'unixepoch')) as day, COUNT(*) as c
    FROM conversations WHERE company_id = ? AND created_at > ?
    GROUP BY day ORDER BY day
  `).all(cid, weekAgo);

  res.json({
    totalConvs, convsToday, convsWeek, totalMsgs, userMsgs, byChannel,
    ratings: { up, down, satisfaction },
    unresolved, unresolvedList, topQuestions, activity
  });
});

// ============================================================
// EMAIL NOTIFICATIONS
// ============================================================
function getMailer(cfg) {
  if (!cfg.smtpHost || !cfg.notifyEmail) return null;
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: parseInt(cfg.smtpPort) || 587,
    secure: !!cfg.smtpSecure,
    auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined
  });
}

async function sendNotification({ type, conversationId, companyId }) {
  const cfg = loadConfig(companyId);
  const mailer = getMailer(cfg);
  if (!mailer) return;
  if (type === 'lead' && !cfg.notifyOnLead) return;
  if (type === 'escalation' && !cfg.notifyOnEscalation) return;

  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) || {};
  const msgs = db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId);
  const channel = conv.channel === 'whatsapp' ? '💬 WhatsApp' : '🌐 Web';
  const accent = cfg.accentColor || '#D4AF37';

  const subject = type === 'lead'
    ? `🎯 Nuevo lead capturado — ${cfg.businessName || 'Agente'}`
    : `🚨 Conversación escalada — ${cfg.businessName || 'Agente'}`;

  const transcript = msgs.map(m => {
    const who = m.role === 'user' ? 'Cliente' : 'Agente';
    const color = m.role === 'user' ? accent : '#888';
    const bg = m.role === 'user' ? '#fff8e0' : '#f4f4f4';
    return `<tr><td style="padding:10px 14px;border-left:3px solid ${color};background:${bg};border-radius:4px"><b style="color:${color}">${who}:</b><br>${(m.content || '').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</td></tr>`;
  }).join('<tr><td style="height:8px"></td></tr>');

  const leadInfo = (conv.lead_email || conv.lead_phone)
    ? `<tr><td style="padding:14px;background:#0a0a0a;border-radius:8px;color:#fff">
        <div style="color:${accent};font-size:11px;letter-spacing:2px;margin-bottom:8px">DATOS DEL CLIENTE</div>
        ${conv.lead_email ? `<div>📧 <b>${conv.lead_email}</b></div>` : ''}
        ${conv.lead_phone ? `<div>📞 <b>${conv.lead_phone}</b></div>` : ''}
        <div style="color:#888;font-size:12px;margin-top:6px">${conv.visitor_id || ''}</div>
      </td></tr><tr><td style="height:14px"></td></tr>` : '';

  const html = `
  <div style="font-family:-apple-system,Arial,sans-serif;max-width:640px;margin:0 auto;background:#fafafa;padding:24px">
    <div style="background:#0a0a0a;color:#fff;padding:22px;border-radius:10px;border-left:4px solid ${accent}">
      <div style="color:${accent};font-size:11px;letter-spacing:2px">${type === 'lead' ? 'NUEVO LEAD' : 'ESCALAMIENTO'}</div>
      <h1 style="margin:8px 0 4px;font-size:22px;font-weight:600">${cfg.businessName || 'Agente'}</h1>
      <div style="color:#aaa;font-size:13px">${channel} · ${new Date().toLocaleString('es-MX')}</div>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px">
      ${leadInfo}
      <tr><td style="color:#666;font-size:12px;letter-spacing:1px;padding:0 0 8px">TRANSCRIPCIÓN</td></tr>
      ${transcript}
    </table>
  </div>`;

  try {
    await mailer.sendMail({ from: cfg.smtpFrom || cfg.smtpUser, to: cfg.notifyEmail, subject, html });
  } catch (err) { console.error('Email send failed:', err.message); }
}

app.post('/api/notify/test', requireAdmin, withCompany, async (req, res) => {
  const cfg = req.company.config;
  const mailer = getMailer(cfg);
  if (!mailer) return res.status(400).json({ error: 'SMTP no configurado' });
  try {
    await mailer.sendMail({
      from: cfg.smtpFrom || cfg.smtpUser,
      to: cfg.notifyEmail,
      subject: `Test — ${cfg.businessName || 'Agente IA'}`,
      html: `<div style="font-family:Arial"><h2 style="color:${cfg.accentColor}">✓ Email configurado correctamente</h2></div>`
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// REPORTS (scoped)
// ============================================================
async function buildReportData(companyId, daysBack = 7) {
  const since = Date.now() - daysBack * 86400000;
  const cfg = loadConfig(companyId);

  const totalConvs = db.prepare('SELECT COUNT(*) as c FROM conversations WHERE company_id = ? AND created_at > ?').get(companyId, since).c;
  const unresolved = db.prepare('SELECT COUNT(*) as c FROM conversations WHERE company_id = ? AND created_at > ? AND unresolved = 1').get(companyId, since).c;
  const resolved = totalConvs - unresolved;
  const resolutionRate = totalConvs ? Math.round((resolved / totalConvs) * 100) : null;
  const byChannel = db.prepare("SELECT COALESCE(channel,'web') as ch, COUNT(*) as c FROM conversations WHERE company_id = ? AND created_at > ? GROUP BY ch").all(companyId, since);
  const userMsgs = db.prepare("SELECT COUNT(*) as c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.company_id = ? AND m.role = 'user' AND m.created_at > ?").get(companyId, since).c;
  const up = db.prepare("SELECT COUNT(*) as c FROM ratings r JOIN conversations c ON c.id = r.conversation_id WHERE c.company_id = ? AND r.rating = 1 AND r.created_at > ?").get(companyId, since).c;
  const down = db.prepare("SELECT COUNT(*) as c FROM ratings r JOIN conversations c ON c.id = r.conversation_id WHERE c.company_id = ? AND r.rating = -1 AND r.created_at > ?").get(companyId, since).c;
  const satisfaction = (up + down) ? Math.round((up / (up + down)) * 100) : null;

  const topQuestions = db.prepare(`
    SELECT LOWER(TRIM(m.content)) as q, COUNT(*) as count
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.company_id = ? AND m.role = 'user' AND m.created_at > ? AND LENGTH(m.content) < 200
    GROUP BY q ORDER BY count DESC LIMIT 10
  `).all(companyId, since);

  const unresolvedSamples = db.prepare(`
    SELECT (SELECT content FROM messages WHERE conversation_id = c.id AND role='user' ORDER BY id DESC LIMIT 1) as q
    FROM conversations c WHERE c.company_id = ? AND c.unresolved = 1 AND c.created_at > ? LIMIT 15
  `).all(companyId, since).map(r => r.q).filter(Boolean);

  const allMsgs = db.prepare("SELECT m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.company_id = ? AND m.role = 'user' AND m.created_at > ?").all(companyId, since);
  const emails = new Set(), phones = new Set();
  allMsgs.forEach(m => {
    const c = extractContacts(m.content);
    c.emails.forEach(e => emails.add(e.toLowerCase()));
    c.phones.forEach(p => { const clean = p.replace(/\D/g, ''); if (clean.length >= 8) phones.add(clean); });
  });
  const leads = [...emails].map(e => ({ type: 'email', value: e })).concat([...phones].map(p => ({ type: 'teléfono', value: p })));

  let suggestions = [];
  if (topQuestions.length || unresolvedSamples.length) {
    try {
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: `Eres un analista de atención al cliente. Genera 4-6 sugerencias concretas y accionables para mejorar el agente, basándote en las preguntas reales y consultas sin resolver. Devuelve SOLO una lista de sugerencias separadas por "• " al inicio de cada línea.`,
        messages: [{
          role: 'user',
          content: `Negocio: ${cfg.businessName}\n\nPreguntas más frecuentes:\n${topQuestions.map(q => `- ${q.q} (${q.count}x)`).join('\n')}\n\nConsultas sin resolver:\n${unresolvedSamples.map(q => `- ${q}`).join('\n')}`
        }]
      });
      suggestions = resp.content.map(c => c.text || '').join('').split('\n').map(s => s.replace(/^[•\-*]\s*/, '').trim()).filter(Boolean);
    } catch (err) { console.error('Suggestions error:', err.message); }
  }

  return {
    businessName: cfg.businessName, period: `Últimos ${daysBack} días`,
    generatedAt: new Date().toLocaleString('es-MX'),
    totalConvs, unresolved, resolved, resolutionRate, byChannel, userMsgs,
    ratings: { up, down, satisfaction },
    topQuestions, unresolvedSamples, leads, suggestions
  };
}

app.get('/api/report/weekly.json', requireAdmin, withCompany, async (req, res) => {
  res.json(await buildReportData(req.company.id, parseInt(req.query.days) || 7));
});

app.get('/api/report/weekly.pdf', async (req, res) => {
  if (req.query.pw !== process.env.ADMIN_PASSWORD) return res.status(401).send('No autorizado');
  const companyId = req.query.companyId || req.query.slug || 'default';
  const company = getCompany(companyId);
  if (!company) return res.status(404).send('Empresa no encontrada');
  const days = parseInt(req.query.days) || 7;
  const data = await buildReportData(company.id, days);
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="reporte-${company.slug}-${new Date().toISOString().slice(0, 10)}.pdf"`);
  doc.pipe(res);
  const GOLD = company.config.accentColor || '#D4AF37', DARK = '#0a0a0a', GRAY = '#666';
  doc.fillColor(DARK).fontSize(24).font('Helvetica-Bold').text(data.businessName);
  doc.fillColor(GOLD).fontSize(11).font('Helvetica').text('REPORTE DE ATENCIÓN AL CLIENTE', { characterSpacing: 2 });
  doc.moveDown(0.3);
  doc.fillColor(GRAY).fontSize(9).text(`${data.period} · Generado el ${data.generatedAt}`);
  doc.moveTo(50, doc.y + 8).lineTo(545, doc.y + 8).strokeColor(GOLD).lineWidth(1.5).stroke();
  doc.moveDown(1.5);
  const section = (t) => { doc.moveDown(0.8); doc.fillColor(GOLD).fontSize(10).font('Helvetica-Bold').text(t.toUpperCase(), { characterSpacing: 1.5 }); doc.moveDown(0.4); };
  section('Métricas clave');
  const metrics = [
    ['Total conversaciones', data.totalConvs], ['Mensajes de usuarios', data.userMsgs],
    ['Resueltas', data.resolved], ['Sin resolver', data.unresolved],
    ['Tasa de resolución', data.resolutionRate === null ? '—' : data.resolutionRate + '%'],
    ['Satisfacción', data.ratings.satisfaction === null ? '—' : data.ratings.satisfaction + '%'],
    ['Valoraciones 👍 / 👎', `${data.ratings.up} / ${data.ratings.down}`]
  ];
  doc.fillColor(DARK).fontSize(10).font('Helvetica');
  metrics.forEach(([k, v]) => {
    doc.font('Helvetica').fillColor(GRAY).text(k + ':', 70, doc.y, { continued: true, width: 250 });
    doc.font('Helvetica-Bold').fillColor(DARK).text(' ' + v);
  });
  if (data.byChannel.length) { section('Por canal'); data.byChannel.forEach(c => { doc.font('Helvetica').fillColor(GRAY).text((c.ch==='whatsapp'?'WhatsApp':'Web')+':', 70, doc.y, {continued:true}); doc.font('Helvetica-Bold').fillColor(DARK).text(' '+c.c+' conversaciones'); }); }
  section('Preguntas más frecuentes');
  if (data.topQuestions.length) data.topQuestions.forEach((q,i) => { doc.font('Helvetica-Bold').fillColor(GOLD).text(`${i+1}. `, 70, doc.y, {continued:true, width:20}); doc.font('Helvetica').fillColor(DARK).text(`(${q.count}x) `, {continued:true}); doc.fillColor(GRAY).text(q.q.slice(0,150)); });
  else doc.fillColor(GRAY).text('Sin datos.');
  section('Leads capturados');
  if (data.leads.length) { doc.fillColor(DARK).font('Helvetica').text(`Se detectaron ${data.leads.length} contactos únicos:`); doc.moveDown(0.3); data.leads.slice(0,30).forEach(l => { doc.fillColor(GRAY).text('• ', {continued:true}).fillColor(DARK).text(`${l.type}: ${l.value}`); }); }
  else doc.fillColor(GRAY).text('No se detectaron leads en este período.');
  if (data.unresolvedSamples.length) { section('Consultas sin resolver (muestras)'); data.unresolvedSamples.slice(0,8).forEach(q => doc.fillColor(DARK).font('Helvetica').text('• '+q.slice(0,200), {indent:10})); }
  if (data.suggestions.length) { section('Sugerencias de mejora'); data.suggestions.forEach(s => { doc.fillColor(GOLD).font('Helvetica-Bold').text('→ ', {continued:true, indent:10}); doc.fillColor(DARK).font('Helvetica').text(s); doc.moveDown(0.2); }); }
  doc.moveDown(2);
  doc.fillColor(GRAY).fontSize(8).text('Generado automáticamente · '+data.businessName, 50, doc.page.height-60, {align:'center', width:495});
  doc.end();
});

// ============================================================
// TRAINING (scoped)
// ============================================================
app.get('/api/training/pending', requireAdmin, withCompany, (req, res) => {
  const rows = db.prepare(`
    SELECT m.id as message_id, m.content as question, m.conversation_id, c.channel,
      (SELECT content FROM messages WHERE conversation_id = m.conversation_id AND role='assistant' AND id > m.id ORDER BY id LIMIT 1) as reply,
      (SELECT rating FROM ratings WHERE message_id = (SELECT id FROM messages WHERE conversation_id = m.conversation_id AND role='assistant' AND id > m.id ORDER BY id LIMIT 1)) as rating
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.role = 'user' AND c.company_id = ?
      AND m.id NOT IN (SELECT message_id FROM training_pairs WHERE message_id IS NOT NULL AND company_id = ?)
      AND (c.unresolved = 1 OR EXISTS (
        SELECT 1 FROM ratings r JOIN messages m2 ON m2.id = r.message_id
        WHERE m2.conversation_id = m.conversation_id AND r.rating = -1
      ))
    ORDER BY m.id DESC LIMIT 50
  `).all(req.company.id, req.company.id);
  res.json(rows);
});

app.post('/api/training/teach', requireAdmin, withCompany, (req, res) => {
  const { question, answer, messageId } = req.body;
  if (!question || !answer) return res.status(400).json({ error: 'Falta pregunta o respuesta' });
  const info = db.prepare('INSERT INTO training_pairs (question, answer, message_id, created_at, company_id) VALUES (?, ?, ?, ?, ?)').run(question, answer, messageId || null, Date.now(), req.company.id);
  const docTitle = `Entrenada: ${question.slice(0, 60)}`;
  const doc = db.prepare('INSERT INTO documents (title, source, created_at, company_id) VALUES (?, ?, ?, ?)').run(docTitle, 'training', Date.now(), req.company.id);
  db.prepare('INSERT INTO chunks (doc_id, title, content) VALUES (?, ?, ?)').run(doc.lastInsertRowid, docTitle, `Pregunta: ${question}\n\nRespuesta: ${answer}`);
  if (messageId) {
    const conv = db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(messageId);
    if (conv) db.prepare('UPDATE conversations SET unresolved = 0 WHERE id = ? AND company_id = ?').run(conv.conversation_id, req.company.id);
  }
  res.json({ id: info.lastInsertRowid });
});

app.post('/api/training/ignore', requireAdmin, withCompany, (req, res) => {
  const { messageId } = req.body;
  if (!messageId) return res.status(400).json({ error: 'Falta messageId' });
  db.prepare('INSERT INTO training_pairs (question, answer, message_id, created_at, company_id) VALUES (?, ?, ?, ?, ?)').run('', '[ignorada]', messageId, Date.now(), req.company.id);
  res.json({ ok: true });
});

app.get('/api/training/list', requireAdmin, withCompany, (req, res) => {
  res.json(db.prepare("SELECT id, question, answer, created_at FROM training_pairs WHERE company_id = ? AND answer != '' AND answer != '[ignorada]' ORDER BY id DESC LIMIT 200").all(req.company.id));
});

app.delete('/api/training/:id', requireAdmin, withCompany, (req, res) => {
  const tp = db.prepare('SELECT * FROM training_pairs WHERE id = ? AND company_id = ?').get(req.params.id, req.company.id);
  if (!tp) return res.status(404).json({ error: 'No encontrada' });
  const docTitle = `Entrenada: ${tp.question.slice(0, 60)}`;
  const doc = db.prepare('SELECT id FROM documents WHERE title = ? AND source = ? AND company_id = ?').get(docTitle, 'training', req.company.id);
  if (doc) {
    db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(doc.id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  }
  db.prepare('DELETE FROM training_pairs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============================================================
// CORE CHAT
// ============================================================
async function processMessage({ companyId, message, conversationId, visitorId, channel }) {
  const cfg = loadConfig(companyId);
  let convId = conversationId;
  const now = Date.now();

  if (!convId && visitorId && channel !== 'web') {
    const existing = db.prepare("SELECT id FROM conversations WHERE visitor_id = ? AND channel = ? AND company_id = ? ORDER BY updated_at DESC LIMIT 1").get(visitorId, channel, companyId);
    if (existing) convId = existing.id;
  }

  if (!convId) {
    convId = crypto.randomUUID();
    db.prepare('INSERT INTO conversations (id, visitor_id, channel, created_at, updated_at, company_id) VALUES (?, ?, ?, ?, ?, ?)').run(convId, visitorId || 'anon', channel || 'web', now, now, companyId);
  } else {
    // ensure conv belongs to same company
    const owner = db.prepare('SELECT company_id FROM conversations WHERE id = ?').get(convId);
    if (owner && owner.company_id !== companyId) {
      // re-create under correct company
      convId = crypto.randomUUID();
      db.prepare('INSERT INTO conversations (id, visitor_id, channel, created_at, updated_at, company_id) VALUES (?, ?, ?, ?, ?, ?)').run(convId, visitorId || 'anon', channel || 'web', now, now, companyId);
    } else {
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
    }
  }

  db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(convId, 'user', message, now);

  const contacts = extractContacts(message);
  const conv = db.prepare('SELECT lead_email, lead_phone, lead_notified FROM conversations WHERE id = ?').get(convId);
  let newLead = false;
  if (contacts.emails[0] && !conv.lead_email) {
    db.prepare('UPDATE conversations SET lead_email = ? WHERE id = ?').run(contacts.emails[0], convId);
    newLead = true;
  }
  if (contacts.phones[0] && !conv.lead_phone) {
    const clean = contacts.phones[0].replace(/\D/g, '');
    if (clean.length >= 8) {
      db.prepare('UPDATE conversations SET lead_phone = ? WHERE id = ?').run(contacts.phones[0], convId);
      newLead = true;
    }
  }
  if (newLead && !conv.lead_notified) {
    db.prepare('UPDATE conversations SET lead_notified = 1 WHERE id = ?').run(convId);
    setImmediate(() => sendNotification({ type: 'lead', conversationId: convId, companyId }));
  }

  const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id').all(convId);
  const knowledge = searchKnowledge(companyId, message, 5);
  const knowledgeText = knowledge.length
    ? `\n\nINFORMACIÓN RELEVANTE DE LA BASE DE CONOCIMIENTO:\n${knowledge.map(k => `[${k.title}]\n${k.content}`).join('\n---\n')}\n\nUSA esta información para responder con precisión. Si la respuesta está ahí, cítala.`
    : '';

  const response = await client.messages.create({
    model: cfg.model || 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: buildSystemPrompt(cfg) + knowledgeText,
    messages: history.map(m => ({ role: m.role, content: m.content }))
  });

  const reply = response.content.map(c => c.text || '').join('').trim();
  const info = db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(convId, 'assistant', reply, Date.now());
  if (/no (tengo|sé|conozco)|no puedo (ayudart|responder)|contacta(r)? (al|con) (el )?(equipo|negocio)|pasar tu consulta/i.test(reply)) {
    const c = db.prepare('SELECT escalated_notified FROM conversations WHERE id = ?').get(convId);
    db.prepare('UPDATE conversations SET unresolved = 1 WHERE id = ?').run(convId);
    if (!c.escalated_notified) {
      db.prepare('UPDATE conversations SET escalated_notified = 1 WHERE id = ?').run(convId);
      setImmediate(() => sendNotification({ type: 'escalation', conversationId: convId, companyId }));
    }
  }
  return { conversationId: convId, reply, messageId: info.lastInsertRowid };
}

app.post('/api/chat', withCompany, async (req, res) => {
  try {
    const { message, conversationId, visitorId, demo, history } = req.body;
    if (!message) return res.status(400).json({ error: 'Falta mensaje' });

    if (demo) {
      const cfg = req.company.config;
      const msgs = Array.isArray(history) ? [...history] : [];
      msgs.push({ role: 'user', content: message });
      const knowledge = searchKnowledge(req.company.id, message, 5);
      const knowledgeText = knowledge.length
        ? `\n\nINFORMACIÓN RELEVANTE:\n${knowledge.map(k => `[${k.title}]\n${k.content}`).join('\n---\n')}`
        : '';
      const resp = await client.messages.create({
        model: cfg.model || 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: buildSystemPrompt(cfg) + knowledgeText + '\n\n[MODO DEMO]',
        messages: msgs
      });
      const reply = resp.content.map(c => c.text || '').join('').trim();
      return res.json({ reply, history: [...msgs, { role: 'assistant', content: reply }] });
    }

    const result = await processMessage({ companyId: req.company.id, message, conversationId, visitorId, channel: 'web' });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// WHATSAPP (resolved by instance)
// ============================================================
async function sendWhatsApp(cfg, phone, text) {
  if (!cfg.waBaseUrl || !cfg.waInstance || !cfg.waApiKey) return;
  const url = `${cfg.waBaseUrl.replace(/\/$/, '')}/message/sendText/${cfg.waInstance}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': cfg.waApiKey },
      body: JSON.stringify({ number: phone, text })
    });
    if (!r.ok) console.error('WA send failed:', r.status, await r.text());
  } catch (err) { console.error('WA send error:', err.message); }
}

app.post('/api/whatsapp/webhook', async (req, res) => {
  try {
    res.sendStatus(200);
    const ev = req.body;
    const event = ev?.event || '';
    if (!/messages.?upsert/i.test(event)) return;
    const instance = ev.instance || ev.instanceName;
    const company = findCompanyByWaInstance(instance) || getCompany('default');
    if (!company) return;
    const data = ev.data || ev;
    if (data?.key?.fromMe) return;
    const jid = data?.key?.remoteJid || '';
    if (!jid || jid.includes('@g.us')) return;
    const phone = jid.split('@')[0];
    const text = data.message?.conversation
      || data.message?.extendedTextMessage?.text
      || data.message?.imageMessage?.caption || '';
    if (!text.trim()) return;
    const result = await processMessage({ companyId: company.id, message: text, visitorId: `wa:${phone}`, channel: 'whatsapp' });
    await sendWhatsApp(company.config, phone, result.reply);
  } catch (err) { console.error('WA webhook error:', err); }
});

app.post('/api/whatsapp/test', requireAdmin, withCompany, async (req, res) => {
  const { phone, text } = req.body;
  await sendWhatsApp(req.company.config, phone, text || 'Test desde el agente ✓');
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Agente multi-empresa corriendo en http://localhost:${PORT}`));
