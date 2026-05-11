const QUEUE_KEY = 'expenseQueue';
const TOKEN_KEY = 'appToken';

const $ = (id) => document.getElementById(id);

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = cls;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

const tokenInput = $('token');
tokenInput.value = localStorage.getItem(TOKEN_KEY) || '';

const overlay = $('overlay');
const openSettings = () => overlay.classList.add('open');
const closeSettings = () => overlay.classList.remove('open');

$('gear').addEventListener('click', openSettings);
$('close').addEventListener('click', closeSettings);
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettings(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

$('save-config').addEventListener('click', () => {
  localStorage.setItem(TOKEN_KEY, tokenInput.value.trim());
  setStatus('Настройки сохранены', 'ok');
  closeSettings();
  flush();
});

if (!localStorage.getItem(TOKEN_KEY)) {
  openSettings();
  setStatus('Заполни токен в настройках', 'err');
}

$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;

  $('submit').disabled = true;
  setStatus('Отправляю…');

  const result = await tryPost(text);
  if (result.ok) {
    $('text').value = '';
    setStatus(`✓ ${text}`, 'ok');
  } else if (result.networkError) {
    enqueue(text);
    $('text').value = '';
    setStatus(`📦 в очереди: ${text}`, 'queue');
  } else {
    setStatus(`✗ ${result.error || 'ошибка'}`, 'err');
  }
  $('submit').disabled = false;
  updateQueueInfo();
});

async function tryPost(text) {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return { ok: false, error: 'нет токена' };

  try {
    const res = await fetch('/api/expense', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text, now: new Date().toISOString() }),
    });
    if (res.ok) return { ok: true };
    let detail = '';
    try { const j = await res.json(); detail = j.error || ''; } catch {}
    return { ok: false, error: `${res.status} ${detail}`, status: res.status };
  } catch {
    return { ok: false, networkError: true };
  }
}

function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
function setQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
function enqueue(text) {
  const q = getQueue();
  q.push({ text, queuedAt: new Date().toISOString() });
  setQueue(q);
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    let q = getQueue();
    if (q.length === 0) return;
    let sentCount = 0;
    let droppedCount = 0;
    while (q.length > 0) {
      const item = q[0];
      const result = await tryPost(item.text);
      if (result.ok) {
        q.shift();
        setQueue(q);
        sentCount++;
      } else if (result.status && result.status >= 400 && result.status < 500) {
        q.shift();
        setQueue(q);
        droppedCount++;
      } else {
        break;
      }
    }
    if (sentCount > 0) {
      setStatus(`✓ из очереди отправлено: ${sentCount}`, 'ok');
    }
    if (droppedCount > 0) {
      setStatus(`⚠ выброшено из очереди (ошибки): ${droppedCount}`, 'err');
    }
  } finally {
    flushing = false;
    updateQueueInfo();
  }
}

function updateQueueInfo() {
  const q = getQueue();
  const el = $('queue-info');
  el.textContent = q.length ? `В очереди: ${q.length} (нажми чтобы очистить)` : '';
  el.style.cursor = q.length ? 'pointer' : 'default';
}

$('queue-info').addEventListener('click', () => {
  const q = getQueue();
  if (q.length === 0) return;
  if (confirm(`Очистить очередь (${q.length})?`)) {
    setQueue([]);
    setStatus('очередь очищена', 'ok');
    updateQueueInfo();
  }
});

updateQueueInfo();
window.addEventListener('online', flush);
window.addEventListener('focus', flush);
window.addEventListener('pageshow', flush);
setInterval(flush, 30_000);
flush();
