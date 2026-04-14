(function () {
  const script = document.currentScript;
  const API = script.getAttribute('data-api') || window.location.origin;

  const visitorId = localStorage.getItem('ai_visitor_id') || (() => {
    const id = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('ai_visitor_id', id);
    return id;
  })();

  let conversationId = sessionStorage.getItem('ai_conv_id') || null;
  let config = { businessName: 'Asistente', welcomeMessage: '¡Hola!', accentColor: '#D4AF37' };

  fetch(`${API}/api/config/public`).then(r => r.json()).then(c => {
    config = { ...config, ...c };
    applyTheme();
    header.textContent = config.businessName;
    if (!messagesEl.children.length) addMsg('assistant', config.welcomeMessage);
  }).catch(() => {});

  const style = document.createElement('style');
  style.textContent = `
    .ai-launcher{position:fixed;bottom:24px;right:24px;width:60px;height:60px;border-radius:50%;
      background:linear-gradient(135deg,#1a1a1a,#0a0a0a);border:1px solid var(--ai-accent,#D4AF37);
      box-shadow:0 8px 32px rgba(212,175,55,.25),0 0 0 1px rgba(212,175,55,.1);
      cursor:pointer;z-index:2147483646;display:flex;align-items:center;justify-content:center;
      transition:transform .2s ease, box-shadow .2s ease}
    .ai-launcher:hover{transform:scale(1.05);box-shadow:0 12px 40px rgba(212,175,55,.4)}
    .ai-launcher svg{width:26px;height:26px;fill:var(--ai-accent,#D4AF37)}
    .ai-panel{position:fixed;bottom:100px;right:24px;width:380px;max-width:calc(100vw - 32px);
      height:560px;max-height:calc(100vh - 140px);background:#0a0a0a;
      border:1px solid rgba(212,175,55,.2);border-radius:16px;
      box-shadow:0 24px 60px rgba(0,0,0,.6),0 0 0 1px rgba(212,175,55,.08);
      display:none;flex-direction:column;overflow:hidden;z-index:2147483647;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e8e8e8;
      animation:aiSlide .25s ease}
    @keyframes aiSlide{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
    .ai-panel.open{display:flex}
    .ai-header{padding:18px 20px;background:linear-gradient(135deg,#141414,#0a0a0a);
      border-bottom:1px solid rgba(212,175,55,.15);font-weight:600;font-size:15px;
      letter-spacing:.3px;display:flex;align-items:center;gap:10px}
    .ai-header::before{content:'';width:8px;height:8px;border-radius:50%;
      background:var(--ai-accent,#D4AF37);box-shadow:0 0 10px var(--ai-accent,#D4AF37)}
    .ai-close{margin-left:auto;cursor:pointer;color:#888;font-size:20px;line-height:1;
      background:none;border:none;padding:4px}
    .ai-close:hover{color:var(--ai-accent,#D4AF37)}
    .ai-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;
      scrollbar-width:thin;scrollbar-color:#333 transparent}
    .ai-messages::-webkit-scrollbar{width:6px}
    .ai-messages::-webkit-scrollbar-thumb{background:#333;border-radius:3px}
    .ai-msg{max-width:85%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.5;
      word-wrap:break-word;white-space:pre-wrap}
    .ai-msg.user{align-self:flex-end;background:linear-gradient(135deg,#2a2205,#1a1503);
      color:#f5e9b8;border:1px solid rgba(212,175,55,.25)}
    .ai-msg.assistant{align-self:flex-start;background:#161616;border:1px solid #222}
    .ai-typing{display:flex;gap:4px;padding:12px 14px}
    .ai-typing span{width:6px;height:6px;background:var(--ai-accent,#D4AF37);border-radius:50%;
      animation:aiDot 1.2s infinite}
    .ai-typing span:nth-child(2){animation-delay:.2s}.ai-typing span:nth-child(3){animation-delay:.4s}
    @keyframes aiDot{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}
    .ai-input{display:flex;padding:12px;gap:8px;border-top:1px solid rgba(212,175,55,.12);
      background:#0c0c0c}
    .ai-input input{flex:1;background:#161616;border:1px solid #222;color:#e8e8e8;
      padding:10px 14px;border-radius:10px;font-size:14px;outline:none;transition:border-color .2s}
    .ai-input input:focus{border-color:var(--ai-accent,#D4AF37)}
    .ai-input button{background:linear-gradient(135deg,var(--ai-accent,#D4AF37),#a8862a);
      color:#0a0a0a;border:none;padding:0 16px;border-radius:10px;cursor:pointer;
      font-weight:600;font-size:13px;transition:opacity .2s}
    .ai-input button:disabled{opacity:.5;cursor:not-allowed}
    .ai-footer{text-align:center;font-size:10px;color:#555;padding:6px;letter-spacing:.5px}
  `;
  document.head.appendChild(style);

  const launcher = document.createElement('button');
  launcher.className = 'ai-launcher';
  launcher.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 0 0-8.5 15.2L2 22l4.9-1.4A10 10 0 1 0 12 2zm0 18a8 8 0 0 1-4.3-1.2l-.3-.2-2.9.8.8-2.8-.2-.3A8 8 0 1 1 12 20zm4-6a3 3 0 0 1-3 3h-2a3 3 0 0 1-3-3v-1h8v1z"/></svg>';
  document.body.appendChild(launcher);

  const panel = document.createElement('div');
  panel.className = 'ai-panel';
  panel.innerHTML = `
    <div class="ai-header"><span class="ai-title">Asistente</span><button class="ai-close">×</button></div>
    <div class="ai-messages"></div>
    <form class="ai-input"><input type="text" placeholder="Escribe tu mensaje..." autocomplete="off"/><button type="submit">Enviar</button></form>
    <div class="ai-footer">Powered by Claude</div>`;
  document.body.appendChild(panel);

  const header = panel.querySelector('.ai-title');
  const messagesEl = panel.querySelector('.ai-messages');
  const form = panel.querySelector('form');
  const input = form.querySelector('input');
  const sendBtn = form.querySelector('button');

  function applyTheme() {
    document.documentElement.style.setProperty('--ai-accent', config.accentColor);
  }

  function addMsg(role, text, messageId) {
    const el = document.createElement('div');
    el.className = 'ai-msg ' + role;
    el.textContent = text;
    messagesEl.appendChild(el);
    if (role === 'assistant' && messageId) {
      const rate = document.createElement('div');
      rate.style.cssText = 'display:flex;gap:6px;margin-top:4px;align-self:flex-start';
      rate.innerHTML = `
        <button data-r="1" style="background:none;border:1px solid #333;color:#888;padding:2px 8px;border-radius:6px;cursor:pointer;font-size:11px">👍</button>
        <button data-r="-1" style="background:none;border:1px solid #333;color:#888;padding:2px 8px;border-radius:6px;cursor:pointer;font-size:11px">👎</button>`;
      rate.querySelectorAll('button').forEach(b => b.onclick = () => {
        fetch(`${API}/api/rate`, { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ conversationId, messageId, rating: +b.dataset.r }) });
        rate.innerHTML = `<span style="color:var(--ai-accent,#D4AF37);font-size:11px">¡Gracias por tu feedback!</span>`;
      });
      messagesEl.appendChild(rate);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function showTyping() {
    const el = document.createElement('div');
    el.className = 'ai-msg assistant ai-typing';
    el.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  launcher.onclick = () => panel.classList.toggle('open');
  panel.querySelector('.ai-close').onclick = () => panel.classList.remove('open');

  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    addMsg('user', text);
    input.value = '';
    sendBtn.disabled = true;
    const typing = showTyping();
    try {
      const r = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversationId, visitorId })
      });
      const data = await r.json();
      typing.remove();
      if (data.error) addMsg('assistant', 'Error: ' + data.error);
      else {
        conversationId = data.conversationId;
        sessionStorage.setItem('ai_conv_id', conversationId);
        addMsg('assistant', data.reply, data.messageId);
      }
    } catch (err) {
      typing.remove();
      addMsg('assistant', 'No se pudo conectar. Intenta de nuevo.');
    }
    sendBtn.disabled = false;
    input.focus();
  };
})();
