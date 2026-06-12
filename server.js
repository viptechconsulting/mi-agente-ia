import dotenv from 'dotenv';
dotenv.config({ override: true });
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { webcrypto } from 'crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import {
  db, listCompanies, getCompany, getCompanyByToken
} from './db.js';
import { applyCommerceSchema } from './db-commerce.js';
import { billingRouter } from './routes/billing.js';
import { adminRouter } from './routes/admin.js';
import { chatRouter } from './routes/chat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const assetsDir = path.join(__dirname, 'data', 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
app.use('/assets', express.static(assetsDir, { maxAge: '1h' }));

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.get('/admin.html', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// USERS TABLE
// ============================================================
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  company_ids TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Apply commerce schema
applyCommerceSchema(db);

// ============================================================
// MOUNT ROUTERS
// ============================================================
app.use('/api/billing', billingRouter);
app.use('/api', adminRouter);
app.use('/api', chatRouter);

// Public route: demo page by share token (not under /api)
app.get('/demo/:token', (req, res) => {
  const c = getCompanyByToken(req.params.token);
  if (!c) return res.status(404).send('<h1 style="font-family:sans-serif;text-align:center;margin-top:80px;color:#9FB0C8;background:#0B0F14;padding:40px">Demo no encontrada</h1><style>body{background:#0B0F14;margin:0}</style>');
  if (!c.active) return res.status(403).send('<h1 style="font-family:sans-serif;text-align:center;margin-top:80px;color:#9FB0C8">Demo desactivada</h1>');
  if (c.expires_at && Date.now() > c.expires_at) return res.status(403).send('<h1 style="font-family:sans-serif;text-align:center;margin-top:80px;color:#9FB0C8">Demo expirada</h1>');
  res.sendFile(path.join(__dirname, 'public', 'demo.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Agente multi-empresa corriendo en http://localhost:${PORT}`));
