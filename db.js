import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

export const db = new Database(path.join(dataDir, 'agent.db'));
db.pragma('journal_mode = WAL');

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
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
    doc_id UNINDEXED,
    title,
    content,
    tokenize='unicode61 remove_diacritics 2'
  );
`);

try { db.exec('ALTER TABLE conversations ADD COLUMN unresolved INTEGER DEFAULT 0'); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN channel TEXT DEFAULT 'web'"); } catch {}

export const configPath = path.join(dataDir, 'config.json');

const defaultConfig = {
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

export function loadConfig() {
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }
  return { ...defaultConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
}

export function saveConfig(cfg) {
  const merged = { ...loadConfig(), ...cfg };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
  return merged;
}

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
