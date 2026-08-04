(function () {
  const script = document.currentScript;
  const API = script.getAttribute('data-api') || window.location.origin;
  const COMPANY = script.getAttribute('data-company') || '';
  const DELAY = parseInt(script.getAttribute('data-greeting-delay') || '4', 10); // seconds before greeting
  const qs = COMPANY ? `?companyId=${encodeURIComponent(COMPANY)}` : '';

  const visitorId = localStorage.getItem('ai_visitor_id') || (() => {
    const id = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('ai_visitor_id', id);
    return id;
  })();

  let conversationId = sessionStorage.getItem('ai_conv_id') || null;
  let isOpen = false;
  let greetingShown = false;
  let pollTimer = null;
  let lastMessageAt = Date.now();

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (!conversationId) return;
      try {
        const r = await fetch(`${API}/api/chat/poll${qs}&conversationId=${conversationId}&after=${lastMessageAt}`.replace('poll?', 'poll?'));
        const data = await r.json();
        if (data.messages && data.messages.length > 0) {
          data.messages.forEach(m => {
            if (m.role === 'assistant') {
              addBubble('bot', m.content);
              lastMessageAt = m.created_at;
              if (!isOpen) badge.classList.add('show');
            }
          });
        }
        if (!data.human_mode) stopPolling();
      } catch {}
    }, 2500);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  let cfg = {
    businessName: 'Asistente',
    welcomeMessage: '¡Hola! ¿En qué te puedo ayudar?',
    accentColor: '#0ea5e9',
    bgColor: '#ffffff',
    userBubbleColor: '#0ea5e9',
    widgetPosition: 'right',
    logoUrl: '', avatarUrl: '',
    quickReplies: [],
    language: 'español'
  };

  // ── UI language (from Personalidad → Idioma por defecto) ───────
  const I18N = {
    'español':   { openChat: 'Abrir chat', online: '● En línea', placeholder: 'Escribe un mensaje...', send: 'Enviar', welcome: '¡Hola! ¿En qué te puedo ayudar?', error: 'Hubo un error, intenta de nuevo.', handoff: 'En un momento te atendemos. 🙂', connError: 'No pude conectarme. Revisa tu conexión.' },
    'inglés':    { openChat: 'Open chat', online: '● Online', placeholder: 'Type a message...', send: 'Send', welcome: 'Hi! How can I help you today?', error: 'Something went wrong, please try again.', handoff: "We'll be with you in a moment. 🙂", connError: "Couldn't connect. Please check your connection." },
    'portugués': { openChat: 'Abrir chat', online: '● Online', placeholder: 'Digite uma mensagem...', send: 'Enviar', welcome: 'Olá! Como posso ajudar?', error: 'Ocorreu um erro, tente novamente.', handoff: 'Em um momento te atenderemos. 🙂', connError: 'Não foi possível conectar. Verifique sua conexão.' },
    'francés':   { openChat: 'Ouvrir le chat', online: '● En ligne', placeholder: 'Écrivez un message...', send: 'Envoyer', welcome: 'Bonjour ! Comment puis-je vous aider ?', error: "Une erreur s'est produite, veuillez réessayer.", handoff: 'Nous serons avec vous dans un instant. 🙂', connError: 'Connexion impossible. Vérifiez votre connexion.' },
    'hebreo':    { openChat: 'פתח צ׳אט', online: '● מחובר', placeholder: 'הקלד הודעה...', send: 'שלח', welcome: 'שלום! איך אפשר לעזור?', error: 'אירעה שגיאה, נסה שוב.', handoff: 'נהיה איתך בעוד רגע. 🙂', connError: 'לא ניתן להתחבר. בדוק את החיבור שלך.', rtl: true },
    'italiano':  { openChat: 'Apri chat', online: '● Online', placeholder: 'Scrivi un messaggio...', send: 'Invia', welcome: 'Ciao! Come posso aiutarti?', error: 'Si è verificato un errore, riprova.', handoff: 'Ti risponderemo a breve. 🙂', connError: 'Impossibile connettersi. Controlla la tua connessione.' },
    'alemán':    { openChat: 'Chat öffnen', online: '● Online', placeholder: 'Nachricht schreiben...', send: 'Senden', welcome: 'Hallo! Wie kann ich dir helfen?', error: 'Es ist ein Fehler aufgetreten, bitte versuche es erneut.', handoff: 'Wir sind gleich für dich da. 🙂', connError: 'Verbindung fehlgeschlagen. Bitte überprüfe deine Verbindung.' }
  };
  function t() { return I18N[cfg.language] || I18N['español']; }
  function pickWelcome() {
    if (cfg.language === 'inglés' && cfg.welcomeMessageEn) return cfg.welcomeMessageEn;
    return cfg.welcomeMessage || t().welcome;
  }

  // ── Inject styles ───────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #ai-launcher{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;
      background:var(--ai-accent,#0ea5e9);box-shadow:0 4px 20px rgba(0,0,0,.25);
      cursor:pointer;z-index:2147483646;display:flex;align-items:center;justify-content:center;
      border:none;transition:transform .2s,box-shadow .2s;overflow:hidden}
    #ai-launcher.left{right:auto;left:24px}
    #ai-launcher:hover{transform:scale(1.06);box-shadow:0 6px 28px rgba(0,0,0,.35)}
    #ai-launcher svg{width:24px;height:24px;fill:#fff;flex-shrink:0}
    #ai-launcher img.ai-licon{width:100%;height:100%;object-fit:cover}
    #ai-badge{position:absolute;top:-2px;right:-2px;width:18px;height:18px;background:#ef4444;
      border-radius:50%;font-size:10px;font-weight:700;color:#fff;display:none;
      align-items:center;justify-content:center;border:2px solid #fff}
    #ai-badge.show{display:flex}
    #ai-greeting{position:fixed;bottom:92px;right:24px;max-width:280px;
      background:#fff;border-radius:16px 16px 4px 16px;
      box-shadow:0 8px 32px rgba(0,0,0,.15);padding:12px 16px;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;
      color:#111;line-height:1.45;z-index:2147483645;
      animation:aiPop .3s ease;cursor:pointer;border:1px solid #f0f0f0}
    #ai-greeting.left{right:auto;left:24px;border-radius:16px 16px 16px 4px}
    #ai-greeting .ai-gclose{float:right;margin-left:10px;color:#999;cursor:pointer;font-size:15px;line-height:1;margin-top:-2px}
    @keyframes aiPop{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    #ai-panel{position:fixed;bottom:92px;right:24px;width:370px;max-width:calc(100vw - 32px);
      height:540px;max-height:calc(100vh - 130px);background:#f9f9f9;
      border-radius:18px;box-shadow:0 16px 56px rgba(0,0,0,.2);
      display:none;flex-direction:column;overflow:hidden;z-index:2147483647;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      animation:aiSlide .25s ease;border:1px solid rgba(0,0,0,.08)}
    #ai-panel.left{right:auto;left:24px}
    #ai-panel.open{display:flex}
    @keyframes aiSlide{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
    .ai-head{padding:16px 18px;display:flex;align-items:center;gap:10px;flex-shrink:0;
      background:var(--ai-accent,#0ea5e9);color:#fff;border-radius:18px 18px 0 0}
    .ai-head-av{width:36px;height:36px;border-radius:50%;border:2px solid rgba(255,255,255,.4);
      object-fit:cover;flex-shrink:0;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center}
    .ai-head-av svg{width:20px;height:20px;fill:rgba(255,255,255,.85)}
    .ai-head-info{flex:1;min-width:0}
    .ai-head-name{font-weight:700;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ai-head-status{font-size:11px;opacity:.82;margin-top:1px}
    .ai-head-close{background:rgba(255,255,255,.15);border:none;color:#fff;
      width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:18px;
      display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .ai-head-close:hover{background:rgba(255,255,255,.3)}
    .ai-msgs{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;
      gap:8px;background:#f5f5f5;scrollbar-width:thin;scrollbar-color:#ccc transparent}
    .ai-msgs::-webkit-scrollbar{width:4px}
    .ai-msgs::-webkit-scrollbar-thumb{background:#ccc;border-radius:2px}
    .ai-bubble{max-width:82%;padding:10px 14px;border-radius:18px;font-size:14px;
      line-height:1.5;word-wrap:break-word;white-space:pre-wrap}
    .ai-bubble.user{align-self:flex-end;background:var(--ai-accent,#0ea5e9);color:#fff;
      border-bottom-right-radius:4px}
    .ai-bubble.bot{align-self:flex-start;background:#fff;color:#111;
      border-bottom-left-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
    .ai-cta-btn{display:inline-block;margin-top:8px;padding:9px 16px;
      background:var(--ai-accent,#0ea5e9);color:#fff;border-radius:20px;
      font-size:13px;font-weight:600;text-decoration:none;align-self:flex-start}
    .ai-cta-btn:hover{opacity:.9}
    .ai-row{display:flex;align-items:flex-end;gap:6px;align-self:flex-start;max-width:100%}
    .ai-row-av{width:26px;height:26px;border-radius:50%;object-fit:cover;flex-shrink:0}
    .ai-row-av-def{width:26px;height:26px;border-radius:50%;background:var(--ai-accent,#0ea5e9);
      flex-shrink:0;display:flex;align-items:center;justify-content:center}
    .ai-row-av-def svg{width:14px;height:14px;fill:#fff}
    .ai-row .ai-bubble{max-width:100%}
    .ai-typing{display:flex;gap:4px;padding:10px 14px;background:#fff;
      border-radius:18px;border-bottom-left-radius:4px;align-self:flex-start;
      box-shadow:0 1px 3px rgba(0,0,0,.08)}
    .ai-typing span{width:6px;height:6px;background:#bbb;border-radius:50%;animation:aiDot 1.2s infinite}
    .ai-typing span:nth-child(2){animation-delay:.2s}.ai-typing span:nth-child(3){animation-delay:.4s}
    @keyframes aiDot{0%,60%,100%{opacity:.4;transform:scale(1)}30%{opacity:1;transform:scale(1.3)}}
    .ai-quick-wrap{display:flex;flex-wrap:wrap;gap:6px;padding:2px 0 4px;align-self:flex-start}
    .ai-quick-btn{padding:7px 14px;border-radius:20px;font-size:13px;cursor:pointer;
      border:1.5px solid var(--ai-accent,#0ea5e9);background:#fff;
      color:var(--ai-accent,#0ea5e9);font-family:inherit;transition:.15s}
    .ai-quick-btn:hover{background:var(--ai-accent,#0ea5e9);color:#fff}
    .ai-foot{display:flex;align-items:center;gap:8px;padding:10px 12px;
      background:#fff;border-top:1px solid #ececec;flex-shrink:0}
    .ai-foot input{flex:1;border:1.5px solid #e5e5e5;border-radius:24px;
      padding:9px 16px;font-size:14px;outline:none;font-family:inherit;color:#111;
      background:#fafafa;transition:border-color .15s}
    .ai-foot input:focus{border-color:var(--ai-accent,#0ea5e9);background:#fff}
    .ai-foot input::placeholder{color:#aaa}
    .ai-foot button{width:38px;height:38px;border-radius:50%;border:none;flex-shrink:0;
      background:var(--ai-accent,#0ea5e9);color:#fff;cursor:pointer;
      display:flex;align-items:center;justify-content:center;transition:.15s}
    .ai-foot button:hover{filter:brightness(1.1)}
    .ai-foot button:disabled{opacity:.45;cursor:not-allowed}
    .ai-foot button svg{width:18px;height:18px;fill:#fff}
    .ai-powered{text-align:center;font-size:10px;color:#bbb;padding:5px;flex-shrink:0;background:#fff}
    @media(max-width:420px){
      #ai-panel{width:calc(100vw - 16px);height:calc(100vh - 110px);
        bottom:80px;right:8px;border-radius:14px}
      #ai-panel.left{left:8px;right:auto}
      #ai-greeting{right:8px;max-width:calc(100vw - 80px)}
    }
  `;
  document.head.appendChild(style);

  // ── Build DOM ────────────────────────────────────────────────
  const launcher = document.createElement('button');
  launcher.id = 'ai-launcher';
  launcher.setAttribute('aria-label', 'Abrir chat');
  launcher.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/></svg>
    <span id="ai-badge">1</span>`;
  document.body.appendChild(launcher);

  const greeting = document.createElement('div');
  greeting.id = 'ai-greeting';
  greeting.style.display = 'none';
  greeting.innerHTML = `<span class="ai-gclose" id="ai-gclose">×</span><span id="ai-gtext"></span>`;
  document.body.appendChild(greeting);

  const panel = document.createElement('div');
  panel.id = 'ai-panel';
  panel.innerHTML = `
    <div class="ai-head">
      <div class="ai-head-av" id="ai-head-av">
        <svg viewBox="0 0 24 24"><path d="M12 2a5 5 0 1 1 0 10A5 5 0 0 1 12 2zm0 12c5.33 0 8 2.67 8 4v2H4v-2c0-1.33 2.67-4 8-4z"/></svg>
      </div>
      <div class="ai-head-info">
        <div class="ai-head-name" id="ai-head-name">Asistente</div>
        <div class="ai-head-status">● En línea</div>
      </div>
      <button class="ai-head-close" id="ai-close">×</button>
    </div>
    <div class="ai-msgs" id="ai-msgs"></div>
    <div class="ai-foot">
      <input id="ai-input" type="text" placeholder="Escribe un mensaje..." autocomplete="off" />
      <button id="ai-send" type="button" aria-label="Enviar">
        <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
      </button>
    </div>
    <div class="ai-powered"><a href="https://chat.lynkro.io/" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">Powered by IA · Lynkro</a></div>`;
  document.body.appendChild(panel);

  const msgsEl = document.getElementById('ai-msgs');
  const inputEl = document.getElementById('ai-input');
  const sendBtn = document.getElementById('ai-send');
  const badge = document.getElementById('ai-badge');

  // ── Apply config ─────────────────────────────────────────────
  function applyConfig() {
    const accent = cfg.accentColor || '#0ea5e9';
    document.documentElement.style.setProperty('--ai-accent', accent);
    launcher.style.background = accent;
    const side = cfg.widgetPosition === 'left' ? 'left' : 'right';
    launcher.className = side === 'left' ? 'left' : '';
    panel.className = `${panel.classList.contains('open') ? 'open' : ''} ${side === 'left' ? 'left' : ''}`.trim();
    greeting.className = side === 'left' ? 'left' : '';
    if (side === 'left') { launcher.style.left = '24px'; launcher.style.right = 'auto'; }
    else { launcher.style.right = '24px'; launcher.style.left = 'auto'; }
    const i18n = t();
    launcher.setAttribute('aria-label', i18n.openChat);
    document.querySelector('.ai-head-status').textContent = i18n.online;
    inputEl.setAttribute('placeholder', i18n.placeholder);
    sendBtn.setAttribute('aria-label', i18n.send);
    panel.setAttribute('dir', i18n.rtl ? 'rtl' : 'ltr');
    greeting.setAttribute('dir', i18n.rtl ? 'rtl' : 'ltr');
    document.getElementById('ai-head-name').textContent = cfg.businessName || 'Asistente';
    if (cfg.avatarUrl) {
      const src = cfg.avatarUrl.startsWith('http') ? cfg.avatarUrl : API + cfg.avatarUrl;
      document.getElementById('ai-head-av').innerHTML = `<img class="ai-row-av" src="${src}" style="width:36px;height:36px">`;
      launcher.innerHTML = `<img class="ai-licon" src="${src}" alt=""><span id="ai-badge">${badge.textContent}</span>`;
    } else if (cfg.logoUrl) {
      const src = cfg.logoUrl.startsWith('http') ? cfg.logoUrl : API + cfg.logoUrl;
      launcher.innerHTML = `<img class="ai-licon" src="${src}" alt=""><span id="ai-badge">${badge.textContent}</span>`;
    }
  }

  // ── Messages ─────────────────────────────────────────────────
  // A video URL in a reply becomes an inline player in the bubble. ponytail:
  // handles .mp4/.webm/.mov (native) + youtube/vimeo (iframe); other links stay links.
  function videoEmbed(url) {
    if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return `<video src="${url}" controls playsinline preload="metadata" style="display:block;width:100%;margin-top:8px;border-radius:10px"></video>`;
    const yt = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/);
    if (yt) return `<div style="position:relative;width:100%;padding-top:56.25%;margin-top:8px"><iframe src="https://www.youtube.com/embed/${yt[1]}" style="position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:10px" allow="fullscreen; encrypted-media" loading="lazy"></iframe></div>`;
    const vm = url.match(/vimeo\.com\/(\d+)/);
    if (vm) return `<div style="position:relative;width:100%;padding-top:56.25%;margin-top:8px"><iframe src="https://player.vimeo.com/video/${vm[1]}" style="position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:10px" allow="fullscreen" loading="lazy"></iframe></div>`;
    return '';
  }
  function linkify(text) {
    const esc = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return esc.replace(/(https?:\/\/[^\s<>"]+)/g, (m, url) => videoEmbed(url) || `<a href="${url}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;word-break:break-all">${url}</a>`);
  }

  function addBubble(role, text, button) {
    const avatarSrc = cfg.avatarUrl ? (cfg.avatarUrl.startsWith('http') ? cfg.avatarUrl : API + cfg.avatarUrl) : '';
    if (role === 'bot') {
      const row = document.createElement('div');
      row.className = 'ai-row';
      if (avatarSrc) {
        row.innerHTML = `<img class="ai-row-av" src="${avatarSrc}"><div class="ai-bubble bot"></div>`;
      } else {
        row.innerHTML = `<div class="ai-row-av-def"><svg viewBox="0 0 24 24"><path d="M12 2a5 5 0 1 1 0 10A5 5 0 0 1 12 2zm0 12c5.33 0 8 2.67 8 4v2H4v-2c0-1.33 2.67-4 8-4z"/></svg></div><div class="ai-bubble bot"></div>`;
      }
      const bubble = row.querySelector('.ai-bubble');
      bubble.innerHTML = linkify(text);
      if (button && button.url) {
        const a = document.createElement('a');
        a.className = 'ai-cta-btn';
        a.href = button.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = button.label || button.url;
        bubble.appendChild(document.createElement('br'));
        bubble.appendChild(a);
      }
      msgsEl.appendChild(row);
    } else {
      const el = document.createElement('div');
      el.className = 'ai-bubble user';
      el.textContent = text;
      msgsEl.appendChild(el);
    }
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function showTyping() {
    const el = document.createElement('div');
    el.className = 'ai-typing';
    el.innerHTML = '<span></span><span></span><span></span>';
    msgsEl.appendChild(el);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return el;
  }

  function renderQuickReplies() {
    if (!cfg.quickReplies?.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'ai-quick-wrap';
    cfg.quickReplies.forEach(q => {
      const b = document.createElement('button');
      b.className = 'ai-quick-btn';
      b.textContent = q.label;
      b.onclick = () => { wrap.remove(); sendMessage(q.message || q.label); };
      wrap.appendChild(b);
    });
    msgsEl.appendChild(wrap);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // ── Panel open/close ─────────────────────────────────────────
  function openPanel() {
    isOpen = true;
    panel.classList.add('open');
    greeting.style.display = 'none';
    badge.classList.remove('show');
    if (!msgsEl.children.length) {
      addBubble('bot', pickWelcome());
      renderQuickReplies();
    }
    setTimeout(() => inputEl.focus(), 200);
  }

  function closePanel() {
    isOpen = false;
    panel.classList.remove('open');
  }

  launcher.addEventListener('click', () => isOpen ? closePanel() : openPanel());
  document.getElementById('ai-close').addEventListener('click', closePanel);

  // ── Auto-greeting after delay ─────────────────────────────────
  if (DELAY >= 0) {
    setTimeout(() => {
      if (isOpen || greetingShown) return;
      greetingShown = true;
      document.getElementById('ai-gtext').textContent = pickWelcome();
      greeting.style.display = 'block';
      badge.classList.add('show');
      greeting.addEventListener('click', e => {
        if (e.target.id === 'ai-gclose') { greeting.style.display = 'none'; return; }
        greeting.style.display = 'none';
        openPanel();
      });
      document.getElementById('ai-gclose').addEventListener('click', e => {
        e.stopPropagation();
        greeting.style.display = 'none';
        badge.classList.remove('show');
      });
    }, DELAY * 1000);
  }

  // ── Send message ─────────────────────────────────────────────
  async function sendMessage(text) {
    if (!text?.trim()) return;
    greeting.style.display = 'none';
    addBubble('user', text);
    sendBtn.disabled = true;
    inputEl.disabled = true;
    const typing = showTyping();
    try {
      const r = await fetch(`${API}/api/chat${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          conversationId,
          visitorId,
          companyId: COMPANY || undefined,
          pageUrl: window.location.href,
          pageTitle: document.title
        })
      });
      const data = await r.json();
      typing.remove();
      if (data.error) addBubble('bot', t().error);
      else {
        conversationId = data.conversationId;
        sessionStorage.setItem('ai_conv_id', conversationId);
        lastMessageAt = Date.now();
        if (data.reply) {
          addBubble('bot', data.reply, data.button);
          if (!isOpen) badge.classList.add('show');
        } else {
          addBubble('bot', t().handoff);
        }
        startPolling();
      }
    } catch {
      typing.remove();
      addBubble('bot', t().connError);
    }
    sendBtn.disabled = false;
    inputEl.disabled = false;
    inputEl.focus();
  }

  sendBtn.addEventListener('click', () => {
    const text = inputEl.value.trim();
    inputEl.value = '';
    sendMessage(text);
  });
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
  });

  // ── Public API ───────────────────────────────────────────────
  window.LynkroChat = {
    open: () => { if (!isOpen) openPanel(); },
    close: () => { if (isOpen) closePanel(); },
    toggle: () => isOpen ? closePanel() : openPanel(),
    send: (text) => {
      if (!isOpen) openPanel();
      setTimeout(() => sendMessage(text), 300);
    }
  };

  // ── Load config ──────────────────────────────────────────────
  fetch(`${API}/api/config/public${qs}`).then(r => r.json()).then(c => {
    cfg = { ...cfg, ...c };
    applyConfig();
  }).catch(() => {});
})();
