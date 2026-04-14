import dotenv from 'dotenv';
dotenv.config({ override: true });
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { db, loadConfig, saveConfig, buildSystemPrompt } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (!process.env.ADMIN_PASSWORD || pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

app.get('/api/config/public', (req, res) => {
  const cfg = loadConfig();
  res.json({
    businessName: cfg.businessName,
    welcomeMessage: cfg.welcomeMessage,
    accentColor: cfg.accentColor
  });
});

app.get('/api/config', requireAdmin, (req, res) => res.json(loadConfig()));
app.post('/api/config', requireAdmin, (req, res) => res.json(saveConfig(req.body)));

app.get('/api/conversations', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 100').all();
  res.json(rows);
});

app.get('/api/conversations/:id', requireAdmin, (req, res) => {
  const msgs = db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(req.params.id);
  res.json(msgs);
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, conversationId, visitorId } = req.body;
    if (!message) return res.status(400).json({ error: 'Falta mensaje' });

    const cfg = loadConfig();
    let convId = conversationId;
    const now = Date.now();

    if (!convId) {
      convId = crypto.randomUUID();
      db.prepare('INSERT INTO conversations (id, visitor_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(convId, visitorId || 'anon', now, now);
    } else {
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
    }

    db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
      .run(convId, 'user', message, now);

    const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id').all(convId);

    const response = await client.messages.create({
      model: cfg.model || 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: buildSystemPrompt(cfg),
      messages: history.map(m => ({ role: m.role, content: m.content }))
    });

    const reply = response.content.map(c => c.text || '').join('').trim();

    db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
      .run(convId, 'assistant', reply, Date.now());

    res.json({ conversationId: convId, reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Agente corriendo en http://localhost:${PORT}`));
