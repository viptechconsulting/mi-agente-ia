import dotenv from 'dotenv';
dotenv.config({ override: true });
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
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
import { commerceRouter, webhookRouter } from './routes/commerce.js';
import './jobs/sync-scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const assetsDir = path.join(__dirname, 'data', 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
app.use('/assets', express.static(assetsDir, { maxAge: '1h' }));

// Webhook routes that verify an HMAC signature over the raw request body
// MUST be reached before the global express.json() parser below — once a
// body-parser has consumed the body, a later express.raw() on these routes
// becomes a no-op and signature verification always fails (see CN-019).
app.use('/api/commerce/webhooks', webhookRouter);
app.use('/api/billing/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.get(['/admin', '/admin.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Public route: onboarding page for Discovery Call
app.get('/onboarding-discovery.html', (req, res) => {
  const bookingUrl = process.env.DISCOVERY_CALL_BOOKING_URL || ''
  const file = fs.readFileSync(path.join(__dirname, 'public', 'onboarding-discovery.html'), 'utf8')
  const injected = file.replace(
    '<meta charset="UTF-8">',
    `<meta charset="UTF-8">\n  <meta name="booking-url" content="${bookingUrl}">`
  )
  res.setHeader('Content-Type', 'text/html')
  res.setHeader('Cache-Control', 'no-store')
  res.send(injected)
})

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
// RATE LIMITING
// ============================================================
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos, intenta de nuevo más tarde' }
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, intenta de nuevo en un momento' }
});
app.use('/api/auth/login', loginLimiter);
app.use('/api/chat', chatLimiter);

// ============================================================
// MOUNT ROUTERS
// ============================================================
// (webhookRouter and the Stripe webhook path are mounted earlier, ahead of express.json())
app.use('/api/commerce', commerceRouter);
app.use('/api/billing', billingRouter);
app.use('/api', adminRouter);
app.use('/api', chatRouter);

// Public route: demos gallery (pitch page)
// Public route: demos gallery (pitch page)
app.get('/demos', (_req, res) => {
  function stripEmoji(s) {
    return (s || '').replace(/[^\x00-\x7E\xA0-ɏ ]/g, '').replace(/\s{2,}/g, ' ').trim();
  }
  function detectIndustry(name) {
    const n = name.toLowerCase();
    if (/dental|dent|odont|tooth/.test(n)) return 'dental';
    if (/gym|fitness|sport|yoga|pilates/.test(n)) return 'fitness';
    if (/salon|hair|nail|barber|beauty/.test(n)) return 'beauty';
    if (/restaur|cafe|bar|food/.test(n)) return 'restaurant';
    if (/real.estat|inmobil|propert|realty/.test(n)) return 'realestate';
    if (/hotel|hospit|resort/.test(n)) return 'hospitality';
    if (/servi|repair|plumb|electr|clean|hvac|jardin|maint/.test(n)) return 'homeservices';
    if (/spa|medspa|medi|aesth|clinic|botox|laser|glow|wellness/.test(n)) return 'medspa';
    return 'default';
  }
  const ICONS = {
    dental:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 3C13.6 3 12.5 4.2 12 5c-.5-.8-1.6-2-3.5-2C6.1 3 4.5 5 4.5 7.5c0 2.1 1.1 3.9 2.8 5L6 20c-.3 1.7.6 3 2 3 .9 0 1.8-.6 2.5-1.7C11.2 22.4 12 23 13 23c.9 0 1.7-.6 2.5-1.7C16.2 22.4 17.1 23 18 23c1.4 0 2.3-1.3 2-3l-1.3-7.5c1.7-1.1 2.8-2.9 2.8-5C21.5 5 19.9 3 18 3c-1.9 0-3 1.2-3.5 2-.5-.8-1.6-2-3-2z"/></svg>',
    medspa:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>',
    homeservices:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    restaurant:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/></svg>',
    realestate:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    fitness:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    beauty:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>',
    hospitality:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/></svg>',
    default:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="9" width="18" height="13" rx="1"/><path d="M8 9V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v4"/><line x1="12" y1="13" x2="12" y2="17"/><line x1="10" y1="15" x2="14" y2="15"/></svg>'
  };
  const LABELS = {dental:'Dental',medspa:'Medical Spa',homeservices:'Home Services',restaurant:'Restaurant',realestate:'Real Estate',fitness:'Fitness',beauty:'Beauty & Salon',hospitality:'Hospitality',default:'Business AI'};

  const demos = listCompanies({ demoOnly: true }).filter(c => c.active && c.share_token);
  const cards = demos.map(c => {
    let cfg = {};
    try { cfg = JSON.parse(db.prepare('SELECT config FROM companies WHERE id=?').get(c.id)?.config || '{}'); } catch {}
    const name = cfg.businessName || c.name;
    const desc = cfg.description || '';
    const agentName = cfg.agentName || 'Asistente';
    const expired = c.expires_at && Date.now() > c.expires_at;
    const url = '/demo/' + c.share_token;
    const iKey = detectIndustry(name);
    const icon = ICONS[iKey] || ICONS.default;
    const label = LABELS[iKey] || 'Business AI';
    const caps = (cfg.quickReplies || []).slice(0, 4).map(q => stripEmoji(q.label)).filter(Boolean);
    const logoUrl = cfg.logoUrl || '';
    const iconHtml = logoUrl
      ? '<img src="' + logoUrl + '" alt="' + name + '" class="card-logo">'
      : '<div class="card-icon">' + icon + '</div>';
    const capHtml = caps.length
      ? '<div class="cap-list"><p class="cap-label" data-i18n="cap-label">Puedes preguntar sobre</p>' + caps.map(cap => '<div class="cap-item"><span class="cap-dot"></span>' + cap + '</div>').join('') + '</div>'
      : '';
    const statusHtml = expired
      ? '<span class="status-dot"></span><span data-i18n="inactive">Inactivo</span>'
      : '<span class="status-dot live"></span><span><span class="agent-word" data-i18n="agent-word">Agente</span> <strong>' + agentName + '</strong></span>';
    const ctaHtml = expired
      ? '<div class="card-cta disabled" data-i18n="cta-unavail">Demo no disponible</div>'
      : '<a href="' + url + '" target="_blank" class="card-cta"><span data-i18n="cta-live">Probar agente en vivo</span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></a>';
    return '<div class="demo-card' + (expired ? ' expired' : '') + '">'
      + '<div class="card-header">' + iconHtml
      + '<div class="card-header-info"><span class="industry-badge">' + label + '</span>'
      + '<h3 class="card-name">' + name + '</h3>'
      + '<div class="agent-status">' + statusHtml + '</div></div></div>'
      + (desc ? '<p class="card-desc">' + desc.slice(0, 120) + (desc.length > 120 ? '…' : '') + '</p>' : '')
      + capHtml
      + '<div class="card-footer">' + ctaHtml + '</div>'
      + '</div>';
  }).join('');

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live Demos — Lynkro.io</title>
<meta name="description" content="Try AI agents for your industry. See how Lynkro automates customer engagement.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#07090D;--surface:#0D1420;--surface2:#111C2B;--border:rgba(255,255,255,.07);--green:#27F59B;--blue:#3BA5FF;--text:#FFFFFF;--muted:#8094AE;--font:'Poppins',system-ui,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh;-webkit-font-smoothing:antialiased}
nav{position:sticky;top:0;z-index:99;display:flex;align-items:center;justify-content:space-between;padding:14px 48px;background:rgba(7,9,13,.9);backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}
.nav-logo{display:block}
.nav-logo img{height:34px;display:block}
.nav-right{display:flex;align-items:center;gap:12px}
.lang-switcher{display:flex;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.lang-btn{padding:7px 13px;font-family:var(--font);font-size:.72rem;font-weight:700;color:var(--muted);background:transparent;border:none;cursor:pointer;transition:all .15s;letter-spacing:.04em}
.lang-btn.active{background:rgba(255,255,255,.07);color:var(--text)}
.nav-cta{display:inline-flex;align-items:center;gap:8px;background:var(--green);color:#000;font-family:var(--font);font-weight:700;font-size:.82rem;padding:10px 24px;border-radius:8px;text-decoration:none;transition:opacity .15s}
.nav-cta:hover{opacity:.85}
.hero{max-width:780px;margin:0 auto;padding:80px 24px 56px;text-align:center}
.pill{display:inline-flex;align-items:center;gap:8px;font-size:.68rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--green);border:1px solid rgba(39,245,155,.22);border-radius:100px;padding:6px 16px;margin-bottom:28px}
.pill-dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:blink 2s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
h1{font-size:clamp(2rem,4.2vw,3.1rem);font-weight:800;line-height:1.1;letter-spacing:-1.5px;margin-bottom:18px}
h1 em{font-style:normal;color:var(--green)}
.hero p{font-size:.97rem;color:var(--muted);line-height:1.78;max-width:540px;margin:0 auto}
.hero-note{font-size:.74rem;color:rgba(128,148,174,.45);margin-top:10px}
.channels{max-width:1000px;margin:0 auto 64px;padding:0 24px}
.tab-header{display:flex;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:12px 12px 0 0;padding:4px}
.tab-btn{flex:1;display:flex;align-items:center;justify-content:center;gap:9px;padding:12px 16px;border:none;border-radius:9px;font-family:var(--font);font-size:.82rem;font-weight:600;color:var(--muted);background:transparent;cursor:pointer;transition:all .18s;white-space:nowrap}
.tab-btn svg{width:18px;height:18px;flex-shrink:0}
.tab-btn.active{background:var(--surface2);color:var(--text);box-shadow:0 2px 8px rgba(0,0,0,.3)}
.tab-btn.active .tab-icon-wa{color:#25D366}
.tab-btn.active .tab-icon-ig{color:#E1306C}
.tab-btn.active .tab-icon-web{color:var(--blue)}
.tab-panel{display:none;padding:28px 24px;background:var(--surface);border:1px solid var(--border);border-radius:0 0 12px 12px;border-top:none}
.tab-panel.active{display:grid;grid-template-columns:1fr auto;gap:32px;align-items:center}
.tab-panel-desc{font-size:.9rem;color:var(--muted);line-height:1.72;max-width:560px}
.tab-panel-desc strong{color:var(--text);font-weight:600}
.tab-features{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.tab-feature{display:flex;align-items:center;gap:6px;font-size:.72rem;font-weight:600;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:100px;padding:5px 12px;white-space:nowrap}
.tab-feature svg{width:13px;height:13px;flex-shrink:0}
.features{max-width:1440px;margin:0 auto;padding:0 40px 80px}
.features-header{text-align:center;max-width:640px;margin:0 auto 60px}
.features-header .pill{margin-bottom:20px}
.features-header h2{font-size:clamp(1.6rem,3vw,2.4rem);font-weight:800;line-height:1.15;letter-spacing:-1px;margin-bottom:16px}
.features-header p{font-size:.9rem;color:var(--muted);line-height:1.72}
.features-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.feat-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px;display:flex;flex-direction:column;gap:14px}
.feat-card.highlight{border-color:rgba(39,245,155,.2);background:linear-gradient(135deg,rgba(39,245,155,.04),var(--surface))}
.feat-badge{display:inline-flex;align-items:center;gap:5px;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:3px 9px;border-radius:100px}
.feat-badge.star{background:rgba(39,245,155,.1);color:var(--green);border:1px solid rgba(39,245,155,.2)}
.feat-badge.new{background:rgba(59,165,255,.1);color:var(--blue);border:1px solid rgba(59,165,255,.2)}
.feat-badge.std{background:rgba(255,255,255,.06);color:var(--muted);border:1px solid var(--border)}
.feat-title{font-size:.98rem;font-weight:700;line-height:1.3;color:var(--text)}
.feat-desc{font-size:.8rem;color:var(--muted);line-height:1.68}
.feat-checks{display:flex;flex-direction:column;gap:7px}
.feat-check{display:flex;align-items:flex-start;gap:9px;font-size:.78rem;color:var(--muted);line-height:1.4}
.feat-check-icon{width:15px;height:15px;border-radius:50%;background:rgba(39,245,155,.12);color:var(--green);display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.feat-check-icon svg{width:8px;height:8px}
.feat-result{font-size:.78rem;font-weight:600;color:var(--green);padding-top:4px;border-top:1px solid rgba(39,245,155,.12);margin-top:4px}
.divider{max-width:1440px;margin:0 auto 24px;padding:0 40px;display:flex;align-items:center;gap:16px}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--border)}
.divider span{font-size:.64rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:rgba(128,148,174,.4);white-space:nowrap}
.demo-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;max-width:1440px;margin:0 auto;padding:0 40px 72px}
.demo-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;display:flex;flex-direction:column;gap:14px;transition:border-color .2s,transform .2s,box-shadow .2s}
.demo-card:not(.expired):hover{border-color:rgba(39,245,155,.22);transform:translateY(-4px);box-shadow:0 18px 48px rgba(0,0,0,.5)}
.demo-card.expired{opacity:.4;pointer-events:none}
.card-header{display:flex;align-items:flex-start;gap:13px}
.card-logo{width:48px;height:48px;border-radius:10px;object-fit:contain;background:var(--border);flex-shrink:0}
.card-icon{width:48px;height:48px;border-radius:10px;background:rgba(39,245,155,.08);color:var(--green);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.card-icon svg{width:22px;height:22px}
.card-header-info{flex:1;min-width:0}
.industry-badge{display:inline-block;font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:2px 7px;border-radius:100px;background:rgba(59,165,255,.1);color:var(--blue);border:1px solid rgba(59,165,255,.2);margin-bottom:5px}
.card-name{font-size:.92rem;font-weight:700;line-height:1.3;color:var(--text);margin-bottom:4px}
.agent-status{display:flex;align-items:center;gap:6px;font-size:.73rem;color:var(--muted)}
.agent-status strong{color:#C4D4E0;font-weight:600}
.status-dot{width:6px;height:6px;border-radius:50%;background:#374151;flex-shrink:0}
.status-dot.live{background:var(--green);animation:blink 2.5s ease-in-out infinite}
.card-desc{font-size:.78rem;color:#5A7A96;line-height:1.65}
.cap-list{display:flex;flex-direction:column;gap:4px;flex:1}
.cap-label{font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:rgba(128,148,174,.4);margin-bottom:5px}
.cap-item{display:flex;align-items:center;gap:7px;font-size:.76rem;color:var(--muted)}
.cap-dot{width:3px;height:3px;border-radius:50%;background:var(--green);flex-shrink:0;opacity:.7}
.card-footer{margin-top:auto}
.card-cta{display:flex;align-items:center;justify-content:center;gap:7px;padding:11px 16px;border-radius:8px;font-size:.8rem;font-weight:700;text-decoration:none;font-family:var(--font);background:var(--green);color:#000;border:none;transition:opacity .15s;cursor:pointer}
.card-cta:hover{opacity:.85}
.card-cta.disabled{background:rgba(255,255,255,.05);color:#3a4a5a;cursor:default;border:1px solid var(--border);font-size:.76rem}
footer{border-top:1px solid var(--border);padding:28px 48px}
.footer-inner{max-width:1440px;margin:0 auto}
.footer-bottom{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px}
.footer-logo-img{height:28px;display:block;opacity:.8}
.footer-copy{font-size:.7rem;color:rgba(128,148,174,.4)}
.footer-socials{display:flex;gap:18px}
.footer-socials a{color:rgba(128,148,174,.45);transition:color .15s;display:block}
.footer-socials a:hover{color:var(--text)}
.footer-socials svg{width:16px;height:16px;display:block}
@media(max-width:1200px){.demo-grid{grid-template-columns:repeat(2,1fr)}.features-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:768px){nav{padding:14px 20px}.nav-right{gap:8px}.nav-cta{padding:8px 14px;font-size:.76rem}.lang-btn{padding:6px 10px}.hero{padding:52px 20px 44px}.channels{padding:0 20px;margin-bottom:48px}.divider{padding:0 20px}.demo-grid{grid-template-columns:1fr;padding:0 20px 56px}.features{padding:0 20px 72px}.features-grid{grid-template-columns:1fr}footer{padding:20px}.tab-panel.active{grid-template-columns:1fr}.tab-features{justify-content:flex-start}}
</style>
</head>
<body>

<nav>
  <a href="https://lynkro.io" target="_blank" class="nav-logo">
    <img src="https://lynkro.io/logo1-removebg-preview.png" alt="Lynkro.io">
  </a>
  <div class="nav-right">
    <div class="lang-switcher">
      <button class="lang-btn active" data-lang="es" onclick="setLang('es',this)">ES</button>
      <button class="lang-btn" data-lang="en" onclick="setLang('en',this)">EN</button>
    </div>
    <a href="mailto:hello@lynkro.io" class="nav-cta" data-i18n="nav-cta">Agendar demo</a>
  </div>
</nav>

<div class="hero">
  <div class="pill"><span class="pill-dot"></span><span data-i18n="hero-pill">Agentes activos &middot; En vivo</span></div>
  <h1 data-i18n-html="hero-h1">Ve c&oacute;mo la IA atiende<br>a tus clientes en <em>tiempo real</em></h1>
  <p data-i18n="hero-p">Selecciona una industria e interact&uacute;a directamente con el agente. Cada demo tiene informaci&oacute;n real y capacidades completas del sistema.</p>
  <p class="hero-note" data-i18n="hero-note">Sin registro &nbsp;&middot;&nbsp; Sin tarjeta &nbsp;&middot;&nbsp; Experiencia 100% real</p>
</div>

<div class="channels">
  <div class="tab-header">
    <button class="tab-btn active" onclick="switchTab('wa',this)">
      <svg class="tab-icon-wa" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.09.54 4.05 1.49 5.76L0 24l6.39-1.47A11.95 11.95 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.854 0-3.6-.5-5.1-1.38l-.36-.22-3.8.87.9-3.7-.24-.38A9.99 9.99 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
      WhatsApp Business
    </button>
    <button class="tab-btn" onclick="switchTab('ig',this)">
      <svg class="tab-icon-ig" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>
      Instagram Direct
    </button>
    <button class="tab-btn" onclick="switchTab('web',this)">
      <svg class="tab-icon-web" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/></svg>
      <span data-i18n="tab-web">Chat Web</span>
    </button>
  </div>
  <div class="tab-panel active" id="tab-wa">
    <div class="tab-panel-desc" data-i18n-html="wa-desc"><strong>El canal de mayor conversi&oacute;n para negocios de servicios.</strong><br>Lynkro responde mensajes, notas de voz e im&aacute;genes en tiempo real. El agente atiende, califica y da seguimiento sin que tu equipo intervenga.</div>
    <div class="tab-features">
      <span class="tab-feature"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/></svg><span data-i18n="wa-f1">Notas de voz</span></span>
      <span class="tab-feature"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><span data-i18n="wa-f2">Im&aacute;genes</span></span>
      <span class="tab-feature"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span data-i18n="wa-f3">Mensajes</span></span>
      <span class="tab-feature"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg><span data-i18n="wa-f4">QR incluido</span></span>
    </div>
  </div>
  <div class="tab-panel" id="tab-ig">
    <div class="tab-panel-desc" data-i18n-html="ig-desc"><strong>Convierte engagement en leads calificados autom&aacute;ticamente.</strong><br>Responde DMs de Instagram en tiempo real &mdash; incluyendo los que llegan desde stories y reels. Cada conversaci&oacute;n es una oportunidad de venta.</div>
    <div class="tab-features">
      <span class="tab-feature"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span data-i18n="ig-f1">DMs autom&aacute;ticos</span></span>
      <span class="tab-feature"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span data-i18n="ig-f2">Stories &amp; Reels</span></span>
      <span class="tab-feature"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg><span data-i18n="ig-f3">IG Pipeline</span></span>
      <span class="tab-feature"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span data-i18n="ig-f4">Prospecci&oacute;n</span></span>
    </div>
  </div>
  <div class="tab-panel" id="tab-web">
    <div class="tab-panel-desc" data-i18n-html="web-desc"><strong>Captura visitantes antes de que se vayan.</strong><br>Widget de chat para tu sitio web. Se activa autom&aacute;ticamente al entrar a la p&aacute;gina y convierte tr&aacute;fico fr&iacute;o en conversaciones calificadas &mdash; sin c&oacute;digo.</div>
    <div class="tab-features">
      <span class="tab-feature"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/></svg><span data-i18n="web-f1">Widget integrado</span></span>
      <span class="tab-feature"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg><span data-i18n="web-f2">Personalizable</span></span>
      <span class="tab-feature"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg><span data-i18n="web-f3">Sin c&oacute;digo</span></span>
    </div>
  </div>
</div>

<div class="features">
  <div class="features-header">
    <div class="pill"><span class="pill-dot"></span><span data-i18n="feat-pill">Plataforma completa</span></div>
    <h2 data-i18n="feat-h2">M&aacute;s que un chat &mdash; Una plataforma de automatizaci&oacute;n</h2>
    <p data-i18n="feat-p">El demo te muestra c&oacute;mo responde el agente. Estas son todas las funcionalidades que trabajan en paralelo para hacer crecer tu negocio.</p>
  </div>
  <div class="features-grid">
    <div class="feat-card highlight">
      <span class="feat-badge star" data-i18n="badge-diff">&#9733; Diferenciador</span>
      <div class="feat-title" data-i18n="f1-title">Seguimiento autom&aacute;tico con contexto</div>
      <div class="feat-desc" data-i18n="f1-desc">Si el lead no responde, Lynkro hace follow-up a las 24h, 3 d&iacute;as y 7 d&iacute;as. Cada mensaje retoma exactamente lo que hablaron &mdash; no es spam gen&eacute;rico.</div>
    </div>
    <div class="feat-card highlight">
      <span class="feat-badge star" data-i18n="badge-diff">&#9733; Diferenciador</span>
      <div class="feat-title" data-i18n="f2-title">Dashboard con IA Insights</div>
      <div class="feat-desc" data-i18n="f2-desc">Ve exactamente d&oacute;nde pierdes leads, cu&aacute;ntos convierten y qu&eacute; ajustar para mejorar la tasa de conversi&oacute;n.</div>
    </div>
    <div class="feat-card highlight">
      <span class="feat-badge star" data-i18n="badge-diff">&#9733; Diferenciador</span>
      <div class="feat-title" data-i18n="f3-title">Calificaci&oacute;n autom&aacute;tica de leads</div>
      <div class="feat-desc" data-i18n="f3-desc">La IA eval&uacute;a cada conversaci&oacute;n y clasifica al prospecto autom&aacute;ticamente. Define los criterios y las acciones para cada nivel: hot, warm, cold.</div>
    </div>
    <div class="feat-card">
      <span class="feat-badge new" data-i18n="badge-new">Nuevo</span>
      <div class="feat-title" data-i18n="f4-title">Gesti&oacute;n Inteligente de Citas</div>
      <div class="feat-desc" data-i18n="f4-desc">Confirmaciones, recordatorios y cambios de horario &mdash; sin que tu equipo toque nada.</div>
      <div class="feat-checks">
        <div class="feat-check"><div class="feat-check-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div><span data-i18n="f4-c1">Confirmaciones autom&aacute;ticas al agendar</span></div>
        <div class="feat-check"><div class="feat-check-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div><span data-i18n="f4-c2">Recordatorios 24h y 2h antes de la cita</span></div>
        <div class="feat-check"><div class="feat-check-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div><span data-i18n="f4-c3">Cancelaciones gestionadas sin intervenci&oacute;n</span></div>
        <div class="feat-check"><div class="feat-check-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div><span data-i18n="f4-c4">Reagendamiento inmediato con link de reserva</span></div>
      </div>
      <div class="feat-result" data-i18n="f4-r">Menos no-shows. M&aacute;s tiempo para tu negocio.</div>
    </div>
    <div class="feat-card">
      <span class="feat-badge new" data-i18n="badge-new">Nuevo</span>
      <div class="feat-title" data-i18n="f5-title">Seguimiento Autom&aacute;tico de Clientes</div>
      <div class="feat-desc" data-i18n="f5-desc">Conseguir un cliente es importante. Hacer que regrese es a&uacute;n m&aacute;s valioso.</div>
      <div class="feat-checks">
        <div class="feat-check"><div class="feat-check-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div><span data-i18n="f5-c1">Reactivaci&oacute;n de clientes inactivos (60/90 d&iacute;as)</span></div>
        <div class="feat-check"><div class="feat-check-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div><span data-i18n="f5-c2">Recordatorios de mantenimiento post-servicio</span></div>
        <div class="feat-check"><div class="feat-check-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div><span data-i18n="f5-c3">Solicitudes autom&aacute;ticas de rese&ntilde;as</span></div>
        <div class="feat-check"><div class="feat-check-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div><span data-i18n="f5-c4">Mensajes de cumplea&ntilde;os con oferta especial</span></div>
      </div>
      <div class="feat-result" data-i18n="f5-r">M&aacute;s visitas recurrentes. Ingresos m&aacute;s predecibles.</div>
    </div>
    <div class="feat-card">
      <span class="feat-badge std" data-i18n="badge-std">Funcionalidad base</span>
      <div class="feat-title" data-i18n="f6-title">Activadores por palabras clave</div>
      <div class="feat-desc" data-i18n="f6-desc">Define respuestas exactas para &ldquo;precio&rdquo;, &ldquo;cita&rdquo;, &ldquo;horario&rdquo;. Se env&iacute;an al instante &mdash; con seguimiento opcional 1 hora despu&eacute;s.</div>
    </div>
  </div>
</div>

<div class="divider"><span data-i18n="divider">Selecciona una industria</span></div>

<div class="demo-grid">${demos.length ? cards : '<p style="color:#8094AE;text-align:center;padding:60px 0;grid-column:1/-1" data-i18n="no-demos">No hay demos disponibles.</p>'}</div>

<footer>
  <div class="footer-inner">
    <div class="footer-bottom">
      <img src="https://lynkro.io/logo1-removebg-preview.png" alt="Lynkro.io" class="footer-logo-img">
      <p class="footer-copy">&copy; 2026 Lynkro. All rights reserved. &nbsp;|&nbsp; Miami, FL</p>
      <div class="footer-socials">
        <a href="https://linkedin.com/company/lynkro" target="_blank" aria-label="LinkedIn"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 8a6 6 0 016 6v7h-4v-7a2 2 0 00-2-2 2 2 0 00-2 2v7h-4v-7a6 6 0 016-6zM2 9h4v12H2z"/><circle cx="4" cy="4" r="2"/></svg></a>
        <a href="https://twitter.com/lynkroio" target="_blank" aria-label="X"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a>
        <a href="https://facebook.com/lynkroio" target="_blank" aria-label="Facebook"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z"/></svg></a>
        <a href="https://instagram.com/lynkroio" target="_blank" aria-label="Instagram"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1112.63 8 4 4 0 0116 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg></a>
      </div>
    </div>
  </div>
</footer>

<script>
const T = {
  es: {
    'nav-cta':'Agendar demo',
    'hero-pill':'Agentes activos · En vivo',
    'hero-h1':'Ve cómo la IA atiende<br>a tus clientes en <em>tiempo real</em>',
    'hero-p':'Selecciona una industria e interactúa directamente con el agente. Cada demo tiene información real y capacidades completas del sistema.',
    'hero-note':'Sin registro  ·  Sin tarjeta  ·  Experiencia 100% real',
    'tab-web':'Chat Web',
    'wa-desc':'<strong>El canal de mayor conversión para negocios de servicios.</strong><br>Lynkro responde mensajes, notas de voz e imágenes en tiempo real. El agente atiende, califica y da seguimiento sin que tu equipo intervenga.',
    'ig-desc':'<strong>Convierte engagement en leads calificados automáticamente.</strong><br>Responde DMs de Instagram en tiempo real — incluyendo los que llegan desde stories y reels. Cada conversación es una oportunidad de venta.',
    'web-desc':'<strong>Captura visitantes antes de que se vayan.</strong><br>Widget de chat para tu sitio web. Se activa automáticamente al entrar a la página y convierte tráfico frío en conversaciones calificadas — sin código.',
    'wa-f1':'Notas de voz','wa-f2':'Imágenes','wa-f3':'Mensajes','wa-f4':'QR incluido',
    'ig-f1':'DMs automáticos','ig-f2':'Stories & Reels','ig-f3':'IG Pipeline','ig-f4':'Prospección',
    'web-f1':'Widget integrado','web-f2':'Personalizable','web-f3':'Sin código',
    'feat-pill':'Plataforma completa',
    'feat-h2':'Más que un chat — Una plataforma de automatización',
    'feat-p':'El demo te muestra cómo responde el agente. Estas son todas las funcionalidades que trabajan en paralelo para hacer crecer tu negocio.',
    'badge-diff':'★ Diferenciador','badge-new':'Nuevo','badge-std':'Funcionalidad base',
    'f1-title':'Seguimiento automático con contexto',
    'f1-desc':'Si el lead no responde, Lynkro hace follow-up a las 24h, 3 días y 7 días. Cada mensaje retoma exactamente lo que hablaron — no es spam genérico.',
    'f2-title':'Dashboard con IA Insights',
    'f2-desc':'Ve exactamente dónde pierdes leads, cuántos convierten y qué ajustar para mejorar la tasa de conversión.',
    'f3-title':'Calificación automática de leads',
    'f3-desc':'La IA evalúa cada conversación y clasifica al prospecto automáticamente. Define los criterios y las acciones para cada nivel: hot, warm, cold.',
    'f4-title':'Gestión Inteligente de Citas',
    'f4-desc':'Confirmaciones, recordatorios y cambios de horario — sin que tu equipo toque nada.',
    'f4-c1':'Confirmaciones automáticas al agendar',
    'f4-c2':'Recordatorios 24h y 2h antes de la cita',
    'f4-c3':'Cancelaciones gestionadas sin intervención',
    'f4-c4':'Reagendamiento inmediato con link de reserva',
    'f4-r':'Menos no-shows. Más tiempo para tu negocio.',
    'f5-title':'Seguimiento Automático de Clientes',
    'f5-desc':'Conseguir un cliente es importante. Hacer que regrese es aún más valioso.',
    'f5-c1':'Reactivación de clientes inactivos (60/90 días)',
    'f5-c2':'Recordatorios de mantenimiento post-servicio',
    'f5-c3':'Solicitudes automáticas de reseñas',
    'f5-c4':'Mensajes de cumpleaños con oferta especial',
    'f5-r':'Más visitas recurrentes. Ingresos más predecibles.',
    'f6-title':'Activadores por palabras clave',
    'f6-desc':'Define respuestas exactas para “precio”, “cita”, “horario”. Se envían al instante — con seguimiento opcional 1 hora después.',
    'divider':'Selecciona una industria',
    'cap-label':'Puedes preguntar sobre',
    'cta-live':'Probar agente en vivo',
    'cta-unavail':'Demo no disponible',
    'agent-word':'Agente',
    'inactive':'Inactivo'
  },
  en: {
    'nav-cta':'Book a demo',
    'hero-pill':'Active agents · Live',
    'hero-h1':'See how AI handles<br>your customers in <em>real time</em>',
    'hero-p':'Select an industry and interact directly with the agent. Each demo has real business data and the system’s full capabilities.',
    'hero-note':'No signup  ·  No credit card  ·  100% real experience',
    'tab-web':'Web Chat',
    'wa-desc':'<strong>The highest-converting channel for service businesses.</strong><br>Lynkro replies to messages, voice notes, and images in real time. The agent handles, qualifies, and follows up without your team lifting a finger.',
    'ig-desc':'<strong>Turn Instagram engagement into qualified leads automatically.</strong><br>Reply to Instagram DMs in real time — including messages from stories and reels. Every conversation is a sales opportunity.',
    'web-desc':'<strong>Capture visitors before they leave.</strong><br>Chat widget for your website. Activates automatically when visitors land and converts cold traffic into qualified conversations — no code needed.',
    'wa-f1':'Voice notes','wa-f2':'Images','wa-f3':'Messages','wa-f4':'QR included',
    'ig-f1':'Auto DMs','ig-f2':'Stories & Reels','ig-f3':'IG Pipeline','ig-f4':'Prospecting',
    'web-f1':'Embedded widget','web-f2':'Customizable','web-f3':'No code',
    'feat-pill':'Full platform',
    'feat-h2':'More than a chat — A complete automation platform',
    'feat-p':'The demo shows you how the agent responds. These are all the features working in parallel to grow your business.',
    'badge-diff':'★ Differentiator','badge-new':'New','badge-std':'Core feature',
    'f1-title':'Automatic follow-up with context',
    'f1-desc':'If a lead doesn’t respond, Lynkro follows up at 24h, 3 days, and 7 days. Each message picks up exactly where the conversation left off — not generic spam.',
    'f2-title':'Dashboard with AI Insights',
    'f2-desc':'See exactly where you’re losing leads, how many convert, and what to adjust to improve your conversion rate.',
    'f3-title':'Automatic lead qualification',
    'f3-desc':'AI evaluates every conversation and classifies prospects automatically. Define your criteria and actions for each level: hot, warm, cold.',
    'f4-title':'Intelligent Appointment Management',
    'f4-desc':'Confirmations, reminders, and reschedules — without your team touching anything.',
    'f4-c1':'Automatic confirmations on booking',
    'f4-c2':'Reminders 24h and 2h before the appointment',
    'f4-c3':'Cancellations handled without intervention',
    'f4-c4':'Instant rescheduling with booking link',
    'f4-r':'Fewer no-shows. More time for your business.',
    'f5-title':'Automatic Client Follow-up',
    'f5-desc':'Getting a client is important. Making them come back is even more valuable.',
    'f5-c1':'Re-engagement of inactive clients (60/90 days)',
    'f5-c2':'Post-service maintenance reminders',
    'f5-c3':'Automatic review requests',
    'f5-c4':'Birthday messages with special offers',
    'f5-r':'More repeat visits. More predictable revenue.',
    'f6-title':'Keyword triggers',
    'f6-desc':'Define exact responses for “price”, “appointment”, “hours”. Sent instantly — with an optional 1-hour follow-up.',
    'divider':'Select an industry',
    'cap-label':'You can ask about',
    'cta-live':'Try live agent',
    'cta-unavail':'Demo unavailable',
    'agent-word':'Agent',
    'inactive':'Inactive'
  }
};

function applyLang(lang) {
  localStorage.setItem('lang', lang);
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = T[lang][el.dataset.i18n];
    if (v !== undefined) el.textContent = v;
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const v = T[lang][el.dataset.i18nHtml];
    if (v !== undefined) el.innerHTML = v;
  });
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
  document.documentElement.lang = lang;
}

function setLang(lang) {
  applyLang(lang);
}

function switchTab(id, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + id).classList.add('active');
}

(function(){
  const url = new URLSearchParams(window.location.search).get('lang');
  const saved = localStorage.getItem('lang');
  const browser = (navigator.language || 'es').startsWith('en') ? 'en' : 'es';
  applyLang(url || saved || browser);
})();
</script>
<script src="https://chat.lynkro.io/widget.js" data-api="https://chat.lynkro.io" data-company="4a945bfd-5090-472e-a3e4-a137c1da56c9"></script>
</body>
</html>`);
});
app.get('/demo/:token', (req, res) => {
  const c = getCompanyByToken(req.params.token);
  if (!c) return res.status(404).send('<h1 style="font-family:sans-serif;text-align:center;margin-top:80px;color:#9FB0C8;background:#0B0F14;padding:40px">Demo no encontrada</h1><style>body{background:#0B0F14;margin:0}</style>');
  if (!c.active) return res.status(403).send('<h1 style="font-family:sans-serif;text-align:center;margin-top:80px;color:#9FB0C8">Demo desactivada</h1>');
  if (c.expires_at && Date.now() > c.expires_at) {
    if (c.demo) return res.status(403).send('<h1 style="font-family:sans-serif;text-align:center;margin-top:80px;color:#9FB0C8">Demo expirada</h1>');
    return res.status(403).send('<div style="font-family:sans-serif;text-align:center;margin-top:80px;color:#9FB0C8;background:#0B0F14;min-height:100vh;padding:40px 20px"><h1 style="font-size:22px">Tu enlace ha expirado</h1><p style="font-size:15px;margin-top:12px">Si quieres que sea reactivado, por favor envía un email a <a href="mailto:hello@lynkro.io" style="color:#27F59B;text-decoration:none">hello@lynkro.io</a></p></div><style>body{background:#0B0F14;margin:0}</style>');
  }
  res.sendFile(path.join(__dirname, 'public', 'demo.html'));
});

// Centralized error handler — must be registered last. Prevents stack
// traces / internal paths from leaking to clients on any unhandled route error.
app.use((err, req, res, next) => {
  console.error('[unhandled-error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Agente multi-empresa corriendo en http://localhost:${PORT}`));
