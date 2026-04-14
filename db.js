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
  agentName: 'Asistente',
  personality: 'Amable, resolutivo y cercano. Usa frases cortas y directas.',
  language: 'español',
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

export function buildSystemPrompt(cfg) {
  const faqText = (cfg.faqs || []).map(f => `P: ${f.q}\nR: ${f.a}`).join('\n\n');
  const defaults = (cfg.defaultResponses || []).map(d => `• ${d.situation}: "${d.response}"`).join('\n');
  return `Eres "${cfg.agentName || 'Asistente'}", el agente de atención al cliente de "${cfg.businessName}".

IDIOMA: Responde siempre en ${cfg.language || 'español'}.

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
${cfg.systemPromptExtra ? `\nINSTRUCCIONES ADICIONALES:\n${cfg.systemPromptExtra}` : ''}

REGLAS:
- Responde solo sobre el negocio. Si te preguntan algo ajeno, redirige amablemente.
- Si no sabes algo, usa la respuesta predeterminada "No sé la respuesta" adaptándola.
- Mantén siempre la personalidad y tono definidos arriba.
- No inventes datos que no estén en la información proporcionada.`;
}
