import dotenv from 'dotenv';
dotenv.config({ override: true });
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import multer from 'multer';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { db, loadConfig, saveConfig, buildSystemPrompt } from './db.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (!process.env.ADMIN_PASSWORD || pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

function chunkText(text, size = 800, overlap = 100) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  for (let i = 0; i < clean.length; i += size - overlap) {
    chunks.push(clean.slice(i, i + size));
  }
  return chunks;
}

function sanitizeFTS(q) {
  return q.replace(/["']/g, ' ').split(/\s+/).filter(w => w.length > 2).slice(0, 10).map(w => `"${w}"`).join(' OR ');
}

function searchKnowledge(query, limit = 5) {
  const q = sanitizeFTS(query);
  if (!q) return [];
  try {
    return db.prepare(`SELECT title, content FROM chunks WHERE chunks MATCH ? ORDER BY rank LIMIT ?`).all(q, limit);
  } catch { return []; }
}

app.get('/api/config/public', (req, res) => {
  const cfg = loadConfig();
  res.json({
    businessName: cfg.businessName,
    welcomeMessage: cfg.welcomeMessage,
    accentColor: cfg.accentColor,
    quickReplies: cfg.quickReplies || []
  });
});

app.get('/api/config', requireAdmin, (req, res) => res.json(loadConfig()));
app.post('/api/config', requireAdmin, (req, res) => res.json(saveConfig(req.body)));

app.get('/api/conversations', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, visitor_id, channel, unresolved, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 100').all());
});
app.get('/api/conversations/:id', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(req.params.id));
});

app.get('/api/docs', requireAdmin, (req, res) => {
  const docs = db.prepare('SELECT d.id, d.title, d.source, d.created_at, (SELECT COUNT(*) FROM chunks WHERE doc_id = d.id) as chunks FROM documents d ORDER BY created_at DESC').all();
  res.json(docs);
});

app.post('/api/docs/text', requireAdmin, (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Falta título o contenido' });
  const info = db.prepare('INSERT INTO documents (title, source, created_at) VALUES (?, ?, ?)').run(title, 'text', Date.now());
  const insert = db.prepare('INSERT INTO chunks (doc_id, title, content) VALUES (?, ?, ?)');
  chunkText(content).forEach(c => insert.run(info.lastInsertRowid, title, c));
  res.json({ id: info.lastInsertRowid });
});

app.post('/api/docs/pdf', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Falta archivo' });
    const title = req.body.title || req.file.originalname;
    const parsed = await pdfParse(req.file.buffer);
    if (!parsed.text.trim()) return res.status(400).json({ error: 'PDF sin texto extraíble' });
    const info = db.prepare('INSERT INTO documents (title, source, created_at) VALUES (?, ?, ?)').run(title, 'pdf', Date.now());
    const insert = db.prepare('INSERT INTO chunks (doc_id, title, content) VALUES (?, ?, ?)');
    const chunks = chunkText(parsed.text);
    chunks.forEach(c => insert.run(info.lastInsertRowid, title, c));
    res.json({ id: info.lastInsertRowid, chunks: chunks.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rate', (req, res) => {
  const { conversationId, messageId, rating } = req.body;
  if (!conversationId || ![1, -1].includes(rating)) return res.status(400).json({ error: 'Datos inválidos' });
  db.prepare('INSERT INTO ratings (conversation_id, message_id, rating, created_at) VALUES (?, ?, ?, ?)')
    .run(conversationId, messageId || null, rating, Date.now());
  if (rating === -1) db.prepare('UPDATE conversations SET unresolved = 1 WHERE id = ?').run(conversationId);
  res.json({ ok: true });
});

app.get('/api/dashboard', requireAdmin, (req, res) => {
  const now = Date.now();
  const dayAgo = now - 86400000;
  const weekAgo = now - 7 * 86400000;

  const stat = (sql, ...p) => db.prepare(sql).get(...p) || {};
  const totalConvs = stat('SELECT COUNT(*) as c FROM conversations').c;
  const byChannel = db.prepare("SELECT COALESCE(channel,'web') as ch, COUNT(*) as c FROM conversations GROUP BY ch").all();
  const convsToday = stat('SELECT COUNT(*) as c FROM conversations WHERE created_at > ?', dayAgo).c;
  const convsWeek = stat('SELECT COUNT(*) as c FROM conversations WHERE created_at > ?', weekAgo).c;
  const totalMsgs = stat('SELECT COUNT(*) as c FROM messages').c;
  const userMsgs = stat('SELECT COUNT(*) as c FROM messages WHERE role = ?', 'user').c;
  const up = stat("SELECT COUNT(*) as c FROM ratings WHERE rating = 1").c;
  const down = stat("SELECT COUNT(*) as c FROM ratings WHERE rating = -1").c;
  const satisfaction = (up + down) ? Math.round((up / (up + down)) * 100) : null;
  const unresolved = stat('SELECT COUNT(*) as c FROM conversations WHERE unresolved = 1').c;

  const topQuestions = db.prepare(`
    SELECT LOWER(TRIM(content)) as q, COUNT(*) as count
    FROM messages WHERE role = 'user' AND LENGTH(content) < 200
    GROUP BY q ORDER BY count DESC LIMIT 10
  `).all();

  const unresolvedList = db.prepare(`
    SELECT c.id, c.created_at, c.visitor_id,
      (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'user' ORDER BY id DESC LIMIT 1) as last_user_msg
    FROM conversations c WHERE c.unresolved = 1
    ORDER BY c.updated_at DESC LIMIT 20
  `).all();

  const activity = db.prepare(`
    SELECT strftime('%Y-%m-%d', datetime(created_at/1000, 'unixepoch')) as day, COUNT(*) as c
    FROM conversations WHERE created_at > ?
    GROUP BY day ORDER BY day
  `).all(weekAgo);

  res.json({
    totalConvs, convsToday, convsWeek, totalMsgs, userMsgs, byChannel,
    ratings: { up, down, satisfaction },
    unresolved, unresolvedList, topQuestions, activity
  });
});

app.post('/api/conversations/:id/resolve', requireAdmin, (req, res) => {
  db.prepare('UPDATE conversations SET unresolved = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/docs/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  res.json({ ok: true });
});

async function processMessage({ message, conversationId, visitorId, channel }) {
  const cfg = loadConfig();
  let convId = conversationId;
  const now = Date.now();

  if (!convId && visitorId && channel !== 'web') {
    const existing = db.prepare("SELECT id FROM conversations WHERE visitor_id = ? AND channel = ? ORDER BY updated_at DESC LIMIT 1").get(visitorId, channel);
    if (existing) convId = existing.id;
  }

  if (!convId) {
    convId = crypto.randomUUID();
    db.prepare('INSERT INTO conversations (id, visitor_id, channel, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(convId, visitorId || 'anon', channel || 'web', now, now);
  } else {
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
  }

  db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(convId, 'user', message, now);

  const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id').all(convId);
  const knowledge = searchKnowledge(message, 5);
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
    db.prepare('UPDATE conversations SET unresolved = 1 WHERE id = ?').run(convId);
  }
  return { conversationId: convId, reply, messageId: info.lastInsertRowid };
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, conversationId, visitorId } = req.body;
    if (!message) return res.status(400).json({ error: 'Falta mensaje' });
    const result = await processMessage({ message, conversationId, visitorId, channel: 'web' });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

async function sendWhatsApp(phone, text) {
  const cfg = loadConfig();
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
    const data = ev.data || ev;
    if (data?.key?.fromMe) return;
    const jid = data?.key?.remoteJid || '';
    if (!jid || jid.includes('@g.us')) return;
    const phone = jid.split('@')[0];
    const text = data.message?.conversation
      || data.message?.extendedTextMessage?.text
      || data.message?.imageMessage?.caption
      || '';
    if (!text.trim()) return;
    const result = await processMessage({ message: text, visitorId: `wa:${phone}`, channel: 'whatsapp' });
    await sendWhatsApp(phone, result.reply);
  } catch (err) { console.error('WA webhook error:', err); }
});

app.post('/api/whatsapp/test', requireAdmin, async (req, res) => {
  const { phone, text } = req.body;
  await sendWhatsApp(phone, text || 'Test desde el agente ✓');
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Agente corriendo en http://localhost:${PORT}`));
