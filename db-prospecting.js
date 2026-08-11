// db-prospecting.js — "La Máquina de Tu Primer Cliente" (Apify)
//
// Esquema para el motor interno de prospección en frío: scrapea negocios con
// Apify, los puntúa por dolor, audita su sitio, genera mensajes de outreach
// y hace seguimiento. Es una herramienta interna (para conseguir clientes de
// Lynkro), separada del motor conversacional multi-tenant — sigue el mismo
// patrón aditivo que db-commerce.js.

const softAlter = (db, sql) => { try { db.exec(sql) } catch {} }

export function applyProspectingSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prospect_batches (
      id TEXT PRIMARY KEY,
      niche TEXT NOT NULL,
      city TEXT NOT NULL,
      service_offered TEXT,
      apify_run_id TEXT,
      total_scraped INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running',
      error TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS prospects (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      name TEXT,
      phone TEXT,
      website TEXT,
      instagram TEXT,
      address TEXT,
      category TEXT,
      rating REAL,
      reviews_count INTEGER,
      has_hours INTEGER DEFAULT 0,
      has_website INTEGER DEFAULT 0,
      pain_score INTEGER DEFAULT 0,
      status TEXT DEFAULT 'new',
      created_at INTEGER,
      updated_at INTEGER,
      FOREIGN KEY(batch_id) REFERENCES prospect_batches(id)
    );
    CREATE INDEX IF NOT EXISTS idx_prospects_batch ON prospects(batch_id);
    CREATE INDEX IF NOT EXISTS idx_prospects_score ON prospects(pain_score DESC);
    CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status);

    CREATE TABLE IF NOT EXISTS prospect_audits (
      id TEXT PRIMARY KEY,
      prospect_id TEXT NOT NULL,
      load_time_ms INTEGER,
      mobile_friendly INTEGER,
      has_form INTEGER,
      has_booking_or_chat INTEGER,
      issues_json TEXT,
      audited_at INTEGER,
      FOREIGN KEY(prospect_id) REFERENCES prospects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_audits_prospect ON prospect_audits(prospect_id);

    CREATE TABLE IF NOT EXISTS prospect_messages (
      id TEXT PRIMARY KEY,
      prospect_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      stage TEXT NOT NULL,
      message_text TEXT,
      sent_at INTEGER,
      status TEXT DEFAULT 'draft',
      error TEXT,
      created_at INTEGER,
      FOREIGN KEY(prospect_id) REFERENCES prospects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_prospect ON prospect_messages(prospect_id);

    CREATE TABLE IF NOT EXISTS prospect_notes (
      id TEXT PRIMARY KEY,
      prospect_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER,
      FOREIGN KEY(prospect_id) REFERENCES prospects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_notes_prospect ON prospect_notes(prospect_id);
  `)

  // Additive columns for future-proofing without breaking existing rows.
  softAlter(db, "ALTER TABLE prospect_batches ADD COLUMN status TEXT DEFAULT 'running'")
  softAlter(db, 'ALTER TABLE prospect_batches ADD COLUMN error TEXT')
}
