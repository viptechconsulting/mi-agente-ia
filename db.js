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
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
    doc_id UNINDEXED,
    title,
    content,
    tokenize='unicode61 remove_diacritics 2'
  );
`);

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
  model: 'claude-haiku-4-5-20251001'
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
  return `Eres el agente de atención al cliente de "${cfg.businessName}".

DESCRIPCIÓN DEL NEGOCIO:
${cfg.description}

TONO: ${cfg.tone}

${cfg.products ? `PRODUCTOS/SERVICIOS:\n${cfg.products}\n` : ''}
${cfg.hours ? `HORARIO:\n${cfg.hours}\n` : ''}
${cfg.contact ? `CONTACTO:\n${cfg.contact}\n` : ''}
${faqText ? `PREGUNTAS FRECUENTES:\n${faqText}\n` : ''}
${cfg.systemPromptExtra ? `\nINSTRUCCIONES ADICIONALES:\n${cfg.systemPromptExtra}` : ''}

REGLAS:
- Responde solo sobre el negocio. Si te preguntan algo ajeno, redirige amablemente.
- Si no sabes algo, dilo y sugiere contactar al negocio directamente.
- Sé breve y útil. No inventes datos que no estén arriba.`;
}
