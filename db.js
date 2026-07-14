import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const dbPath = path.join(dataDir, 'agent.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

export const configPath = path.join(dataDir, 'config.json');

// ============================================================
// BASE SCHEMA (single-company era, preserved)
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    visitor_id TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT,
    role TEXT,
    content TEXT,
    created_at INTEGER,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
  );
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    source TEXT,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT,
    message_id INTEGER,
    rating INTEGER,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_rating_conv ON ratings(conversation_id);
  CREATE TABLE IF NOT EXISTS training_pairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT,
    answer TEXT,
    message_id INTEGER,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_training_msg ON training_pairs(message_id);
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
    doc_id UNINDEXED,
    title,
    content,
    tokenize='unicode61 remove_diacritics 2'
  );
`);

// Single-company era additive ALTERs (safe, idempotent)
const softAlter = (sql) => { try { db.exec(sql); } catch {} };
softAlter('ALTER TABLE conversations ADD COLUMN unresolved INTEGER DEFAULT 0');
softAlter("ALTER TABLE conversations ADD COLUMN channel TEXT DEFAULT 'web'");
softAlter('ALTER TABLE conversations ADD COLUMN lead_notified INTEGER DEFAULT 0');
softAlter('ALTER TABLE conversations ADD COLUMN escalated_notified INTEGER DEFAULT 0');
softAlter('ALTER TABLE conversations ADD COLUMN lead_email TEXT');
softAlter('ALTER TABLE conversations ADD COLUMN lead_phone TEXT');
softAlter('ALTER TABLE conversations ADD COLUMN lead_name TEXT');

// ============================================================
// MULTI-COMPANY SCHEMA (new)
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT,
    slug TEXT UNIQUE,
    active INTEGER DEFAULT 1,
    created_at INTEGER,
    config TEXT
  );
`);
// Add company_id to scoped tables (default='default' keeps legacy data intact)
softAlter("ALTER TABLE conversations ADD COLUMN company_id TEXT DEFAULT 'default'");
softAlter("ALTER TABLE documents ADD COLUMN company_id TEXT DEFAULT 'default'");
softAlter("ALTER TABLE training_pairs ADD COLUMN company_id TEXT DEFAULT 'default'");
softAlter('ALTER TABLE companies ADD COLUMN demo INTEGER DEFAULT 0');
softAlter('ALTER TABLE companies ADD COLUMN share_token TEXT');
softAlter('ALTER TABLE companies ADD COLUMN expires_at INTEGER');
softAlter('ALTER TABLE companies ADD COLUMN parent_company_id TEXT');
softAlter('ALTER TABLE conversations ADD COLUMN human_mode INTEGER DEFAULT 0');
softAlter('ALTER TABLE conversations ADD COLUMN retargeting_sent INTEGER DEFAULT 0');
softAlter('ALTER TABLE conversations ADD COLUMN flow_state TEXT');
softAlter('ALTER TABLE conversations ADD COLUMN web_alert_sent INTEGER DEFAULT 0');
softAlter('ALTER TABLE conversations ADD COLUMN do_not_contact INTEGER DEFAULT 0');

// ============================================================
// DEFAULT CONFIG (shape of per-company config)
// ============================================================
export const defaultConfig = {
  businessName: 'Mi Negocio',
  description: 'Describe aquí tu negocio.',
  industry: 'general',
  tone: 'profesional, cercano y claro',
  products: '',
  hours: '',
  contact: '',
  faqs: [],
  systemPromptExtra: '',
  welcomeMessage: '¡Hola! ¿En qué puedo ayudarte hoy?',
  accentColor: '#D4AF37',
  bgColor: '#0a0a0a',
  userBubbleColor: '#2a2205',
  logoUrl: '',
  avatarUrl: '',
  widgetPosition: 'right',
  notifyEmail: '',
  notifyOnLead: true,
  notifyOnEscalation: true,
  notifyOnReschedule: true,
  notifyOnCancel: true,
  notifyOnQualifiedLead: true,
  calendarProvider: null, // 'square' | 'ghl' | 'google' | null — which calendar API to use for reschedule/cancel tools
  smtpHost: '',
  smtpPort: 587,
  smtpUser: '',
  smtpPass: '',
  smtpFrom: '',
  smtpSecure: false,
  model: 'claude-haiku-4-5-20251001',
  plan: 'starter',
  waBaseUrl: '',
  waInstance: '',
  waApiKey: '',
  officeHours: {
    enabled: false,
    timezone: 'America/Mexico_City',
    offlineMessage: 'En este momento nuestro equipo humano no está disponible. Puedo intentar ayudarte yo, o si prefieres puedes dejarnos tu nombre, contacto y mensaje y te contactaremos en cuanto volvamos.',
    schedule: [
      { day: 1, enabled: true, open: '09:00', close: '18:00' },
      { day: 2, enabled: true, open: '09:00', close: '18:00' },
      { day: 3, enabled: true, open: '09:00', close: '18:00' },
      { day: 4, enabled: true, open: '09:00', close: '18:00' },
      { day: 5, enabled: true, open: '09:00', close: '18:00' },
      { day: 6, enabled: false, open: '10:00', close: '14:00' },
      { day: 0, enabled: false, open: '10:00', close: '14:00' }
    ]
  },
  quickReplies: [
    { label: 'Ver precios', message: 'Quiero ver los precios' },
    { label: 'Agendar llamada', message: 'Quisiera agendar una llamada' },
    { label: 'Ver FAQ', message: 'Muéstrame las preguntas frecuentes' }
  ],
  bookingUrl: '',
  igAccessToken: '',
  igVerifyToken: '',
  igPageId: '',
  igUsername: '',
  metaAppId: '',
  metaAppSecret: '',
  agentName: 'Asistente',
  personality: 'Amable, resolutivo y cercano. Usa frases cortas y directas.',
  language: 'español',
  autoDetectLanguage: true,
  voiceExamples: '',
  defaultResponses: [
    { situation: 'Saludo inicial', response: 'Hola, con gusto te ayudo. ¿Qué necesitas?' },
    { situation: 'No sé la respuesta', response: 'Eso no lo tengo, pero te puedo conectar con el equipo. ¿Me das tu contacto?' },
    { situation: 'Despedida', response: 'Gracias por escribirnos. Que tengas un buen día.' },
    { situation: 'Cliente molesto', response: 'Entiendo, lamento el inconveniente. Cuéntame qué pasó para ayudarte.' }
  ]
};

// ============================================================
// MIGRATION: single-company -> multi-company (SAFE, one-time)
// ============================================================
function runMigration() {
  const count = db.prepare('SELECT COUNT(*) as c FROM companies').get().c;
  if (count > 0) return; // Already migrated

  console.log('[migration] Starting single-company → multi-company migration...');

  // 1. Backup everything
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(dataDir, `backup-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  try {
    if (fs.existsSync(configPath)) fs.copyFileSync(configPath, path.join(backupDir, 'config.json'));
    if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, path.join(backupDir, 'agent.db'));
    const walPath = dbPath + '-wal', shmPath = dbPath + '-shm';
    if (fs.existsSync(walPath)) fs.copyFileSync(walPath, path.join(backupDir, 'agent.db-wal'));
    if (fs.existsSync(shmPath)) fs.copyFileSync(shmPath, path.join(backupDir, 'agent.db-shm'));
    console.log(`[migration] Backup created at ${backupDir}`);
  } catch (err) {
    console.error('[migration] Backup failed:', err.message);
    throw new Error('Aborting migration: backup failed. Data untouched.');
  }

  // 2. Load existing config.json as the first company
  let legacyCfg = {};
  if (fs.existsSync(configPath)) {
    try { legacyCfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  }
  const merged = { ...defaultConfig, ...legacyCfg };

  // 3. Insert as 'default' company
  db.prepare('INSERT INTO companies (id, name, slug, active, created_at, config) VALUES (?, ?, ?, 1, ?, ?)').run(
    'default',
    merged.businessName || 'Empresa Principal',
    'default',
    Date.now(),
    JSON.stringify(merged)
  );

  // 4. Normalize legacy rows to company_id='default'
  db.exec(`UPDATE conversations SET company_id='default' WHERE company_id IS NULL OR company_id=''`);
  db.exec(`UPDATE documents SET company_id='default' WHERE company_id IS NULL OR company_id=''`);
  db.exec(`UPDATE training_pairs SET company_id='default' WHERE company_id IS NULL OR company_id=''`);

  // 5. Write migration marker + docs
  fs.writeFileSync(path.join(dataDir, 'MIGRATION.md'), `# Multi-company migration

Migrated on: ${new Date().toISOString()}
Backup: ${backupDir}

## What changed
- New table: \`companies\` (id, name, slug, active, created_at, config JSON)
- Added column \`company_id\` to: conversations, documents, training_pairs
- Legacy data mapped to company_id='default'
- Legacy config.json preserved as companies.config for the 'default' company
- No data was deleted; config.json is kept as-is for safety

## Multi-company resolution order
1. Explicit companyId (admin header, widget attribute, ?companyId=, ?slug=)
2. WhatsApp instance name → matched against company config.waInstance
3. Host/subdomain → first segment matched against company.slug
4. Fallback → 'default' company
`);
  console.log('[migration] ✓ Complete. Legacy data preserved as company "default".');
}
runMigration();

// ============================================================
// COMPANY HELPERS
// ============================================================
function uuid() { return crypto.randomUUID(); }

export function listCompanies(opts = {}) {
  const where = opts.demoOnly ? 'WHERE demo = 1' : (opts.excludeDemo ? 'WHERE demo = 0' : '');
  return db.prepare(`SELECT id, name, slug, active, created_at, demo, share_token, expires_at, parent_company_id, commerce_pro_enabled, commerce_pro_status FROM companies ${where} ORDER BY created_at DESC`).all();
}

function rowToCompany(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, slug: row.slug,
    active: !!row.active, created_at: row.created_at,
    demo: !!row.demo, share_token: row.share_token,
    expires_at: row.expires_at, parent_company_id: row.parent_company_id,
    config: { ...defaultConfig, ...(row.config ? JSON.parse(row.config) : {}) }
  };
}

export function getCompany(idOrSlug) {
  if (!idOrSlug) return null;
  const row = db.prepare('SELECT * FROM companies WHERE id = ? OR slug = ? OR share_token = ?').get(idOrSlug, idOrSlug, idOrSlug);
  return rowToCompany(row);
}

export function getCompanyByToken(token) {
  if (!token) return null;
  return rowToCompany(db.prepare('SELECT * FROM companies WHERE share_token = ?').get(token));
}

export function findCompanyByWaInstance(instance) {
  if (!instance) return null;
  const rows = db.prepare('SELECT id, config FROM companies WHERE active = 1').all();
  for (const r of rows) {
    try {
      const cfg = JSON.parse(r.config || '{}');
      if (cfg.waInstance && cfg.waInstance === instance) return getCompany(r.id);
    } catch {}
  }
  return null;
}

export function createCompany({ name, slug, id, demo = false, parentCompanyId, expiresAt, configOverride }) {
  const cid = id || uuid();
  const cleanSlug = (slug || name || cid).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || cid;

  let baseCfg = { ...defaultConfig, businessName: name || 'Nueva empresa' };
  if (parentCompanyId) {
    const parent = getCompany(parentCompanyId);
    if (parent) baseCfg = { ...parent.config, businessName: name || parent.config.businessName + ' (demo)' };
  }
  if (configOverride) baseCfg = { ...baseCfg, ...configOverride };

  const shareToken = demo ? crypto.randomBytes(18).toString('base64url') : null;

  try {
    db.prepare('INSERT INTO companies (id, name, slug, active, created_at, config, demo, share_token, expires_at, parent_company_id) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)').run(
      cid, baseCfg.businessName, cleanSlug, Date.now(), JSON.stringify(baseCfg),
      demo ? 1 : 0, shareToken, expiresAt || null, parentCompanyId || null
    );
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw new Error('El slug ya existe');
    throw err;
  }

  // If cloning from parent, also copy knowledge base documents
  if (parentCompanyId && demo) {
    const docs = db.prepare('SELECT id, title, source FROM documents WHERE company_id = ?').all(parentCompanyId);
    docs.forEach(d => {
      const chunks = db.prepare('SELECT content FROM chunks WHERE doc_id = ?').all(d.id);
      if (!chunks.length) return;
      const newDoc = db.prepare('INSERT INTO documents (title, source, created_at, company_id) VALUES (?, ?, ?, ?)').run(d.title, d.source, Date.now(), cid);
      const ins = db.prepare('INSERT INTO chunks (doc_id, title, content) VALUES (?, ?, ?)');
      chunks.forEach(c => ins.run(newDoc.lastInsertRowid, d.title, c.content));
    });
  }

  return getCompany(cid);
}

export function updateCompanyMeta(id, { name, slug, active, expires_at }) {
  const fields = [], vals = [];
  if (name != null) { fields.push('name = ?'); vals.push(name); }
  if (slug != null) { fields.push('slug = ?'); vals.push(slug); }
  if (active != null) { fields.push('active = ?'); vals.push(active ? 1 : 0); }
  if (expires_at !== undefined) { fields.push('expires_at = ?'); vals.push(expires_at); }
  if (!fields.length) return getCompany(id);
  vals.push(id);
  db.prepare(`UPDATE companies SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return getCompany(id);
}

export function regenerateShareToken(id) {
  const tok = crypto.randomBytes(18).toString('base64url');
  db.prepare('UPDATE companies SET share_token = ? WHERE id = ?').run(tok, id);
  return tok;
}

export function seedSampleContent(companyId) {
  const cfg = loadConfig(companyId);
  const sampleDocs = [
    {
      title: 'Preguntas frecuentes',
      content: 'P: ¿Cuál es su horario de atención?\nR: Atendemos de lunes a viernes de 9am a 6pm.\n\nP: ¿Cómo puedo contactarlos?\nR: Puedes escribirnos por este chat, WhatsApp o email.\n\nP: ¿Tienen servicio a domicilio?\nR: Sí, ofrecemos envíos a toda la ciudad.'
    },
    {
      title: 'Política de devoluciones',
      content: 'Aceptamos devoluciones dentro de los 30 días posteriores a la compra. El producto debe estar en su empaque original y sin uso. Para iniciar una devolución, contacta a nuestro equipo.'
    },
    {
      title: 'Proceso de contratación',
      content: `Así funciona nuestro proceso con ${cfg.businessName}: 1) Nos cuentas lo que necesitas. 2) Te enviamos una propuesta personalizada. 3) Tras aceptar, iniciamos el servicio en 48 horas. 4) Seguimiento semanal para asegurar resultados.`
    }
  ];
  const now = Date.now();
  sampleDocs.forEach(d => {
    const info = db.prepare('INSERT INTO documents (title, source, created_at, company_id) VALUES (?, ?, ?, ?)').run(d.title, 'sample', now, companyId);
    const ins = db.prepare('INSERT INTO chunks (doc_id, title, content) VALUES (?, ?, ?)');
    const size = 800, overlap = 100, clean = d.content.replace(/\s+/g, ' ').trim();
    for (let i = 0; i < clean.length; i += size - overlap) ins.run(info.lastInsertRowid, d.title, clean.slice(i, i + size));
  });

  // Sample conversations for demo purposes
  const sampleConvos = [
    { user: '¿Cuál es su horario?', assistant: 'Atendemos de lunes a viernes de 9am a 6pm. ¿Hay algo más en lo que pueda ayudarte?' },
    { user: '¿Hacen envíos?', assistant: 'Sí, enviamos a toda la ciudad. ¿Te gustaría más detalles?' }
  ];
  sampleConvos.forEach(c => {
    const convId = uuid();
    db.prepare('INSERT INTO conversations (id, visitor_id, channel, created_at, updated_at, company_id) VALUES (?, ?, ?, ?, ?, ?)').run(convId, 'demo-visitor', 'web', now, now, companyId);
    db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(convId, 'user', c.user, now);
    db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(convId, 'assistant', c.assistant, now + 1);
  });
}

export function deleteCompany(id) {
  if (id === 'default') throw new Error('No se puede eliminar la empresa por defecto');
  // Also clean scoped data
  db.prepare('DELETE FROM ratings WHERE conversation_id IN (SELECT id FROM conversations WHERE company_id = ?)').run(id);
  db.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE company_id = ?)').run(id);
  db.prepare('DELETE FROM conversations WHERE company_id = ?').run(id);
  db.prepare('DELETE FROM chunks WHERE doc_id IN (SELECT id FROM documents WHERE company_id = ?)').run(id);
  db.prepare('DELETE FROM documents WHERE company_id = ?').run(id);
  db.prepare('DELETE FROM training_pairs WHERE company_id = ?').run(id);
  db.prepare('DELETE FROM companies WHERE id = ?').run(id);
}

// ============================================================
// PER-COMPANY CONFIG API
// ============================================================
export function loadConfig(companyId = 'default') {
  const c = getCompany(companyId);
  if (c) return c.config;
  // Fallback (should not happen after migration)
  return { ...defaultConfig };
}

export function saveConfig(companyId, partial) {
  const c = getCompany(companyId);
  if (!c) throw new Error('Empresa no encontrada');
  const merged = { ...c.config, ...partial };
  db.prepare('UPDATE companies SET name = ?, config = ? WHERE id = ?').run(
    merged.businessName || c.name, JSON.stringify(merged), companyId
  );
  // Also keep legacy config.json in sync for default company (safety net, optional)
  if (companyId === 'default') {
    try { fs.writeFileSync(configPath, JSON.stringify(merged, null, 2)); } catch {}
  }
  return merged;
}

// ============================================================
// SECOND EXAMPLE COMPANY (seed once, only if none exists yet besides default)
// ============================================================
function seedSecondCompany() {
  const c = db.prepare("SELECT COUNT(*) as c FROM companies WHERE id != 'default'").get().c;
  if (c > 0) return;
  try {
    const cfg = {
      ...defaultConfig,
      businessName: 'Demo Wellness Clinic',
      description: 'Clínica wellness de ejemplo — segunda empresa de prueba del sistema multi-tenant.',
      agentName: 'Luna',
      accentColor: '#7bb342',
      bgColor: '#0a1a0a',
      userBubbleColor: '#1a2a0a',
      welcomeMessage: '¡Hola! Soy Luna, tu asistente de Demo Wellness. ¿Cómo te puedo ayudar?',
      personality: 'Cálida, empática, enfocada en bienestar.',
      quickReplies: [
        { label: 'Reservar cita', message: 'Quiero reservar una cita' },
        { label: 'Ver tratamientos', message: 'Qué tratamientos ofrecen?' }
      ]
    };
    const id = uuid();
    db.prepare('INSERT INTO companies (id, name, slug, active, created_at, config) VALUES (?, ?, ?, 1, ?, ?)').run(
      id, cfg.businessName, 'demo-wellness', Date.now(), JSON.stringify(cfg)
    );
    console.log('[seed] Segunda empresa de ejemplo creada: demo-wellness');
  } catch (err) { console.error('[seed] Failed:', err.message); }
}
seedSecondCompany();

// Owner accounts always have Commerce Pro active — no restrictions
const OWNER_COMPANY_IDS = [
  'e26e29d3-b573-4bf7-8b72-70446b5e05b0', // Lynkro.io
  'a858eb9c-efd5-4274-b183-4072e8ab3fcd',  // Vip Tech Consulting
];
const activateOwners = db.prepare(
  'UPDATE companies SET commerce_pro_enabled=1, commerce_pro_status=? WHERE id=?'
);
OWNER_COMPANY_IDS.forEach(id => activateOwners.run('active', id));

// ============================================================
// PROMPT / OFFICE HOURS (unchanged logic)
// ============================================================
export function isOfficeOpen(cfg) {
  const oh = cfg.officeHours;
  if (!oh || !oh.enabled) return { open: true, schedule: oh };
  try {
    const tz = oh.timezone || 'UTC';
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
    const wd = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 }[parts.find(p=>p.type==='weekday').value];
    const hh = parts.find(p=>p.type==='hour').value;
    const mm = parts.find(p=>p.type==='minute').value;
    const nowMin = parseInt(hh)*60 + parseInt(mm);
    const day = (oh.schedule || []).find(d => d.day === wd);
    if (!day || !day.enabled) return { open: false, schedule: oh };
    const [oH,oM] = day.open.split(':').map(Number);
    const [cH,cM] = day.close.split(':').map(Number);
    const openMin = oH*60+oM, closeMin = cH*60+cM;
    return { open: nowMin >= openMin && nowMin < closeMin, schedule: oh };
  } catch { return { open: true, schedule: oh }; }
}

function stripEmoji(text) {
  return (text || '').replace(/[\u{1F300}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]/gu, '').replace(/\s{2,}/g, ' ').trim();
}

export function buildSystemPrompt(cfg) {
  const faqText = (cfg.faqs || []).map(f => `P: ${f.q}\nR: ${f.a}`).join('\n\n');
  const defaults = (cfg.defaultResponses || []).map(d => `- ${d.situation}: "${d.response}"`).join('\n');
  const office = isOfficeOpen(cfg);
  const tz = cfg.officeHours?.timezone || 'America/New_York';
  const nowStr = new Date().toLocaleString('es-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  const officeBlock = cfg.officeHours?.enabled
    ? (office.open
        ? '\nESTADO: Dentro de horario de atención.'
        : `\nESTADO: FUERA DE HORARIO. Avisa que el equipo humano no está disponible ahora. Referencia: "${cfg.officeHours.offlineMessage}". Si insisten en hablar con un humano, ofrece tomar nombre + contacto para que el equipo lo llame cuando vuelva.`)
    : '';

  // Strip emojis from voice examples so Claude doesn't copy them
  const voiceClean = cfg.voiceExamples ? stripEmoji(cfg.voiceExamples) : '';

  return `Eres "${cfg.agentName || 'Asistente'}", asistente de "${cfg.businessName}". Escribes como una persona real en WhatsApp: directo, corto, natural.

━━━ FORMATO — LEE ESTO ANTES DE RESPONDER ━━━
NUNCA hagas esto (ejemplos de lo que está MAL):
✗ "Perfecto. El SEO ayuda a posicionar tu negocio en Google generando tráfico orgánico..."
✗ "Ofrecemos SEO, diseño web, Google Ads, Facebook, Instagram, LinkedIn y automatización con IA..."
✗ "¡Claro! Con gusto te explico. Tenemos los siguientes servicios: 1) SEO 2) Diseño..."
✗ Cualquier respuesta de más de 2 oraciones
✗ Empezar con: Perfecto / Claro / Por supuesto / Excelente / Entendido / Bienvenido / Hola

SIEMPRE haz esto (ejemplos de lo que está BIEN):
✓ Usuario: "¿qué servicios tienen?" → "Hacemos SEO, publicidad digital y automatización con IA. ¿Cuál te interesa?"
✓ Usuario: "SEO" → "¿Tu negocio ya aparece en Google o estás empezando desde cero?"
✓ Usuario: "quiero una cita" → "Claro, ¿para qué servicio sería?"
✓ Si el usuario escribe 3 palabras, responde en 1 oración máximo.

REGLAS DURAS (sin excepción):
- Máximo 2 oraciones por respuesta. Una sola pregunta. Sin listas. Sin markdown. Sin emojis.
- Cuando te pregunten por servicios: menciona máximo 3, en una sola oración, separados por coma.
- Nunca expliques lo que es un servicio a menos que el usuario pregunte específicamente.
- PROHIBIDO VOSEO: nunca uses tenés/recibís/podés/querés/hacés/contame/andá/vení — usa tienes/recibes/puedes/quieres/haces/cuéntame/ve/ven.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FECHA Y HORA ACTUAL: ${nowStr} (zona horaria ${tz}). NUNCA calcules ni menciones cuánto tiempo falta para una cita, llamada o evento (nada de "en 10 minutos", "en una hora") — decí solo la hora acordada en punto (ej. "nos vemos a las 9 AM"). Si el usuario te corrige la hora, usa la hora que él confirme.

IDIOMA: ${cfg.autoDetectLanguage
  ? `Detecta el idioma del usuario y responde en ese idioma. Si es español, usa español latino neutro: tuteo (tú), sin voseo, sin modismos de ningún país.`
  : `Responde siempre en ${cfg.language || 'español'}${(cfg.language || '').toLowerCase().includes('espa') ? ' latino neutro: tuteo (tú), sin voseo, sin modismos regionales' : ''}.`}

PERSONALIDAD: ${cfg.personality || cfg.tone}

${voiceClean ? `ESTILO (solo actitud, no copiés el formato):\n${voiceClean}\n` : ''}
NEGOCIO: ${cfg.description || ''}
${cfg.products ? `SERVICIOS QUE OFRECE:\n${cfg.products}\n` : ''}
${cfg.hours ? `HORARIO: ${cfg.hours}\n` : ''}
${cfg.contact ? `CONTACTO: ${cfg.contact}\n` : ''}
${faqText ? `PREGUNTAS FRECUENTES:\n${faqText}\n` : ''}
${officeBlock}
${cfg.systemPromptExtra ? `INSTRUCCIONES ADICIONALES:\n${cfg.systemPromptExtra}\n` : ''}
${cfg.bookingUrl
  ? `CITAS: Si el usuario quiere agendar, incluye este link al final (solo el link, texto plano, nunca inventes otro): ${cfg.bookingUrl}\nUna fecha/hora que el usuario menciona en el chat NO es una cita confirmada — solo queda confirmada cuando agenda en ese link. No la des por agendada ni digas "nos vemos" hasta que lo confirme así.`
  : `CITAS: No tienes un link de agendamiento configurado. Si el usuario quiere agendar, dile que el equipo lo contactará para coordinar — no inventes un link ni fijes fecha/hora tú mismo.`}
NUNCA prometas acciones que el sistema no ejecuta realmente: no digas que "enviarás" un link de Zoom/Meet, una confirmación por correo, o un recordatorio a una hora específica, a menos que eso ya esté pasando de verdad (por ejemplo, un email real disparado por el sistema). Si no estás seguro de que algo se envía automáticamente, no lo prometas.
CAPTURA DE DATOS (sigue este flujo en todas las conversaciones):
1. En tu SEGUNDA respuesta (no en la primera), pregunta el nombre de forma natural: "¿Con quién tengo el gusto?" o "¿Me dices tu nombre?" — elige según el contexto.
2. Cuando el cliente diga su nombre, úsalo ocasionalmente para personalizar (sin exagerar).
3. Cuando la conversación haya avanzado y el cliente muestre interés real (3+ intercambios), pide el email así: "Para enviarte un resumen con más detalle, ¿me das tu correo?" — solo una vez, si no responde no insistas.
4. Si el canal es WhatsApp o Instagram y ya conoces el nombre del perfil, no preguntes de nuevo.
REGLA FINAL: Respondé solo sobre el negocio. Si no sabés algo, decí "eso no lo tengo, pero te conecto con el equipo".`;
}

// ============================================================
// SERVER CONFIG — global key/value store (credentials, etc.)
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS server_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`)

export function getServerSetting(key) {
  const row = db.prepare('SELECT value FROM server_config WHERE key = ?').get(key)
  return row ? row.value : null
}

export function setServerSetting(key, value) {
  if (value === null || value === undefined || value === '') {
    db.prepare('DELETE FROM server_config WHERE key = ?').run(key)
  } else {
    db.prepare('INSERT INTO server_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
  }
}
