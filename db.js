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

// ============================================================
// DEFAULT CONFIG (shape of per-company config)
// ============================================================
export const defaultConfig = {
  businessName: 'Mi Negocio',
  description: 'Describe aquí tu negocio.',
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
  smtpHost: '',
  smtpPort: 587,
  smtpUser: '',
  smtpPass: '',
  smtpFrom: '',
  smtpSecure: false,
  model: 'claude-haiku-4-5-20251001',
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
  agentName: 'Asistente',
  personality: 'Amable, resolutivo y cercano. Usa frases cortas y directas.',
  language: 'español',
  autoDetectLanguage: true,
  voiceExamples: '',
  defaultResponses: [
    { situation: 'Saludo inicial', response: '¡Hola! Bienvenido/a. ¿En qué puedo ayudarte hoy?' },
    { situation: 'No sé la respuesta', response: 'No tengo esa información a mano, pero puedo pasar tu consulta al equipo. ¿Me dejas tu contacto?' },
    { situation: 'Despedida', response: '¡Gracias por escribirnos! Que tengas un gran día.' },
    { situation: 'Cliente molesto', response: 'Entiendo tu frustración y lamento el inconveniente. Déjame ayudarte a resolverlo lo antes posible.' }
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

export function listCompanies() {
  return db.prepare('SELECT id, name, slug, active, created_at FROM companies ORDER BY created_at ASC').all();
}

export function getCompany(idOrSlug) {
  if (!idOrSlug) return null;
  const row = db.prepare('SELECT * FROM companies WHERE id = ? OR slug = ?').get(idOrSlug, idOrSlug);
  if (!row) return null;
  return {
    id: row.id, name: row.name, slug: row.slug, active: !!row.active, created_at: row.created_at,
    config: { ...defaultConfig, ...(row.config ? JSON.parse(row.config) : {}) }
  };
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

export function createCompany({ name, slug, id }) {
  const cid = id || uuid();
  const cleanSlug = (slug || name || cid).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || cid;
  const cfg = { ...defaultConfig, businessName: name || 'Nueva empresa' };
  try {
    db.prepare('INSERT INTO companies (id, name, slug, active, created_at, config) VALUES (?, ?, ?, 1, ?, ?)').run(
      cid, cfg.businessName, cleanSlug, Date.now(), JSON.stringify(cfg)
    );
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw new Error('El slug ya existe');
    throw err;
  }
  return getCompany(cid);
}

export function updateCompanyMeta(id, { name, slug, active }) {
  const fields = [], vals = [];
  if (name != null) { fields.push('name = ?'); vals.push(name); }
  if (slug != null) { fields.push('slug = ?'); vals.push(slug); }
  if (active != null) { fields.push('active = ?'); vals.push(active ? 1 : 0); }
  if (!fields.length) return getCompany(id);
  vals.push(id);
  db.prepare(`UPDATE companies SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return getCompany(id);
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

export function buildSystemPrompt(cfg) {
  const faqText = (cfg.faqs || []).map(f => `P: ${f.q}\nR: ${f.a}`).join('\n\n');
  const defaults = (cfg.defaultResponses || []).map(d => `• ${d.situation}: "${d.response}"`).join('\n');
  const office = isOfficeOpen(cfg);
  const officeBlock = cfg.officeHours?.enabled
    ? (office.open
        ? '\nESTADO ACTUAL: Dentro de horario de atención. El equipo humano está disponible si se requiere escalamiento.'
        : `\nESTADO ACTUAL: FUERA DE HORARIO DE ATENCIÓN.\n- Avisa amablemente al inicio que el equipo humano no está disponible ahora mismo.\n- Usa este mensaje como referencia: "${cfg.officeHours.offlineMessage}"\n- Si el cliente quiere hablar con un humano o necesita ayuda que no puedes resolver, ofrece tomar sus datos (nombre, contacto: email o teléfono, y el mensaje/motivo) para que el equipo lo contacte cuando regrese.\n- Confirma los datos recibidos antes de cerrar.`)
    : '';
  return `Eres "${cfg.agentName || 'Asistente'}", el agente de atención al cliente de "${cfg.businessName}".

IDIOMA: ${cfg.autoDetectLanguage
  ? `Detecta automáticamente el idioma del último mensaje del usuario y responde SIEMPRE en ese mismo idioma. Soportas como mínimo: español, inglés (English), francés (français), portugués (português) y hebreo (עברית). Si el usuario cambia de idioma durante la conversación, tú también cambias. Si no estás seguro del idioma, usa ${cfg.language || 'español'} por defecto.`
  : `Responde siempre en ${cfg.language || 'español'}.`}

PERSONALIDAD:
${cfg.personality || cfg.tone}

TONO DE VOZ: ${cfg.tone}
${cfg.voiceExamples ? `\nEJEMPLOS DE CÓMO HABLO (imita este estilo):\n${cfg.voiceExamples}\n` : ''}
DESCRIPCIÓN DEL NEGOCIO:
${cfg.description}

${cfg.products ? `PRODUCTOS/SERVICIOS:\n${cfg.products}\n` : ''}
${cfg.hours ? `HORARIO:\n${cfg.hours}\n` : ''}
${cfg.contact ? `CONTACTO:\n${cfg.contact}\n` : ''}
${faqText ? `PREGUNTAS FRECUENTES:\n${faqText}\n` : ''}
${defaults ? `\nRESPUESTAS PREDETERMINADAS (úsalas o adáptalas al contexto):\n${defaults}\n` : ''}
${officeBlock}
${cfg.systemPromptExtra ? `\nINSTRUCCIONES ADICIONALES:\n${cfg.systemPromptExtra}` : ''}

REGLAS:
- Responde solo sobre el negocio. Si te preguntan algo ajeno, redirige amablemente.
- Si no sabes algo, usa la respuesta predeterminada "No sé la respuesta" adaptándola.
- Mantén siempre la personalidad y tono definidos arriba.
- No inventes datos que no estén en la información proporcionada.`;
}
