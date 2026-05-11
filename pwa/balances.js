const TOKEN_KEY = 'appToken';
const CACHE_KEY = 'cache:balances';

const $ = (id) => document.getElementById(id);

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
}
function writeCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

const CURRENCY_DISPLAY = { THB: 'бат', USDT: 'USDT', RUB: '₽' };

function fmtAmount(n) {
  const isInt = Math.abs(n % 1) < 0.005;
  const s = isInt ? Math.round(n).toString() : (Math.round(n * 100) / 100).toFixed(2);
  const [intPart, decPart] = s.split('.');
  const intFmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return decPart !== undefined ? `${intFmt}.${decPart}` : intFmt;
}

function fmtUpdatedAt(iso) {
  if (!iso) return 'данные ещё не сохранены';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const fmt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  return `обновлено: ${fmt.format(d)}`;
}

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = cls;
}

function render(data) {
  const list = $('accounts');
  list.innerHTML = '';
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  if (accounts.length === 0) {
    list.innerHTML = '<div class="row"><span class="name" style="opacity:0.5">пусто</span></div>';
  } else {
    for (const acc of accounts) {
      const row = document.createElement('div');
      row.className = 'row';
      const cur = CURRENCY_DISPLAY[acc.currency] || acc.currency || '';
      row.innerHTML = `
        <span class="name">${escapeHtml(acc.name || acc.id || '?')}</span>
        <span class="amount">${fmtAmount(acc.amount || 0)}<span class="currency">${escapeHtml(cur)}</span></span>
      `;
      list.appendChild(row);
    }
  }
  $('updated').textContent = fmtUpdatedAt(data.updated_at);
  setStatus('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function load() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    setStatus('заполни токен в настройках', 'err');
    overlay.classList.add('open');
    return;
  }

  const cached = readCache();
  if (cached) {
    render(cached);
  } else {
    setStatus('загрузка…');
  }

  try {
    const res = await fetch('/api/balances', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      if (!cached) {
        let detail = '';
        try { const j = await res.json(); detail = j.error || ''; } catch {}
        setStatus(`ошибка ${res.status} ${detail}`, 'err');
      }
      return;
    }
    const data = await res.json();
    writeCache(data);
    render(data);
  } catch {
    if (!cached) setStatus('нет соединения', 'err');
  }
}

const overlay = $('overlay');
const tokenInput = $('token');
tokenInput.value = localStorage.getItem(TOKEN_KEY) || '';

$('gear').addEventListener('click', () => overlay.classList.add('open'));
$('close').addEventListener('click', () => overlay.classList.remove('open'));
overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.classList.remove('open'); });

$('save-config').addEventListener('click', () => {
  localStorage.setItem(TOKEN_KEY, tokenInput.value.trim());
  overlay.classList.remove('open');
  load();
});

window.addEventListener('focus', load);
window.addEventListener('pageshow', load);
load();
