require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const axios    = require('axios');
const crypto   = require('crypto');
const Stripe   = require('stripe');
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const { IgApiClient, IgCheckpointError } = require('instagram-private-api');
let puppeteer; try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }

// ============================================
// Monitor DB (SQLite local)
// ============================================
const db = new Database(path.join(__dirname, 'monitor.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS monitor_profiles (
    username     TEXT PRIMARY KEY,
    ig_user_id   TEXT,
    added_at     TEXT NOT NULL,
    last_checked TEXT,
    follower_count INTEGER DEFAULT 0,
    status       TEXT DEFAULT 'pending'
  );
  CREATE TABLE IF NOT EXISTS profile_followers (
    profile_username TEXT NOT NULL,
    follower_id      TEXT NOT NULL,
    PRIMARY KEY (profile_username, follower_id)
  );
  CREATE TABLE IF NOT EXISTS monitor_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_username TEXT NOT NULL,
    follower_id      TEXT NOT NULL,
    follower_username TEXT,
    follower_fullname TEXT,
    follower_photo    TEXT,
    detected_at      TEXT NOT NULL,
    seen             INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS monitor_credentials (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    sessionid    TEXT,
    csrftoken    TEXT,
    ds_user_id   TEXT,
    cookie_string TEXT,
    user_agent   TEXT,
    username     TEXT,
    saved_at     TEXT
  );
`);

// ============================================
// Monitor State
// ============================================

function saveMonitorCredentials(creds) {
    db.prepare(`
        INSERT INTO monitor_credentials (id, sessionid, csrftoken, ds_user_id, cookie_string, user_agent, username, saved_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            sessionid=excluded.sessionid, csrftoken=excluded.csrftoken,
            ds_user_id=excluded.ds_user_id, cookie_string=excluded.cookie_string,
            user_agent=excluded.user_agent, username=excluded.username,
            saved_at=excluded.saved_at
    `).run(
        creds.sessionid || '', creds.csrftoken || '', creds.dsUserId || '',
        creds.cookieString || '', creds.userAgent || '', creds.username || '',
        new Date().toISOString()
    );
}

function loadMonitorCredentials() {
    const row = db.prepare('SELECT * FROM monitor_credentials WHERE id = 1').get();
    if (!row?.sessionid) return null;
    return {
        loggedIn:     true,
        sessionid:    row.sessionid,
        csrftoken:    row.csrftoken,
        dsUserId:     row.ds_user_id,
        cookieString: row.cookie_string,
        userAgent:    row.user_agent,
        username:     row.username,
    };
}

// Utilitários de comportamento humano
const jitter   = (base, pct = 0.3) => Math.round(base * (1 + (Math.random() * 2 - 1) * pct));
const randInt  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const humanDelay = () => randInt(1000, 2200); // delay entre páginas: 1.0-2.2s
const isHumanHour = () => { const h = new Date().getHours(); return h >= 7 && h < 23; };

const monitor = {
  credentials: loadMonitorCredentials(),
  clients:     new Set(),
  timer:       null,
  polling:     false,
  // Intervalo base 40min ± 25% → entre ~30min e ~50min, nunca previsível
  INTERVAL_BASE: 40 * 60 * 1000,
  MAX_PAGES:     400,
  MAX_PROFILES:  3,
};

function monitorSend(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of monitor.clients) {
    try { if (!res.writableEnded) res.write(msg); }
    catch { monitor.clients.delete(res); }
  }
}

function monitorAxiosWeb() {
  const c = monitor.credentials;
  if (!c) return null;
  const ua     = c.userAgent     || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const cookie = c.cookieString  || [`sessionid=${c.sessionid}`, c.csrftoken ? `csrftoken=${c.csrftoken}` : '', c.dsUserId ? `ds_user_id=${c.dsUserId}` : ''].filter(Boolean).join('; ');
  return axios.create({
    baseURL: 'https://www.instagram.com', timeout: 25000,
    maxRedirects: 0, validateStatus: s => s < 500,
    headers: {
      'User-Agent': ua, 'Accept': '*/*',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'X-IG-App-ID': '936619743392459', 'X-ASBD-ID': '129477',
      'X-CSRFToken': c.csrftoken || '', 'X-Requested-With': 'XMLHttpRequest',
      'X-IG-WWW-Claim': '0',
      'Referer': 'https://www.instagram.com/', 'Origin': 'https://www.instagram.com',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
      'Cookie': cookie,
    }
  });
}

function monitorAxiosMobile() {
  const c = monitor.credentials;
  if (!c) return null;
  const cookie = c.cookieString || [`sessionid=${c.sessionid}`, c.csrftoken ? `csrftoken=${c.csrftoken}` : ''].filter(Boolean).join('; ');
  return axios.create({
    baseURL: 'https://i.instagram.com', timeout: 20000,
    maxRedirects: 3, validateStatus: s => s < 500,
    headers: {
      'User-Agent':    'Instagram 289.0.0.77.109 Android (29/10; 440dpi; 1080x2220; OnePlus; ONEPLUS A6003; OnePlus6; qcom; pt_BR; 482616210)',
      'X-IG-App-ID':  '567067343352427', 'Accept': '*/*',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'Cookie': cookie, 'X-CSRFToken': c.csrftoken || ''
    }
  });
}

// Busca seguidores com fallback automático web→mobile
// Retorna { data, status } para permitir diagnóstico pelo chamador
async function monitorFetchFollowersPage(web, mobile, userId, maxId) {
  const params = { count: 50, ...(maxId ? { max_id: maxId } : {}) };
  const endpoint = `/api/v1/friendships/${userId}/followers/`;

  let lastStatus = null;

  // Tenta web primeiro
  try {
    const r = await web.get(endpoint, { params });
    lastStatus = r.status;
    console.log(`[monitor followers] web status=${r.status} users=${r.data?.users?.length ?? '?'}`);
    if (r.status === 200) return { data: r.data, status: 200 };
    if (r.status !== 429) console.warn(`[monitor followers] web status=${r.status} — tentando mobile`);
  } catch (e) { console.warn('[monitor followers] web erro:', e.message); }

  // Fallback mobile
  if (mobile) {
    try {
      const rm = await mobile.get(endpoint, { params });
      lastStatus = rm.status;
      console.log(`[monitor followers] mobile status=${rm.status} users=${rm.data?.users?.length ?? '?'}`);
      if (rm.status === 200) return { data: rm.data, status: 200 };
      console.warn(`[monitor followers] mobile status=${rm.status}`);
    } catch (e) { console.warn('[monitor followers] mobile erro:', e.message); }
  }

  return { data: null, status: lastStatus }; // ambos falharam
}

// Sync inicial: busca TODOS os seguidores e salva no DB
async function monitorFullSync(username, userId) {
  const insert = db.prepare('INSERT OR IGNORE INTO profile_followers (profile_username, follower_id) VALUES (?, ?)');
  const web    = monitorAxiosWeb();
  const mobile = monitorAxiosMobile();
  if (!web) {
    console.warn(`[monitor] sync @${username}: sem credenciais`);
    db.prepare('UPDATE monitor_profiles SET status = ? WHERE username = ?').run('error', username);
    monitorSend({ type: 'profile_error', profile: username, error: 'Sem credenciais. Reconecte o Instagram.' });
    return;
  }

  let maxId = null, total = 0, failures = 0;
  db.prepare('UPDATE monitor_profiles SET status = ? WHERE username = ?').run('syncing', username);
  monitorSend({ type: 'sync_start', profile: username });
  console.log(`[monitor] iniciando sync @${username} (userId=${userId})`);

  for (let pg = 0; pg < monitor.MAX_PAGES; pg++) {
    const { data, status } = await monitorFetchFollowersPage(web, mobile, userId, maxId);

    if (!data) {
      // 400 = userId inválido — sem ponto em continuar
      if (status === 400) {
        console.error(`[monitor] sync @${username}: userId inválido (400) — abortando`);
        break;
      }
      failures++;
      const waitMs = Math.min(15000 * failures, 120000);
      console.warn(`[monitor] sync @${username} pg${pg}: falha ${failures} (status=${status}) — aguardando ${waitMs/1000}s`);
      if (failures >= 5) { console.error(`[monitor] sync @${username}: abortando após 5 falhas`); break; }
      await sleep(waitMs);
      continue;
    }
    failures = 0;

    const users = data.users || [];
    if (!users.length) { console.log(`[monitor] sync @${username} pg${pg}: lista vazia — fim`); break; }

    db.transaction(() => { for (const u of users) if (u.pk) insert.run(username, String(u.pk)); })();
    total += users.length;

    if (pg % 5 === 0 || total % 250 === 0)
      monitorSend({ type: 'sync_progress', profile: username, count: total });

    maxId = data.next_max_id || null;
    const hasMore = data.has_more !== false;
    console.log(`[monitor] sync @${username} pg${pg}: +${users.length} (total=${total}) next=${maxId} has_more=${data.has_more}`);

    if (!maxId || !hasMore) break;

    // Delay humanizado: varia entre páginas para parecer leitura humana
    await sleep(humanDelay());
  }

  if (total === 0) {
    console.error(`[monitor] sync @${username}: falhou (0 seguidores obtidos)`);
    db.prepare('UPDATE monitor_profiles SET status = ? WHERE username = ?').run('error', username);
    monitorSend({ type: 'profile_error', profile: username, error: 'Não foi possível obter seguidores. Verifique se o perfil é público e se a sessão do Instagram está válida.' });
    return;
  }

  db.prepare('UPDATE monitor_profiles SET follower_count = ?, status = ?, last_checked = ? WHERE username = ?')
    .run(total, 'active', new Date().toISOString(), username);
  monitorSend({ type: 'sync_done', profile: username, count: total });
  console.log(`[monitor] sync @${username}: ${total} seguidores ✓`);
}

// Poll: busca primeiras páginas e detecta novos
async function monitorPollProfile(username) {
  const web    = monitorAxiosWeb();
  const mobile = monitorAxiosMobile();
  if (!web) return;

  const profile = db.prepare('SELECT * FROM monitor_profiles WHERE username = ?').get(username);
  if (!profile || profile.status === 'syncing') return;

  let userId = profile.ig_user_id;
  try {
    if (!userId) {
      const { userId: uid } = await getUserId(web, username, mobile);
      userId = uid;
      db.prepare('UPDATE monitor_profiles SET ig_user_id = ? WHERE username = ?').run(userId, username);
    }

    const currentUsers = new Map();
    let maxId = null, pollFailed = false;
    for (let pg = 0; pg < monitor.POLL_PAGES; pg++) {
      const { data, status } = await monitorFetchFollowersPage(web, mobile, userId, maxId);

      if (!data) {
        // 400 = userId inválido — tenta renovar e repetir uma vez
        if (status === 400) {
          console.warn(`[monitor] poll @${username}: 400 no userId=${userId} — renovando...`);
          try {
            const { userId: freshId } = await getUserId(web, username, mobile);
            if (freshId && freshId !== userId) {
              userId = freshId;
              db.prepare('UPDATE monitor_profiles SET ig_user_id = ? WHERE username = ?').run(freshId, username);
              console.log(`[monitor] poll @${username}: userId renovado para ${freshId}`);
              continue; // tenta a mesma página com o novo userId
            }
          } catch (refreshErr) { console.warn(`[monitor] renovação userId falhou:`, refreshErr.message); }
        }
        pollFailed = true;
        break;
      }

      const users = data.users || [];
      if (!users.length) break;
      for (const u of users) if (u.pk) currentUsers.set(String(u.pk), u);
      maxId = data.next_max_id || null;
      if (!maxId) break;
      await sleep(humanDelay());
    }

    if (pollFailed && currentUsers.size === 0) {
      console.warn(`[monitor] poll @${username}: falha no fetch de seguidores`);
      return;
    }
    if (currentUsers.size === 0) return;

    const storedCount = db.prepare('SELECT COUNT(*) as n FROM profile_followers WHERE profile_username = ?').get(username)?.n || 0;

    if (storedCount === 0) {
      // Ainda sem snapshot — inicia sync completo em background
      monitorFullSync(username, userId);
      return;
    }

    // Detecta novos
    const storedIds = new Set(
      db.prepare('SELECT follower_id FROM profile_followers WHERE profile_username = ?')
        .all(username).map(r => r.follower_id)
    );

    const insertEvent    = db.prepare('INSERT OR IGNORE INTO monitor_events (profile_username, follower_id, follower_username, follower_fullname, follower_photo, detected_at) VALUES (?, ?, ?, ?, ?, ?)');
    const insertFollower = db.prepare('INSERT OR IGNORE INTO profile_followers (profile_username, follower_id) VALUES (?, ?)');

    let newCount = 0;
    for (const [id, u] of currentUsers) {
      if (!storedIds.has(id)) {
        insertEvent.run(username, id, u.username || '', u.full_name || '', u.profile_pic_url || '', new Date().toISOString());
        insertFollower.run(username, id);
        monitorSend({ type: 'new_follower', profile: username, follower: { id, username: u.username, fullName: u.full_name || '', photoUrl: u.profile_pic_url || '' } });
        newCount++;
      }
    }

    db.prepare('UPDATE monitor_profiles SET last_checked = ?, follower_count = ?, status = ? WHERE username = ?')
      .run(new Date().toISOString(), (profile.follower_count || 0) + newCount, 'active', username);
    monitorSend({ type: 'profile_updated', profile: username, newCount, lastChecked: new Date().toISOString() });
    if (newCount > 0) console.log(`[monitor] @${username}: ${newCount} novos seguidores`);

  } catch (err) {
    console.error(`[monitor] poll @${username}:`, err.message);
    db.prepare('UPDATE monitor_profiles SET status = ? WHERE username = ?').run('error', username);
    monitorSend({ type: 'profile_error', profile: username, error: err.message });
  }
}

// Valida se a sessão do Instagram ainda está ativa
async function monitorCheckSession() {
  const web = monitorAxiosWeb();
  if (!web) return false;
  try {
    const r = await web.get('/api/v1/accounts/current_user/', { params: { edit: false } });
    if (r.status === 200 && r.data?.user) return true;
    if (r.status === 401 || r.status === 302) return false;
    // 429 = sessão ok, só rate limit
    if (r.status === 429) return true;
    // Tenta endpoint alternativo
    const r2 = await web.get('/api/v1/users/web_profile_info/', { params: { username: 'instagram' } });
    return r2.status === 200;
  } catch { return false; }
}

async function monitorRunCycle(manual = false) {
  if (monitor.polling) return;
  monitor.polling = true;

  // Valida sessão antes de qualquer coisa
  const sessionOk = await monitorCheckSession();
  if (!sessionOk) {
    monitor.polling = false;
    console.warn('[monitor] sessão Instagram inválida ou expirada — pausando ciclo');
    monitorSend({ type: 'session_expired' });
    return;
  }

  const profiles = db.prepare('SELECT username FROM monitor_profiles WHERE status != ?').all('paused');
  if (profiles.length > 0) monitorSend({ type: 'cycle_start', manual, profiles: profiles.map(p => p.username) });
  let totalNew = 0;
  for (const { username } of profiles) {
    const before = db.prepare('SELECT COUNT(*) as n FROM monitor_events WHERE profile_username = ?').get(username)?.n || 0;
    await monitorPollProfile(username);
    const after  = db.prepare('SELECT COUNT(*) as n FROM monitor_events WHERE profile_username = ?').get(username)?.n || 0;
    totalNew += Math.max(0, after - before);
    // Pausa humanizada entre perfis: 3-8 segundos
    if (profiles.length > 1) await sleep(randInt(3000, 8000));
  }
  monitor.polling = false;
  monitorSend({ type: 'cycle_done', manual, totalNew, profiles: profiles.map(p => p.username) });

  // Agenda próximo ciclo automático (scheduleNext também envia next_check via SSE)
  if (!manual) monitorScheduleNext();
}

function monitorScheduleNext() {
  if (monitor.timer) clearTimeout(monitor.timer);

  const now  = new Date();
  const hour = now.getHours();
  let next;

  if (hour >= 23 || hour < 7) {
    // Fora do horário — agenda para as 7h do próximo dia com jitter de ±15min
    const tomorrow7h = new Date(now);
    if (hour >= 23) tomorrow7h.setDate(tomorrow7h.getDate() + 1);
    tomorrow7h.setHours(7, randInt(0, 15), randInt(0, 59), 0);
    next = tomorrow7h - now;
    console.log(`[monitor] fora do horário — retoma às ${tomorrow7h.toLocaleTimeString('pt-BR')}`);
  } else {
    next = jitter(monitor.INTERVAL_BASE, 0.25); // 40min ± 25%
    console.log(`[monitor] próximo ciclo em ${Math.round(next/60000)}min`);
  }

  monitor.timer = setTimeout(() => {
    monitor.timer = null;
    monitorRunCycle(false);
  }, next);

  // Informa frontend do próximo horário
  const nextTime = new Date(Date.now() + next);
  const isNextDay = nextTime.getDate() !== new Date().getDate();
  const timeStr = nextTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  monitorSend({
    type: 'next_check',
    label: isNextDay ? `Retoma amanhã às ${timeStr}` : `Próxima verificação: ${timeStr}`
  });
}

function monitorStart() {
  if (monitor.timer) return;
  monitorScheduleNext();
  console.log('[monitor] iniciado — modo stealth (30-50min aleatorizado, 7h-23h)');
}

function monitorStop() {
  if (monitor.timer) { clearTimeout(monitor.timer); monitor.timer = null; }
}

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');

const app  = express();
const ig   = new IgApiClient();
const PORT = process.env.PORT || 3000;

// ============================================
// Middleware
// ============================================
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'ultraprospec-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(__dirname));

// ============================================
// Session helpers  (Instagram fica na sessão, sem DB)
// ============================================
function getIg(req) {
    return req.session.ig || { loggedIn: false, username: null, sessionid: null, csrftoken: null, dsUserId: null };
}

function setIg(req, data) {
    req.session.ig = data;
}

function buildCookie(ig) {
    if (!ig?.sessionid) return '';
    // Usa o cookieString completo quando disponível (login via browser)
    // para evitar detecção como bot pelo Instagram
    if (ig.cookieString) return ig.cookieString;
    const parts = [`sessionid=${ig.sessionid}`];
    if (ig.csrftoken) parts.push(`csrftoken=${ig.csrftoken}`);
    if (ig.dsUserId)  parts.push(`ds_user_id=${ig.dsUserId}`);
    return parts.join('; ');
}

function igWebClient(req) {
    const ig = getIg(req);
    const ua = ig.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    return axios.create({
        baseURL: 'https://www.instagram.com', timeout: 25000,
        maxRedirects: 0, validateStatus: s => s < 500,
        headers: {
            'User-Agent':          ua,
            'Accept':              '*/*',
            'Accept-Language':     'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding':     'gzip, deflate, br',
            'X-IG-App-ID':         '936619743392459',
            'X-ASBD-ID':           '129477',
            'X-CSRFToken':         ig.csrftoken || '',
            'X-Requested-With':    'XMLHttpRequest',
            'X-IG-WWW-Claim':      '0',
            'Referer':             'https://www.instagram.com/',
            'Origin':              'https://www.instagram.com',
            'sec-ch-ua':           '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            'sec-ch-ua-mobile':    '?0',
            'sec-ch-ua-platform':  '"Windows"',
            'sec-fetch-dest':      'empty',
            'sec-fetch-mode':      'cors',
            'sec-fetch-site':      'same-origin',
            'Cookie':              buildCookie(ig),
        }
    });
}

function igMobileClient(req) {
    const ig = getIg(req);
    return axios.create({
        baseURL: 'https://i.instagram.com', timeout: 20000,
        maxRedirects: 3, validateStatus: s => s < 500,
        headers: {
            'User-Agent':     'Instagram 289.0.0.77.109 Android (29/10; 440dpi; 1080x2220; OnePlus; ONEPLUS A6003; OnePlus6; qcom; pt_BR; 482616210)',
            'X-IG-App-ID':   '567067343352427', 'Accept': '*/*',
            'Accept-Language': 'pt-BR,pt;q=0.9',
            'Cookie': buildCookie(ig), 'X-CSRFToken': ig.csrftoken || ''
        }
    });
}

// ============================================
// Utils
// ============================================
function extractWhatsApp(text) {
    if (!text) return null;
    // Normaliza: decodifica URL-encoding (ex: %2F → /) e remove espaços extras
    const t = decodeURIComponent(text).replace(/\s+/g, ' ');
    const patterns = [
        [/wa\.me\/(\+?[\d]+)/i,                              true ],  // wa.me/5511... → captura número
        [/api\.whatsapp\.com\/send[?&]phone=(\+?[\d]+)/i,    true ],  // whatsapp API URL
        [/whatsapp[:\s\/]*(\+?[\d][\d\s().\/\-]{7,})/i,      true ],  // whatsapp: 11 99999-1234
        [/\bzap[:\s\/]*(\+?[\d][\d\s().\/\-]{7,})/i,         true ],  // zap: 11...
        [/\+55[\s\-]?\(?\d{2}\)?[\s\-]?\d[\s.\-]?\d{4}[\s.\-]?\d{4}/, false ], // +55 11 9 9999-1234
        [/\(?\d{2}\)?[\s\-]?\d[\s.\-]?\d{4}[\s.\-]?\d{4}/,  false ], // (11) 9 9999-1234  ← fix espaço
        [/\b55\d{10,11}\b/,                                   false ], // 5511999991234
        [/\b\d{2}[\s.\-]?\d{4,5}[\s.\-]?\d{4}\b/,            false ], // 11 99999-1234
    ];
    for (const [p, hasGroup] of patterns) {
        const m = t.match(p);
        if (!m) continue;
        const raw = hasGroup ? (m[1] || m[0]) : m[0];
        const digits = raw.replace(/[^\d+]/g, '');
        if (digits.length >= 8) return digits;
    }
    return null;
}

function extractEmail(text) {
    if (!text) return null;
    const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return m ? m[0] : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Delay humanizado para capturas de lead: base + jitter de ±30%
// Garante que nenhuma requisição sai em intervalo exato e previsível
function humanSleep(baseMs) {
    const min = Math.round(baseMs * 0.7);
    const max = Math.round(baseMs * 1.4);
    return sleep(randInt(min, max));
}

// ============================================
// Follower Snapshots — comparação para detectar novos seguidores
// ============================================
const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');
if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

function snapshotPath(username) {
    return path.join(SNAPSHOTS_DIR, `followers_${username.replace(/[^a-z0-9_.-]/gi, '_')}.json`);
}

function loadFollowerSnapshot(username) {
    try {
        const p = snapshotPath(username);
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { return null; }
}

function saveFollowerSnapshot(username, followerIds, followerMap) {
    const snap = {
        username,
        capturedAt: new Date().toISOString(),
        count: followerIds.length,
        ids: followerIds,           // array de IDs (string) para comparação rápida
        users: followerMap,         // { id: { username, fullName, photoUrl, ... } }
    };
    fs.writeFileSync(snapshotPath(username), JSON.stringify(snap), 'utf8');
    return snap;
}

// ============================================
function shortcodeToMediaId(shortcode) {
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = BigInt(0);
    for (const c of shortcode) id = id * BigInt(64) + BigInt(alpha.indexOf(c));
    return id.toString();
}

function extractUsername(t) {
    if (t.includes('instagram.com')) {
        const m = t.match(/instagram\.com\/([^/?#]+)/);
        if (!m) throw new Error('URL inválida');
        return m[1].replace('@', '');
    }
    return t.replace('@', '');
}

function extractShortcode(u) {
    const m = u.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
    if (!m) {
        const isProfile = /instagram\.com\/[^/?#]+\/?$/.test(u) && !/\/p\/|\/reel\//.test(u);
        if (isProfile)
            throw new Error('Você colou um link de perfil, mas este modo exige a URL de um post (ex: instagram.com/p/CODIGO). Use "Análise Completa" ou "Seguidores" para extrair de um perfil.');
        throw new Error('URL do post inválida. Cole a URL completa de um post ou reel (ex: instagram.com/p/CODIGO).');
    }
    return m[1];
}

// Detecta respostas de erro/rate-limit do Instagram no body (status HTTP 200 com status:'fail')
function igAssert(data, context) {
    if (!data) return;
    const msg = data.message || data.error_message || '';
    if (data.status === 'fail' || data.spam === true) {
        const label = msg || 'Instagram bloqueou a requisição';
        // Detecta rate-limit especificamente para dar mensagem melhor
        if (msg.toLowerCase().includes('wait') || msg.toLowerCase().includes('few minutes'))
            throw new Error(`Instagram pediu para aguardar: "${msg}". Espere 2-3 minutos e tente novamente.`);
        throw new Error(`Instagram: ${label}${context ? ` (${context})` : ''}`);
    }
    // Checkpoint / challenge required
    if (msg.toLowerCase().includes('checkpoint') || data.checkpoint_url)
        throw new Error('Instagram solicitou verificação. Acesse o app do Instagram e confirme o login.');
}

function buildLead(u, bio, ext, source = '') {
    const txt = `${bio} ${ext}`;
    return { id: String(u.pk||u.id), username: u.username, fullName: u.full_name||'', bio,
             whatsapp: extractWhatsApp(txt) || null, email: extractEmail(txt) || null,
             photoUrl: u.profile_pic_url||'', isPrivate: u.is_private||false,
             source, capturedAt: new Date().toISOString(),
             // campos de engajamento — preenchidos pelo caller
             isFollower: false, likeCount: 0, commentCount: 0,
             crossCount: 0, mostRecentLike: 0, mostRecentComment: 0,
             publicPhone: '', publicEmail: '', city: '',
             followerCount: 0, followingCount: 0, mediaCount: 0,
             isBusinessAccount: false, category: '', actions: [] };
}

// Enriquece um lead com dados completos do fetchBio e re-extrai whatsapp/email de todas as fontes
function enrichLead(lead, bioData) {
    if (!bioData) return lead;
    if (bioData.bio)           lead.bio              = bioData.bio;
    lead.publicPhone           = bioData.publicPhone  || '';
    lead.publicEmail           = bioData.publicEmail  || '';
    lead.city                  = bioData.city         || '';
    lead.followerCount         = bioData.followerCount   || 0;
    lead.followingCount        = bioData.followingCount  || 0;
    lead.mediaCount            = bioData.mediaCount      || 0;
    lead.isBusinessAccount     = bioData.isBusinessAccount || false;
    lead.category              = bioData.category        || '';

    // Re-extrai WhatsApp e email de TODAS as fontes disponíveis combinadas
    const fullText = [
        bioData.bio         || '',
        bioData.externalUrl || '',
        bioData.publicPhone || '',
        bioData.publicEmail || ''
    ].join(' ');

    if (!lead.whatsapp) lead.whatsapp = extractWhatsApp(fullText) || null;
    if (!lead.email)    lead.email    = extractEmail(fullText)    || null;
    return lead;
}

async function getUserId(webClient, username, mobileClient) {
    // Tentativa 1 — endpoint web
    let res;
    try {
        res = await webClient.get('/api/v1/users/web_profile_info/', { params: { username } });
    } catch (netErr) {
        console.warn(`[getUserId @${username}] erro de rede: ${netErr.message}`);
        throw new Error(`Erro de rede ao buscar @${username}: ${netErr.message}`);
    }

    console.log(`[getUserId @${username}] web status=${res.status} ct=${(res.headers?.['content-type']||'').slice(0,40)}`);

    if (res.status === 302 || res.status === 401)
        throw new Error('Sessão do Instagram expirada. Clique em "Conectar IG" e reconecte sua conta.');

    if (res.status === 429) {
        console.warn(`[getUserId @${username}] 429 body: ${JSON.stringify(res.data||{}).slice(0,200)}`);
        // Fallback: tenta endpoint mobile (diferente base URL e User-Agent → menos bloqueado)
        if (mobileClient) {
            try {
                console.log(`[getUserId @${username}] tentando mobile search...`);
                const mr = await mobileClient.get('/api/v1/users/search/', { params: { q: username, count: 5 } });
                console.log(`[getUserId @${username}] mobile status=${mr.status}`);
                if (mr.status === 200) {
                    const users = mr.data?.users || [];
                    const match = users.find(u => u.username?.toLowerCase() === username.toLowerCase());
                    const mu = match || users[0];
                    const mid = mu?.pk || mu?.id;
                    if (mid) { console.log(`[getUserId @${username}] mobile OK id=${mid}`); return { userId: String(mid) }; }
                }
                // Fallback 2 — web_profile_info via mobile base URL
                console.log(`[getUserId @${username}] tentando mobile web_profile_info...`);
                const mr2 = await mobileClient.get('/api/v1/users/web_profile_info/', { params: { username } });
                console.log(`[getUserId @${username}] mobile wpi status=${mr2.status}`);
                if (mr2.status === 200) {
                    const mu2 = mr2.data?.data?.user;
                    const mid2 = mu2?.id || mu2?.pk;
                    if (mid2) { console.log(`[getUserId @${username}] mobile wpi OK id=${mid2}`); return { userId: String(mid2) }; }
                }
            } catch (mErr) {
                console.warn(`[getUserId @${username}] mobile fallback erro: ${mErr.message}`);
            }
        }
        throw new Error('Instagram bloqueou temporariamente por excesso de requisições (rate limit). Aguarde 15–30 minutos e tente novamente.');
    }

    if (res.status === 400)
        throw new Error(`Perfil @${username} não encontrado. Verifique se o nome de usuário está correto.`);

    if (res.status !== 200)
        throw new Error(`Instagram retornou status ${res.status}. Aguarde alguns minutos e tente novamente.`);

    igAssert(res.data, `busca de @${username}`);

    const user = res.data?.data?.user;

    if (!user) {
        const snippet = JSON.stringify(res.data || {}).slice(0, 200);
        console.warn(`[getUserId @${username}] user=null. Resposta: ${snippet}`);

        const bodyStr = JSON.stringify(res.data || '').toLowerCase();
        const looksLikeAuthFail =
            bodyStr.includes('login') || bodyStr.includes('require_login') ||
            bodyStr.includes('not_logged_in') ||
            res.headers?.['content-type']?.includes('text/html') ||
            Object.keys(res.data || {}).length === 0;

        if (looksLikeAuthFail)
            throw new Error('Sessão do Instagram expirada ou inválida. Clique em "Conectar IG" e reconecte.');

        throw new Error(`Perfil @${username} não encontrado ou é privado. Certifique-se de que o perfil existe e é público.`);
    }

    const id = user.id || user.pk;
    if (!id) throw new Error(`Não foi possível obter o ID de @${username}`);
    return { userId: id };
}

// fetchBio: tenta web client primeiro (mais confiável), cai no mobile como fallback
async function fetchBio(webClient, mobileClient, pk, username) {
    // Tentativa 1 — web profile info (endpoint já comprovado funcionar)
    if (username) {
        try {
            const r = await webClient.get('/api/v1/users/web_profile_info/', { params: { username } });
            if (r.data?.status !== 'fail') {
                const u = r.data?.data?.user;
                if (u) return {
                    bio:               u.biography                           || '',
                    externalUrl:       u.external_url                        || '',
                    followerCount:     u.edge_followed_by?.count             || 0,
                    followingCount:    u.edge_follow?.count                  || 0,
                    mediaCount:        u.edge_owner_to_timeline_media?.count || 0,
                    isBusinessAccount: !!(u.is_business_account || u.is_professional_account),
                    category:          u.category_name                       || '',
                    publicPhone:       u.business_phone_number               || '',
                    publicEmail:       u.business_email                      || '',
                    city:              ''
                };
            }
        } catch {}
    }
    // Tentativa 2 — mobile API (tem mais campos como publicPhone/city)
    if (pk) {
        try {
            const r = await mobileClient.get(`/api/v1/users/${pk}/info/`);
            if (r.data?.status !== 'fail') {
                const u = r.data?.user;
                if (u) return {
                    bio:               u.biography             || '',
                    externalUrl:       u.external_url          || '',
                    followerCount:     u.follower_count        || 0,
                    followingCount:    u.following_count       || 0,
                    mediaCount:        u.media_count           || 0,
                    isBusinessAccount: !!(u.is_business || u.is_professional_account),
                    category:          u.category              || '',
                    publicPhone:       u.public_phone_number   || '',
                    publicEmail:       u.public_email          || '',
                    city:              u.city_name             || ''
                };
            }
        } catch {}
    }
    return null;
}

// ============================================
// INSTAGRAM ROUTES
// ============================================
app.get('/api/status', (req, res) => {
    const ig = getIg(req);
    // Sempre atualiza credenciais do monitor ao verificar status
    // garante que o polling continua após reload de página
    if (ig.loggedIn && ig.sessionid) {
        monitor.credentials = { ...ig }; saveMonitorCredentials(ig);
        if (db.prepare('SELECT COUNT(*) as n FROM monitor_profiles').get()?.n > 0)
            monitorStart();
    }
    res.json({ loggedIn: ig.loggedIn || false, user: ig.loggedIn ? { username: ig.username } : null });
});

app.post('/api/logout', (req, res) => {
    setIg(req, { loggedIn: false, username: null, sessionid: null, csrftoken: null, dsUserId: null });
    res.json({ success: true });
});

app.post('/api/login-cookie', (req, res) => {
    const { sessionid, username, csrftoken, dsUserId, cookieString, userAgent } = req.body;
    if (!sessionid) return res.status(400).json({ error: 'sessionid obrigatório' });
    const user = (username || dsUserId || 'usuario').trim().replace('@', '');
    const igData = {
        loggedIn:     true,
        username:     user,
        sessionid:    sessionid.trim(),
        csrftoken:    (csrftoken  || '').trim(),
        dsUserId:     (dsUserId   || '').trim(),
        cookieString: cookieString || '',
        userAgent:    userAgent    || '',
    };
    setIg(req, igData);
    // Atualiza credenciais do monitor automaticamente
    monitor.credentials = { ...igData };
    if (db.prepare('SELECT COUNT(*) as n FROM monitor_profiles').get()?.n > 0) monitorStart();
    return res.json({ success: true, user: { username: user } });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Usuário e senha obrigatórios' });
    try {
        ig.state.generateDevice(username);
        const user = await ig.account.login(username, password);
        if (ig.state.checkpoint) { try { await ig.challenge.auto(true); } catch (_) {} return res.json({ checkpointRequired: true }); }
        try { await ig.account.currentUser(); } catch (e) {
            if ((e.message||'').includes('checkpoint')) { try { await ig.challenge.auto(true); } catch (_) {} return res.json({ checkpointRequired: true }); }
            throw e;
        }
        setIg(req, { loggedIn: true, username: user.username, sessionid: null, csrftoken: null, dsUserId: null });
        return res.json({ success: true, user: { username: user.username } });
    } catch (err) {
        const isChk = err instanceof IgCheckpointError || (err.message||'').includes('checkpoint');
        if (isChk) { try { await ig.challenge.auto(true); } catch (_) {} return res.json({ checkpointRequired: true }); }
        return res.status(401).json({ error: err.message?.includes('bad_password') ? 'Usuário ou senha incorretos' : err.message });
    }
});

app.post('/api/challenge', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Código obrigatório' });
    try {
        await ig.challenge.delta(code.trim());
        const user = await ig.account.currentUser();
        setIg(req, { loggedIn: true, username: user.username, sessionid: null, csrftoken: null, dsUserId: null });
        res.json({ success: true, user: { username: user.username } });
    } catch { res.status(400).json({ error: 'Código inválido ou expirado.' }); }
});

// ============================================
// PAYMENT ROUTES — Stripe (créditos unificados)
// 50 leads = R$10 | 150 leads = R$25 | 500 leads = R$70
// ============================================
const PACKS = {
    pack50:  { credits: 50,  price: 1000, name: 'UltraProspec — 50 Leads',  desc: '50 leads · Instagram ou Google Maps · R$0,20/lead' },
    pack150: { credits: 150, price: 2500, name: 'UltraProspec — 150 Leads', desc: '150 leads · Instagram ou Google Maps · economia de 16%' },
    pack500: { credits: 500, price: 7000, name: 'UltraProspec — 500 Leads', desc: '500 leads · Instagram ou Google Maps · economia de 30%' },
};

app.post('/api/payment/create', async (req, res) => {
    if (!process.env.STRIPE_SECRET_KEY)
        return res.status(500).json({ error: 'STRIPE_SECRET_KEY não configurada no .env' });

    const packKey = ['pack50','pack150','pack500'].includes(req.body.pack) ? req.body.pack : 'pack50';
    const pack    = PACKS[packKey];
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency:     'brl',
                    product_data: { name: pack.name, description: pack.desc },
                    unit_amount:  pack.price
                },
                quantity: 1
            }],
            mode:        'payment',
            success_url: `${baseUrl}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url:  `${baseUrl}/app.html`,
            metadata:    { credits: String(pack.credits) }
        });
        res.json({ checkoutUrl: session.url });
    } catch (err) {
        console.error('Stripe error:', err.message);
        res.status(500).json({ error: 'Erro ao criar sessão de pagamento: ' + err.message });
    }
});

// Verificação após redirect do Stripe
app.get('/api/payment/verify', async (req, res) => {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id obrigatório' });

    if (!req.session.verifiedSessions) req.session.verifiedSessions = [];
    if (req.session.verifiedSessions.includes(session_id))
        return res.json({ approved: false, alreadyUsed: true });

    try {
        const session = await stripe.checkout.sessions.retrieve(session_id);
        if (session.payment_status !== 'paid')
            return res.json({ approved: false, status: session.payment_status });

        req.session.verifiedSessions.push(session_id);
        const credits = parseInt(session.metadata?.credits) || 50;
        res.json({ approved: true, credits, amount: session.amount_total / 100 });
    } catch (err) {
        console.error('Stripe verify error:', err.message);
        res.status(500).json({ error: 'Erro ao verificar pagamento: ' + err.message });
    }
});

// Webhook Stripe (opcional — backup para casos onde redirect falha)
app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const sig = req.headers['stripe-signature'];
    if (!sig || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(200);
    try {
        const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        if (event.type === 'checkout.session.completed') {
            const s = event.data.object;
            console.log(`✅ Stripe pago: ${s.amount_total/100} BRL — session ${s.id}`);
        }
    } catch (err) { console.warn('Webhook sig error:', err.message); }
    res.sendStatus(200);
});

// ============================================
// FOLLOWER SNAPSHOT INFO — status do snapshot salvo
// ============================================
app.get('/api/ig/follower-snapshot', (req, res) => {
    const { username } = req.query;
    if (!username) return res.json({ exists: false });
    const snap = loadFollowerSnapshot(username.replace('@',''));
    if (!snap) return res.json({ exists: false });
    const ageMin = Math.round((Date.now() - new Date(snap.capturedAt)) / 60000);
    res.json({ exists: true, count: snap.count, capturedAt: snap.capturedAt, ageMin });
});

app.delete('/api/ig/follower-snapshot', (req, res) => {
    const { username } = req.query;
    if (!username) return res.json({ ok: false });
    try {
        const p = snapshotPath(username.replace('@',''));
        if (fs.existsSync(p)) fs.unlinkSync(p);
        res.json({ ok: true });
    } catch { res.json({ ok: false }); }
});

// ============================================
// PROFILE CHECK — valida seguidores antes de capturar
// ============================================
app.get('/api/ig/profile-check', async (req, res) => {
    const ig = getIg(req);
    if (!ig.loggedIn) return res.status(401).json({ ok: false, error: 'Não autenticado' });

    const { username } = req.query;
    if (!username) return res.status(400).json({ ok: false, error: 'username obrigatório' });

    try {
        const web = igWebClient(req);
        const r   = await web.get('/api/v1/users/web_profile_info/', { params: { username: username.replace('@','') } });
        if (r.status === 302 || r.status === 401)
            return res.json({ ok: false, error: 'Sessão expirada. Reconecte o Instagram.' });
        const user = r.data?.data?.user;
        if (!user) return res.json({ ok: false, error: `Perfil @${username} não encontrado ou é privado.` });

        const followers = user.edge_followed_by?.count || 0;
        res.json({ ok: true, followers, username: user.username });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

// Helper: completa leads com seguidores até atingir o target
async function autoFillFollowers(web, mobile, userId, username, sentIds, target, shouldFetchBio, delayTime, sendLead, send, stoppedFn) {
    const needed = target - sentIds.size;
    if (needed <= 0) return;
    send({ type: 'log', message: `Completando com ${needed} seguidores adicionais de @${username}...` });
    let maxId = null, filled = 0;
    for (let pg = 0; pg < 20 && filled < needed && !stoppedFn(); pg++) {
        try {
            const r = await web.get(`/api/v1/friendships/${userId}/followers/`, { params: { count: 50, ...(maxId ? { max_id: maxId } : {}) } });
            igAssert(r.data, 'auto-fill');
            const users = r.data?.users || [];
            if (!users.length) break;
            for (const u of users) {
                if (filled >= needed || stoppedFn()) break;
                const id = String(u.pk);
                if (sentIds.has(id)) continue;
                sentIds.add(id);
                const lead = buildLead(u, '', '', `seguidor @${username}`);
                lead.isFollower = true;
                if (shouldFetchBio) {
                    const d = await fetchBio(web, mobile, u.pk, u.username);
                    enrichLead(lead, d);
                    await humanSleep(delayTime);
                }
                sendLead(lead);
                filled++;
            }
            maxId = r.data?.next_max_id;
            if (!maxId) break;
            await humanSleep(900);
        } catch { break; }
    }
    if (filled > 0) send({ type: 'log', message: `✓ +${filled} seguidores adicionados` });
}

// ============================================
// CAPTURE — SSE  (créditos controlados pelo cliente/localStorage)
// ============================================
app.get('/api/capture', async (req, res) => {
    const ig = getIg(req);
    if (!ig.loggedIn) return res.status(401).json({ error: 'Conecte sua conta do Instagram primeiro' });

    const { type='followers', target='', delay:delayMs='1500', fetchBio:fetchBioParam='false', posts='10' } = req.query;
    console.log(`[capture] type=${type} target=${target} fetchBio=${fetchBioParam}`);
    const maxLeads       = 50; // fixo — 1 crédito = 50 leads
    const delayTime      = Math.max(parseInt(delayMs)||1500, 1500); // mínimo 1.5s para não parecer bot
    const shouldFetchBio = fetchBioParam === 'true';
    const postsCount     = Math.min(parseInt(posts)||10, 30);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let stopped = false;
    req.on('close', () => { stopped = true; });

    const send = d => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(d)}\n\n`); };
    const end  = () => { if (!res.writableEnded) res.end(); };
    // Créditos são controlados pelo front (localStorage) — server apenas envia o lead
    const sendLead = lead => { send({ type: 'lead', lead }); return true; };

    try {
        const web    = igWebClient(req);
        const mobile = igMobileClient(req);

        if (type === 'profile_analysis') {
            const username = extractUsername(target);
            send({ type:'log', message:`Iniciando análise de @${username}...` });
            const { userId } = await getUserId(web, username, mobile);
            const uMap=new Map(), followerIds=new Set(), likerCounts=new Map(), commenterCounts=new Map();
            const recentLike=new Map(), recentComment=new Map();

            send({ type:'log', message:'Fase 1/3 — Seguidores...' });
            let maxId=null;
            for (let pg=0; pg<400&&!stopped; pg++) {
                const r=await web.get(`/api/v1/friendships/${userId}/followers/`,{params:{count:50,...(maxId?{max_id:maxId}:{})}});
                igAssert(r.data, 'seguidores');
                const users=r.data?.users||[]; if(!users.length)break;
                for(const u of users){followerIds.add(String(u.pk));uMap.set(String(u.pk),u);}
                maxId=r.data?.next_max_id; if(!maxId)break;
                if(pg%5===0)send({type:'log',message:`Fase 1/3 — ${followerIds.size} seguidores...`});
                await humanSleep(1000);
            }
            send({type:'log',message:`✓ ${followerIds.size} seguidores`});

            send({type:'log',message:'Fase 2/3 — Posts recentes...'});
            const feed=await web.get(`/api/v1/feed/user/${userId}/`,{params:{count:postsCount}});
            igAssert(feed.data, 'feed');
            const postsList=(feed.data?.items||[]).slice(0,postsCount);
            send({type:'log',message:`✓ ${postsList.length} posts`});

            send({type:'log',message:'Fase 3/3 — Engajamento...'});
            for(let i=0;i<postsList.length&&!stopped;i++){
                send({type:'log',message:`Fase 3/3 — Post ${i+1}/${postsList.length}...`});
                const ts=postsList[i].taken_at||0;
                try{const lr=await web.get(`/api/v1/media/${postsList[i].id}/likers/`);igAssert(lr.data,'likers');for(const u of lr.data?.users||[]){const id=String(u.pk);likerCounts.set(id,(likerCounts.get(id)||0)+1);if(!recentLike.has(id)||ts>recentLike.get(id))recentLike.set(id,ts);if(!uMap.has(id))uMap.set(id,u);}}catch(e){send({type:'log',message:`⚠️ likers post ${i+1}: ${e.message}`});}
                try{const cr=await web.get(`/api/v1/media/${postsList[i].id}/comments/`);igAssert(cr.data,'comments');for(const c of cr.data?.comments||[]){const u=c.user;if(!u)continue;const id=String(u.pk);commenterCounts.set(id,(commenterCounts.get(id)||0)+1);if(!recentComment.has(id)||ts>recentComment.get(id))recentComment.set(id,ts);if(!uMap.has(id))uMap.set(id,u);}}catch(e){send({type:'log',message:`⚠️ comments post ${i+1}: ${e.message}`});}
                await humanSleep(delayTime);
            }

            const toEnrich=[...new Set([...commenterCounts.keys(),...[...likerCounts.entries()].filter(([,c])=>c>=2).map(([id])=>id),...[...followerIds].filter(id=>likerCounts.has(id)||commenterCounts.has(id))])].slice(0,400);
            const enriched=new Map();
            if(toEnrich.length){
                send({type:'log',message:`Enriquecendo ${toEnrich.length} perfis...`});
                for(let i=0;i<toEnrich.length&&!stopped;i++){const tpk=toEnrich[i];enriched.set(tpk,await fetchBio(web,mobile,tpk,uMap.get(tpk)?.username));if(i%10===0)send({type:'log',message:`Enriquecendo: ${i+1}/${toEnrich.length}...`});await humanSleep(900);}
            }

            const recM=ts=>{if(!ts)return 0;const d=(Date.now()/1000-ts)/86400;return d<=1?2:d<=3?1.6:d<=7?1.3:d<=30?1:d<=90?0.6:0.3;};
            const score=l=>{let s=0;if(l.mostRecentComment){s+=Math.round(38*recM(l.mostRecentComment));if(l.commentCount>=3)s+=8;}if(l.mostRecentLike)s+=Math.round((l.likeCount>=3?22:14)*recM(l.mostRecentLike));if(l.isFollower)s+=15;if(l.crossCount>=2)s+=15;if(l.whatsapp)s+=20;if(l.publicPhone)s+=15;if(l.email)s+=12;if(l.publicEmail)s+=10;if(l.mediaCount>10)s+=8;else if(l.mediaCount>0)s+=3;if(l.bio?.length>20)s+=5;if(!l.isPrivate)s+=5;if(l.followingCount>0&&(l.followerCount/l.followingCount)<0.5)s+=5;return Math.min(s,100);};

            const allIds=new Set([...followerIds,...likerCounts.keys(),...commenterCounts.keys()]);
            const leads=[];
            for(const id of allIds){
                const u=uMap.get(id);if(!u)continue;
                const r=enriched.get(id)||{};
                const bio=r.bio||u.biography||'',ext=r.externalUrl||u.external_url||'',txt=`${bio} ${ext} ${r.publicPhone||''} ${r.publicEmail||''}`;
                leads.push({id,username:u.username,fullName:u.full_name||'',bio,whatsapp:extractWhatsApp(txt),email:extractEmail(txt),photoUrl:u.profile_pic_url||'',isPrivate:u.is_private||false,source:`@${username}`,isFollower:followerIds.has(id),likeCount:likerCounts.get(id)||0,commentCount:commenterCounts.get(id)||0,actions:[],mostRecentLike:recentLike.get(id)||0,mostRecentComment:recentComment.get(id)||0,followerCount:r.followerCount||0,followingCount:r.followingCount||0,mediaCount:r.mediaCount||0,isBusinessAccount:r.isBusinessAccount||false,category:r.category||'',publicPhone:r.publicPhone||'',publicEmail:r.publicEmail||'',city:r.city||'',capturedAt:new Date().toISOString()});
            }
            leads.sort((a,b)=>score(b)-score(a));
            send({type:'log',message:`✓ ${leads.length} leads. Enviando...`});
            const sentIds = new Set();
            let count=0;for(const lead of leads){if(count>=maxLeads||stopped)break;sendLead(lead);sentIds.add(lead.id);count++;}
            // Auto-fill se menos de 50 leads qualificados
            if (count < maxLeads && !stopped) {
                await autoFillFollowers(web, mobile, userId, username, sentIds, maxLeads, shouldFetchBio, delayTime, sendLead, send, ()=>stopped);
            }

        } else if (type==='recent_followers') {
            const username = extractUsername(target);
            const { userId } = await getUserId(web, username, mobile);
            const snapshot  = loadFollowerSnapshot(username);

            // Busca seguidores em batch — até 20 páginas (1000) para cobrir contas maiores
            send({ type:'log', message: snapshot
                ? `Buscando seguidores atuais de @${username} para comparar com snapshot...`
                : `1ª execução — criando snapshot base de @${username}...` });

            const currentMap = new Map(); // pk → user object
            let maxId = null;
            const maxPages = 20;

            for (let pg = 0; pg < maxPages && !stopped; pg++) {
                const r = await web.get(`/api/v1/friendships/${userId}/followers/`, {
                    params: { count: 50, ...(maxId ? { max_id: maxId } : {}) }
                });
                if (r.status === 302 || r.status === 401)
                    throw new Error('Sessão expirada. Clique em "Conectar IG" e reconecte.');
                if (r.status === 429)
                    throw new Error('Instagram bloqueou temporariamente. Aguarde alguns minutos.');
                igAssert(r.data, 'recent_followers');
                const users = r.data?.users || [];
                if (!users.length) break;
                for (const u of users) if (u.pk) currentMap.set(String(u.pk), u);
                send({ type:'log', message:`Carregando... ${currentMap.size} seguidores` });
                maxId = r.data?.next_max_id || null;
                if (!maxId) break;
                await sleep(600);
            }

            const currentIds  = [...currentMap.keys()];
            const followerMap = Object.fromEntries([...currentMap.entries()].map(([k, v]) => [k, { username: v.username, fullName: v.full_name || '', photoUrl: v.profile_pic_url || '' }]));

            if (!snapshot) {
                // Primeira execução: salva snapshot e informa usuário
                saveFollowerSnapshot(username, currentIds, followerMap);
                send({ type:'log', message:`✅ Snapshot criado: ${currentIds.length} seguidores registrados.` });
                send({ type:'error', message:`Snapshot criado com ${currentIds.length} seguidores de @${username}. Execute novamente em algumas horas para ver quem seguiu depois.` });
            } else {
                // Execuções seguintes: retorna apenas os novos
                const oldIds   = new Set(snapshot.ids || []);
                const newUsers = currentIds
                    .filter(id => !oldIds.has(id))
                    .map(id => currentMap.get(id))
                    .filter(Boolean);

                send({ type:'log', message:`✓ ${newUsers.length} novos seguidores desde ${new Date(snapshot.capturedAt).toLocaleDateString('pt-BR')}` });

                // Atualiza snapshot com lista atual
                saveFollowerSnapshot(username, currentIds, followerMap);

                if (newUsers.length === 0) {
                    send({ type:'error', message:`Nenhum seguidor novo desde o último snapshot (${new Date(snapshot.capturedAt).toLocaleDateString('pt-BR')}). Tente mais tarde.` });
                } else {
                    let order = 1;
                    for (const u of newUsers) {
                        if (stopped) break;
                        const lead = buildLead(u, u.biography || '', u.external_url || '', `novos seguidores @${username}`);
                        lead.isFollower          = true;
                        lead.recentFollowerOrder = order++;
                        sendLead(lead);
                    }
                }
            }

        } else if (type==='followers') {
            const username=extractUsername(target);
            send({type:'log',message:`Seguidores de @${username}...`});
            const {userId}=await getUserId(web, username, mobile);
            let count=0,maxId=null;
            while(count<maxLeads&&!stopped){
                const r=await web.get(`/api/v1/friendships/${userId}/followers/`,{params:{count:50,...(maxId?{max_id:maxId}:{})}});
                if(r.status===302||r.status===401)throw new Error('Session expirada. Reconecte o Instagram.');
                igAssert(r.data,'followers');
                const users=r.data?.users||[];if(!users.length)break;
                for(const u of users){
                    if(count>=maxLeads||stopped)break;
                    const lead=buildLead(u,'','',`seguidores @${username}`);
                    lead.isFollower=true;
                    if(shouldFetchBio){ const d=await fetchBio(web,mobile,u.pk,u.username); enrichLead(lead,d); await humanSleep(delayTime); }
                    sendLead(lead); count++;
                }
                maxId=r.data?.next_max_id;if(!maxId)break;await humanSleep(delayTime);
            }

        } else if (type==='likes') {
            const mediaId=shortcodeToMediaId(extractShortcode(target));
            send({type:'log',message:'Buscando curtidores...'});
            const r=await web.get(`/api/v1/media/${mediaId}/likers/`);
            igAssert(r.data,'likers');
            let count=0;
            for(const u of r.data?.users||[]){
                if(count>=maxLeads||stopped)break;
                const lead=buildLead(u,'','','curtidores');
                lead.likeCount=1;
                if(shouldFetchBio){ const d=await fetchBio(web,mobile,u.pk,u.username); enrichLead(lead,d); await humanSleep(delayTime); }
                sendLead(lead); count++;
            }

        } else if (type==='recent_likes') {
            const username=extractUsername(target);
            const {userId}=await getUserId(web, username, mobile);
            const feed=await web.get(`/api/v1/feed/user/${userId}/`,{params:{count:postsCount}});
            igAssert(feed.data,'feed');
            const postsList=(feed.data?.items||[]).slice(0,postsCount);
            send({type:'log',message:`${postsList.length} posts. Coletando curtidores...`});
            const seen=new Set();let count=0;
            for(let i=0;i<postsList.length&&!stopped;i++){
                send({type:'log',message:`Post ${i+1}/${postsList.length}...`});
                try{
                    const lr=await web.get(`/api/v1/media/${postsList[i].id}/likers/`);
                    igAssert(lr.data,'likers');
                    for(const u of(lr.data?.users||[])){
                        if(count>=maxLeads||stopped)break;
                        if(seen.has(String(u.pk)))continue; seen.add(String(u.pk));
                        const lead=buildLead(u,'','',`curtidor @${username}`);
                        lead.likeCount=1;
                        if(shouldFetchBio){ const d=await fetchBio(web,mobile,u.pk,u.username); enrichLead(lead,d); await humanSleep(delayTime); }
                        sendLead(lead); count++;
                    }
                }catch(e){send({type:'log',message:`⚠️ Post ${i+1}: ${e.message}`});}
                await humanSleep(delayTime);
            }
            // Auto-fill se likers < 50
            if (count < maxLeads && !stopped) {
                try {
                    const { userId: rlUid } = await getUserId(web, username, mobile);
                    await autoFillFollowers(web, mobile, rlUid, username, seen, maxLeads, shouldFetchBio, delayTime, sendLead, send, ()=>stopped);
                } catch {}
            }

        } else if (type==='comments') {
            const mediaId=shortcodeToMediaId(extractShortcode(target));
            send({type:'log',message:'Buscando comentaristas...'});
            const seen=new Set();let minId=null,count=0;
            while(count<maxLeads&&!stopped){
                const r=await web.get(`/api/v1/media/${mediaId}/comments/`,{params:{can_support_threading:true,...(minId?{min_id:minId}:{})}});
                igAssert(r.data,'comments');
                const comments=r.data?.comments||[];if(!comments.length)break;
                for(const c of comments){
                    if(count>=maxLeads||stopped)break;
                    const u=c.user; if(!u||seen.has(String(u.pk)))continue; seen.add(String(u.pk));
                    const lead=buildLead(u,'','','comentarista');
                    lead.commentCount=1;
                    if(shouldFetchBio){ const d=await fetchBio(web,mobile,u.pk,u.username); enrichLead(lead,d); await humanSleep(delayTime); }
                    sendLead(lead); count++;
                }
                minId=r.data?.next_min_id;if(!minId)break;await humanSleep(delayTime);
            }

        } else if (type==='hashtag') {
            const profileTarget=extractUsername((req.query.profileTarget||'').trim());
            const keywords=target.split(',').map(k=>k.trim().replace(/^#/,'')).filter(Boolean);
            if(!keywords.length)throw new Error('Informe pelo menos uma palavra-chave');
            if(!profileTarget)throw new Error('Informe o perfil alvo');
            const profissao=keywords.join(', ');
            const norm=t=>(t||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
            const stopW=new Set(['de','do','da','dos','das','e','o','a','os','as','em','para','com','por','que','se','na','no','nas','nos','um','uma','ao','aos']);
            const tokens=keywords.flatMap(kw=>norm(kw).split(/\s+/).filter(w=>w.length>2&&!stopW.has(w)));
            const matchProf=(u,bio)=>{if(!tokens.length)return true;const t=norm([u.username,u.full_name,bio?.bio,bio?.category].join(' '));return tokens.some(tk=>t.includes(tk));};
            const {userId:targetId}=await getUserId(web, profileTarget, mobile);
            const seen=new Set(),allUsers=[];
            for(const ep of['followers','following']){
                if(stopped)break;let maxId=null;
                for(let pg=0;!stopped;pg++){
                    try{
                        const fr=await web.get(`/api/v1/friendships/${targetId}/${ep}/`,{params:{count:50,...(maxId?{max_id:maxId}:{})}});
                        igAssert(fr.data, ep);
                        const users=fr.data?.users||[];if(!users.length)break;
                        for(const u of users){const uid=String(u.pk||u.id);if(uid&&!seen.has(uid)){seen.add(uid);allUsers.push(u);}}
                        send({type:'log',message:`Coletando ${ep}: ${allUsers.length}...`});
                        maxId=fr.data?.next_max_id;if(!maxId)break;await humanSleep(1000);
                    }catch(e){send({type:'log',message:`⚠️ ${ep}: ${e.message}`});break;}
                }
            }
            send({type:'log',message:`✓ ${allUsers.length} perfis. Filtrando por "${profissao}"...`});
            const quick=[],needBio=[];
            for(const u of allUsers){const q=norm(`${u.username} ${u.full_name}`);if(tokens.some(t=>q.includes(t)))quick.push(u);else needBio.push(u);}
            let count=0;
            const emit=(u,bioData)=>{
                if(count>=maxLeads||stopped)return false;
                const uid=String(u.pk||u.id),bio=bioData?.bio||'',ext=bioData?.externalUrl||'';
                const lead=buildLead({...u,pk:uid},bio,ext,`busca: ${profissao}`);
                enrichLead(lead,bioData);
                sendLead(lead); count++; return true;
            };
            const B=3;
            for(let i=0;i<quick.length&&count<maxLeads&&!stopped;i+=B){const bt=quick.slice(i,i+B);const bs=await Promise.all(bt.map(u=>fetchBio(web,mobile,String(u.pk||u.id),u.username)));let ok=true;bt.forEach((u,j)=>{if(ok)ok=emit(u,bs[j])!==false;});if(!ok)break;await humanSleep(900);}
            let bc=0;
            for(let i=0;i<needBio.length&&count<maxLeads&&!stopped;i+=B){const bt=needBio.slice(i,i+B);const bs=await Promise.all(bt.map(u=>fetchBio(web,mobile,String(u.pk||u.id),u.username)));let ok=true;bt.forEach((u,j)=>{if(ok&&matchProf(u,bs[j]))ok=emit(u,bs[j])!==false;});bc+=bt.length;if(!ok)break;if(bc%40===0||i+B>=needBio.length)send({type:'log',message:`Bio: ${bc}/${needBio.length} — ${count} encontrados`});await humanSleep(900);}
            // Auto-fill com seguidores se busca retornou menos de 50
            if (count < maxLeads && !stopped) {
                try {
                    const htSeen = new Set(seen);
                    await autoFillFollowers(web, mobile, targetId, profileTarget, htSeen, maxLeads, false, delayTime, sendLead, send, ()=>stopped);
                } catch {}
            }

        } else if (type==='common_followers') {
            const usernames=target.split(',').map(u=>u.trim().replace('@','')).filter(Boolean);
            if(usernames.length<2)throw new Error('Informe pelo menos 2 perfis');
            const sets=[],maps=[];
            for(const uname of usernames){
                if(stopped)break;
                send({type:'log',message:`Coletando @${uname}...`});
                try{
                    const {userId}=await getUserId(web, uname, mobile);
                    const fMap=new Map();let maxId=null;
                    for(let pg=0;pg<400&&!stopped;pg++){
                        const r=await web.get(`/api/v1/friendships/${userId}/followers/`,{params:{count:50,...(maxId?{max_id:maxId}:{})}});
                        igAssert(r.data,`followers @${uname}`);
                        const users=r.data?.users||[];if(!users.length)break;
                        for(const u of users)fMap.set(String(u.pk),u);
                        maxId=r.data?.next_max_id;if(!maxId)break;
                        send({type:'log',message:`@${uname}: ${fMap.size}...`});
                        await humanSleep(1000);
                    }
                    sets.push(new Set(fMap.keys()));maps.push(fMap);
                    send({type:'log',message:`@${uname}: ${fMap.size} ✓`});
                }catch(e){send({type:'log',message:`⚠️ @${uname}: ${e.message}`});}
            }
            const idCount=new Map();for(const s of sets)for(const id of s)idCount.set(id,(idCount.get(id)||0)+1);
            const commonIds=[...idCount.entries()].filter(([,c])=>c>=2).sort(([,a],[,b])=>b-a).map(([id])=>id);
            send({type:'log',message:`${commonIds.length} em comum`});
            let count=0;
            for(const id of commonIds){
                if(count>=maxLeads||stopped)break;
                let u=null; for(const m of maps){if(m.has(id)){u=m.get(id);break;}} if(!u)continue;
                const lead=buildLead(u,'','',`${idCount.get(id)}/${usernames.length} perfis`);
                lead.crossCount=idCount.get(id)||1;
                lead.isFollower=true;
                sendLead(lead); count++;
            }

        } else { throw new Error('Tipo de captura inválido'); }

        send({ type: 'done' });
    } catch (err) {
        console.error(`❌ [${type}]:`, err.message);
        // Propaga a mensagem real do Instagram (rate limit, checkpoint, etc.)
        const msg = err.response?.data?.message || err.message;
        send({ type: 'error', message: msg });
    } finally { end(); }
});

// ============================================
// GOOGLE MAPS SEARCH — SSE, scraping via Puppeteer
// ============================================
const gmapsState = { isRunning: false };

// Extrai detalhes da página de um estabelecimento já carregada
async function extractPlaceDetails(page) {
    return page.evaluate(() => {
        const name = document.querySelector('h1')?.innerText?.trim() || '';
        if (!name) return null;

        let phone = '', address = '', website = '', whatsapp = '';

        // data-item-id (mais estável entre versões do Maps)
        document.querySelectorAll('[data-item-id]').forEach(el => {
            const id  = (el.getAttribute('data-item-id') || '').toLowerCase();
            const txt = (el.innerText || '').split('\n')[0].trim();
            if (!phone   && id.includes('phone'))                          phone   = txt;
            if (!address && (id === 'address' || id.includes(':address'))) address = txt;
        });

        // Fallback: botões com aria-label
        if (!phone || !address) {
            document.querySelectorAll('button[aria-label], [role="button"][aria-label]').forEach(el => {
                const lb  = (el.getAttribute('aria-label') || '').trim();
                const txt = (el.innerText || '').split('\n')[0].trim();
                if (!phone   && /^\+?[\d][\d\s\(\)\-\.]{6,18}[\d]$/.test(lb))       phone   = lb;
                if (!address && lb.length > 12 && /\d/.test(lb) && lb.includes(',')) address = lb;
                if (!phone   && /^\+?[\d][\d\s\(\)\-\.]{6,18}[\d]$/.test(txt))      phone   = txt;
            });
        }

        // WhatsApp — links wa.me ou botão próprio do Google Maps
        const allLinks = [...document.querySelectorAll('a[href]')];
        for (const a of allLinks) {
            const href = a.href || '';
            if (href.includes('wa.me/') || href.includes('api.whatsapp.com/send')) {
                const m = href.match(/(?:wa\.me\/|phone=)(\+?[\d]+)/);
                if (m) { whatsapp = m[1]; break; }
            }
        }

        // Website (não-Google)
        if (!website) {
            const candidates = [
                'a[data-item-id*="authority"]',
                'a[aria-label*="site do"]',
                'a[aria-label*="website"]',
                'a[data-tooltip*="site"]',
            ];
            for (const sel of candidates) {
                const el = document.querySelector(sel);
                if (el?.href && !el.href.includes('google.com')) { website = el.href; break; }
            }
        }

        // Se o "site" é um link de WhatsApp, extrair de lá também
        if (!whatsapp && website && (website.includes('wa.me/') || website.includes('api.whatsapp.com'))) {
            const m = website.match(/(?:wa\.me\/|phone=)(\+?[\d]+)/);
            if (m) { whatsapp = m[1]; website = ''; }
        }

        // Inferir WhatsApp de celular brasileiro (11 dígitos: DDD + 9 + 8)
        if (!whatsapp && phone) {
            const digits = phone.replace(/\D/g, '');
            if (digits.length === 11 && digits[2] === '9') whatsapp = `55${digits}`;
            else if (digits.length === 13 && digits.startsWith('55') && digits[4] === '9') whatsapp = digits;
        }

        // Rating
        let rating = null, reviewCount = null;
        const ratingEl = document.querySelector('[aria-label*="estrelas"], [aria-label*="stars"]');
        if (ratingEl) {
            const m = (ratingEl.getAttribute('aria-label') || '').match(/[\d,\.]+/);
            if (m) rating = parseFloat(m[0].replace(',', '.')) || null;
        }
        if (!rating) {
            const rtxt = document.querySelector('.F7nice [aria-hidden="true"]')?.textContent?.replace(',', '.') || '';
            if (rtxt) rating = parseFloat(rtxt) || null;
        }
        const rvEl = document.querySelector('[aria-label*="avaliações"], [aria-label*="reviews"]');
        if (rvEl) {
            const m2 = (rvEl.getAttribute('aria-label') || '').match(/[\d.]+/);
            if (m2) reviewCount = parseInt(m2[0].replace('.', '')) || null;
        }

        // Categoria
        let category = '';
        for (const sel of ['button.DkEaL', '[jsaction*="category"] span', '.fontBodyMedium button']) {
            const el = document.querySelector(sel);
            if (el?.innerText?.trim()) { category = el.innerText.trim(); break; }
        }

        return { name, phone, address, website, whatsapp, rating, reviewCount, category };
    });
}

app.get('/api/gmaps/search', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = d => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(d)}\n\n`); };
    const end  = () => { if (!res.writableEnded) res.end(); };

    if (!puppeteer) {
        send({ type: 'error', message: 'Puppeteer não instalado. Execute: npm install puppeteer' });
        return end();
    }

    if (gmapsState.isRunning) {
        send({ type: 'error', message: 'Busca já em andamento. Aguarde finalizar.' });
        return end();
    }

    const {
        keyword = '', quantity = '50',
        onlyPhone = 'false', onlyWhatsapp = 'false', onlyNoWebsite = 'false',
        minRating = '', maxRating = ''
    } = req.query;
    const maxLeads    = Math.min(parseInt(quantity) || 50, 50);
    const query       = keyword.trim();
    const fPhone      = onlyPhone     === 'true';
    const fWhatsapp   = onlyWhatsapp  === 'true';
    const fNoWebsite  = onlyNoWebsite === 'true';
    const fMinRating  = minRating ? parseFloat(minRating) : null;
    const fMaxRating  = maxRating ? parseFloat(maxRating) : null;

    if (!query) {
        send({ type: 'error', message: 'Informe a palavra-chave de busca' });
        return end();
    }

    let stopped = false;
    req.on('close', () => { stopped = true; });

    gmapsState.isRunning = true;
    let browser = null;

    try {
        send({ type: 'log', message: `Buscando "${query}" no Google Maps...` });

        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--lang=pt-BR,pt',
                '--disable-blink-features=AutomationControlled',
            ],
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' });

        // ── Fase 1: carregar página de busca e coletar todas as URLs ──────
        const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Fechar banner de cookies se aparecer
        try {
            const consentBtn = await page.$('form[action*="consent"] button:last-of-type');
            if (consentBtn) { await consentBtn.click(); await humanSleep(1000); }
        } catch {}

        // Aguardar feed de resultados
        try {
            await page.waitForSelector('[role="feed"]', { timeout: 15000 });
        } catch {
            throw new Error('Google Maps não carregou os resultados. Verifique a conexão e tente novamente.');
        }

        send({ type: 'log', message: 'Resultados encontrados. Carregando lista completa...' });

        // Scrollar para carregar mais resultados (Google Maps carrega ~20 por vez)
        let prevUrlCount = 0;
        for (let scroll = 0; scroll < 12 && !stopped; scroll++) {
            await page.evaluate(() => {
                const feed = document.querySelector('[role="feed"]');
                if (feed) feed.scrollBy(0, 5000);
            });
            await sleep(1800);

            const urlCount = await page.$$eval(
                '[role="feed"] a[href*="/maps/place/"]',
                els => new Set(els.map(e => e.href.split('@')[0])).size
            ).catch(() => 0);

            if (urlCount >= maxLeads) break;
            if (urlCount === prevUrlCount && scroll > 2) break; // sem mais itens
            prevUrlCount = urlCount;

            send({ type: 'log', message: `${urlCount} estabelecimentos carregados...` });
        }

        // Coletar URLs únicas dos resultados — ANTES de clicar em qualquer um
        const placeUrls = await page.$$eval(
            '[role="feed"] a[href*="/maps/place/"]',
            (links, max) => {
                const seen = new Set();
                const result = [];
                for (const a of links) {
                    // Chave = URL até o "@" (coordenadas) para deduplicar variantes
                    const key = a.href.split('@')[0];
                    if (seen.has(key)) continue;
                    seen.add(key);
                    result.push(a.href);
                    if (result.length >= max) break;
                }
                return result;
            },
            maxLeads
        ).catch(() => []);

        if (!placeUrls.length) {
            throw new Error(`Nenhum resultado encontrado para "${query}". Tente uma busca diferente.`);
        }

        send({ type: 'log', message: `${placeUrls.length} estabelecimentos encontrados. Extraindo detalhes...` });

        // ── Fase 2: visitar cada URL e extrair dados ───────────────────────
        const seen = new Set();
        let count  = 0;

        for (let i = 0; i < placeUrls.length && count < maxLeads && !stopped; i++) {
            try {
                await page.goto(placeUrls[i], { waitUntil: 'domcontentloaded', timeout: 20000 });
                await page.waitForSelector('h1', { timeout: 8000 }).catch(() => {});
                await humanSleep(900); // deixar JS da página terminar de renderizar

                const details = await extractPlaceDetails(page);
                if (!details || !details.name) continue;

                // Aplicar filtros antes de contar como lead
                if (fPhone    && !details.phone)    continue;
                if (fWhatsapp && !details.whatsapp) continue;
                if (fNoWebsite && details.website)  continue;
                if (fMinRating !== null && details.rating !== null && details.rating < fMinRating) continue;
                if (fMaxRating !== null && details.rating !== null && details.rating > fMaxRating) continue;

                const key = `${details.name.toLowerCase()}|${(details.address || '').toLowerCase()}`;
                if (seen.has(key)) continue;
                seen.add(key);

                const id = crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);

                send({ type: 'lead', lead: {
                    id,
                    name:        details.name,
                    phone:       details.phone       || null,
                    whatsapp:    details.whatsapp    || null,
                    address:     details.address     || null,
                    website:     details.website     || null,
                    rating:      details.rating      || null,
                    reviewCount: details.reviewCount || null,
                    category:    details.category    || null,
                    keyword:     query,
                    source:      'google_maps',
                    capturedAt:  new Date().toISOString()
                }});
                count++;

                if (count % 5 === 0 || count === 1) {
                    send({ type: 'log', message: `${count}/${placeUrls.length} extraídos...` });
                }

                // Delay aleatório para não parecer bot
                await sleep(600 + Math.floor(Math.random() * 600));

            } catch (err) {
                console.warn(`[gmaps] ${i + 1}/${placeUrls.length}: ${err.message.slice(0, 80)}`);
            }
        }

        send({ type: 'done', total: count });
    } catch (err) {
        console.error('[gmaps]', err.message);
        send({ type: 'error', message: err.message });
    } finally {
        gmapsState.isRunning = false;
        try { if (browser) await browser.close(); } catch {}
        end();
    }
});

// ============================================
// Instagram Browser Login (Puppeteer)
// ============================================

const igBrowserState = { browser: null, page: null, status: 'idle', data: null, pollTimer: null };

async function igBrowserCleanup() {
    if (igBrowserState.pollTimer) { clearInterval(igBrowserState.pollTimer); igBrowserState.pollTimer = null; }
    if (igBrowserState.browser) {
        try { await igBrowserState.browser.close(); } catch {}
        igBrowserState.browser = null;
        igBrowserState.page    = null;
    }
}

// POST /api/ig-auth/browser-login — abre navegador Chrome controlado
app.post('/api/ig-auth/browser-login', async (req, res) => {
    if (!puppeteer) return res.status(503).json({ success: false, error: 'Puppeteer não instalado. Reinicie o servidor.' });

    await igBrowserCleanup();
    igBrowserState.status = 'opening';
    igBrowserState.data   = null;

    try {
        const browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: [
                '--window-size=430,750',
                '--window-position=100,80',
                '--disable-notifications',
                '--disable-infobars',
                '--no-default-browser-check',
                '--app=https://www.instagram.com/accounts/login/',
            ],
        });

        igBrowserState.browser = browser;
        igBrowserState.status  = 'waiting';

        const pages = await browser.pages();
        const page  = pages[0] || await browser.newPage();
        igBrowserState.page = page;

        // Navegar para login se ainda não estiver lá
        const url = page.url();
        if (!url.includes('instagram.com')) {
            await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' });
        }

        // Polling: detectar quando o usuário logou (saiu da tela de login)
        igBrowserState.pollTimer = setInterval(async () => {
            try {
                if (!igBrowserState.browser) { clearInterval(igBrowserState.pollTimer); return; }

                const currentUrl = page.url();
                const cookies    = await page.cookies('https://www.instagram.com');
                const sessionid  = cookies.find(c => c.name === 'sessionid' && c.value?.length > 10);

                const loggedIn = sessionid && !currentUrl.includes('/accounts/login') &&
                                 !currentUrl.includes('/challenge') &&
                                 !currentUrl.includes('/two_factor');

                if (loggedIn && igBrowserState.status === 'waiting') {
                    clearInterval(igBrowserState.pollTimer);
                    igBrowserState.pollTimer = null;

                    const csrftoken  = cookies.find(c => c.name === 'csrftoken');
                    const dsUserId   = cookies.find(c => c.name === 'ds_user_id');

                    // Tentar extrair username da página
                    let username = '';
                    try {
                        username = await page.evaluate(() => {
                            const sel = [
                                'span[class*="xdpxx0"]',
                                '[data-testid="user-avatar"]',
                                'a[href^="/"][role="link"] span',
                            ];
                            for (const s of sel) {
                                const el = document.querySelector(s);
                                if (el?.textContent?.trim()) return el.textContent.trim();
                            }
                            // Fallback: URL do avatar
                            const meta = document.querySelector('meta[property="og:description"]');
                            if (meta?.content) return meta.content.split('@')[1]?.split(' ')[0] || '';
                            return '';
                        });
                    } catch {}

                    // Capturar TODOS os cookies — o Instagram moderno rejeita
                    // chamadas com apenas 3 cookies (detecta como bot)
                    const fullCookieStr = cookies
                        .filter(c => c.value)
                        .map(c => `${c.name}=${c.value}`)
                        .join('; ');

                    // Captura o User-Agent real do browser — necessário para evitar "useragent mismatch"
                    let userAgent = '';
                    try { userAgent = await page.evaluate(() => navigator.userAgent); } catch {}

                    igBrowserState.data = {
                        sessionid:    sessionid.value,
                        csrftoken:    csrftoken?.value || '',
                        dsUserId:     dsUserId?.value  || '',
                        username,
                        cookieString: fullCookieStr,
                        userAgent,
                    };
                    igBrowserState.status = 'done';

                    // Fechar navegador após breve pausa (mostra sucesso)
                    setTimeout(igBrowserCleanup, 2000);
                }
            } catch { /* browser fechado pelo usuário */ igBrowserCleanup(); }
        }, 1200);

        // Timeout 5 min
        setTimeout(() => {
            if (igBrowserState.status === 'waiting') {
                igBrowserState.status = 'timeout';
                igBrowserCleanup();
            }
        }, 300000);

        res.json({ success: true });

    } catch (err) {
        igBrowserState.status = 'error';
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/ig-auth/browser-status — frontend faz polling
app.get('/api/ig-auth/browser-status', (req, res) => {
    const { status, data } = igBrowserState;
    res.json({ status, data: status === 'done' ? data : null });
});

// POST /api/ig-auth/browser-cancel — cancela e fecha
app.post('/api/ig-auth/browser-cancel', async (req, res) => {
    igBrowserState.status = 'cancelled';
    await igBrowserCleanup();
    res.json({ success: true });
});

// ============================================
// MONITOR DE CONCORRENTES
// ============================================

// Salva credenciais do IG para uso do monitor (chamado no login-cookie)
app.post('/api/monitor/credentials', (req, res) => {
    const ig = getIg(req);
    if (!ig.loggedIn) return res.status(401).json({ error: 'Não autenticado' });
    monitor.credentials = { ...ig }; saveMonitorCredentials(ig);
    res.json({ ok: true });
});

// SSE stream — frontend conecta aqui para receber eventos em tempo real
app.get('/api/monitor/stream', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();
    monitor.clients.add(res);

    // Ping a cada 25s para manter conexão viva
    const ping = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
        else clearInterval(ping);
    }, 25000);

    req.on('close', () => { clearInterval(ping); monitor.clients.delete(res); });
});

// GET /api/monitor/profiles — lista perfis monitorados
app.get('/api/monitor/profiles', (req, res) => {
    const profiles = db.prepare('SELECT username, ig_user_id, added_at, last_checked, follower_count, status FROM monitor_profiles ORDER BY added_at DESC').all();
    res.json({ profiles });
});

// POST /api/monitor/add — adiciona perfil e inicia sync
app.post('/api/monitor/add', async (req, res) => {
    const ig = getIg(req);
    if (!ig.loggedIn) return res.status(401).json({ error: 'Não autenticado' });
    monitor.credentials = { ...ig }; saveMonitorCredentials(ig);

    const raw = (req.body.username || '').trim().replace('@', '').replace(/.*instagram\.com\//, '').replace(/\/.*/, '');
    if (!raw) return res.status(400).json({ error: 'Username inválido' });

    // Limite máximo de 3 perfis monitorados
    const totalProfiles = db.prepare('SELECT COUNT(*) as n FROM monitor_profiles').get()?.n || 0;
    const existing      = db.prepare('SELECT username FROM monitor_profiles WHERE username = ?').get(raw);
    const isReAdd       = existing && (existing.status === 'error' || existing.status === 'syncing');
    if (!isReAdd && totalProfiles >= 3)
        return res.status(400).json({ error: 'Limite de 3 perfis monitorados atingido. Remova um perfil para adicionar outro.' });
    if (existing) {
        // Permite re-adicionar se estava em erro ou sync interrompido — limpa e recomeça
        if (existing.status === 'error' || existing.status === 'syncing') {
            db.prepare('DELETE FROM monitor_profiles  WHERE username = ?').run(raw);
            db.prepare('DELETE FROM profile_followers WHERE profile_username = ?').run(raw);
            console.log(`[monitor] re-adicionando @${raw} (era status=${existing.status})`);
        } else {
            return res.status(400).json({ error: `@${raw} já está sendo monitorado` });
        }
    }

    db.prepare('INSERT INTO monitor_profiles (username, added_at, status) VALUES (?, ?, ?)').run(raw, new Date().toISOString(), 'pending');
    monitorStart(); // garante que o timer está rodando

    res.json({ ok: true, username: raw });

    // Sync inicial em background
    try {
        const web    = monitorAxiosWeb();
        const mobile = monitorAxiosMobile();
        const { userId } = await getUserId(web, raw, mobile);
        db.prepare('UPDATE monitor_profiles SET ig_user_id = ? WHERE username = ?').run(userId, raw);
        await monitorFullSync(raw, userId);
    } catch (err) {
        console.error(`[monitor] add @${raw}:`, err.message);
        db.prepare('UPDATE monitor_profiles SET status = ? WHERE username = ?').run('error', raw);
        monitorSend({ type: 'profile_error', profile: raw, error: err.message });
    }
});

// DELETE /api/monitor/remove — remove perfil e dados
app.delete('/api/monitor/remove', (req, res) => {
    const username = (req.body.username || req.query.username || '').trim().replace('@', '');
    if (!username) return res.status(400).json({ error: 'Username obrigatório' });
    db.prepare('DELETE FROM monitor_profiles  WHERE username = ?').run(username);
    db.prepare('DELETE FROM profile_followers WHERE profile_username = ?').run(username);
    db.prepare('DELETE FROM monitor_events    WHERE profile_username = ?').run(username);
    res.json({ ok: true });
});

// GET /api/monitor/events — últimos 100 eventos (novos seguidores detectados)
app.get('/api/monitor/events', (req, res) => {
    const events = db.prepare(`
        SELECT * FROM monitor_events ORDER BY detected_at DESC LIMIT 100
    `).all();
    res.json({ events });
});

// POST /api/monitor/events/seen — marca eventos como vistos
app.post('/api/monitor/events/seen', (req, res) => {
    db.prepare('UPDATE monitor_events SET seen = 1').run();
    res.json({ ok: true });
});

// GET /api/monitor/debug — estado do banco (diagnóstico)
app.get('/api/monitor/debug', (req, res) => {
    const profiles = db.prepare('SELECT username, status, follower_count, last_checked FROM monitor_profiles').all();
    const counts   = db.prepare('SELECT profile_username, COUNT(*) as n FROM profile_followers GROUP BY profile_username').all();
    const events   = db.prepare('SELECT profile_username, COUNT(*) as n FROM monitor_events GROUP BY profile_username').all();
    res.json({
        hasCredentials: !!monitor.credentials,
        timerActive:    !!monitor.timer,
        isPolling:      monitor.polling,
        profiles,
        snapshotCounts: counts,
        eventCounts:    events,
    });
});

// POST /api/monitor/poll-now — força um ciclo de poll imediato
app.post('/api/monitor/poll-now', async (req, res) => {
    if (!monitor.credentials) return res.status(400).json({ error: 'Sem credenciais — recarregue a página logado no Instagram' });
    res.json({ ok: true, message: 'Poll iniciado' });
    monitorRunCycle(true).catch(e => console.error('[monitor] poll-now:', e.message));
});

// Retoma monitor ao iniciar (se houver perfis cadastrados)
if (db.prepare('SELECT COUNT(*) as n FROM monitor_profiles').get()?.n > 0) monitorStart();

// ============================================
// AI Analysis — Ollama proxy
// ============================================
app.post('/api/ai/analyze', async (req, res) => {
    const { lead, segment, model = 'llama3' } = req.body || {};
    if (!lead || !segment) {
        return res.status(400).json({ success: false, error: 'lead e segment são obrigatórios' });
    }

    const isGmaps = !!(lead.address || lead.rating != null);
    const leadInfo = isGmaps ? [
        `Nome: ${lead.name || '-'}`,
        `Categoria: ${lead.category || 'não informada'}`,
        `Avaliação: ${lead.rating != null ? `${lead.rating} estrelas (${lead.reviewCount || 0} avaliações)` : 'sem avaliação'}`,
        `Telefone: ${lead.phone || 'não informado'}`,
        `Site: ${lead.website ? lead.website : 'não tem site'}`,
        `Endereço: ${lead.address || 'não informado'}`,
    ].join('\n') : [
        `Usuário: @${lead.username || '-'}`,
        `Nome: ${lead.fullName || lead.username || '-'}`,
        `Bio: ${(lead.bio || 'sem bio').slice(0, 150)}`,
        `Seguidores: ${lead.followerCount || 0}`,
        `Tipo de conta: ${lead.isBusinessAccount ? 'empresarial' : 'pessoal'}`,
        `Categoria: ${lead.category || 'não informada'}`,
        `WhatsApp: ${lead.whatsapp || 'não detectado'}`,
        `Email: ${lead.email || 'não detectado'}`,
        `Site: ${lead.website || 'não tem site'}`,
    ].join('\n');

    const prompt = `Você é especialista em prospecção B2B e vendas consultivas. Analise este lead para alguém que oferece: "${segment}".

DADOS DO LEAD (${isGmaps ? 'Google Maps' : 'Instagram'}):
${leadInfo}

Responda SOMENTE em português, de forma direta e prática (máximo 4 linhas no total):
1. POTENCIAL: Por que este lead tem potencial (ou não) para contratar "${segment}"? (1-2 frases)
2. ABORDAGEM: Qual seria a primeira mensagem ideal para este lead? Seja específico e natural. (1-2 frases)`;

    try {
        const response = await axios.post('http://localhost:11434/api/generate', {
            model,
            prompt,
            stream: false,
            options: { temperature: 0.7, num_predict: 280 }
        }, { timeout: 45000 });

        res.json({ success: true, analysis: response.data?.response || '' });
    } catch (err) {
        const offline = err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND';
        res.status(offline ? 503 : 500).json({
            success: false,
            error: offline
                ? 'Ollama não está rodando. Inicie com: ollama serve'
                : (err.message || 'Erro ao chamar Ollama')
        });
    }
});

// ============================================
// Start
// ============================================
app.listen(PORT, () => {
    console.log(`\n✅ UltraProspec rodando em http://localhost:${PORT}`);
    console.log(`   → Landing:    http://localhost:${PORT}/index.html`);
    console.log(`   → Plataforma: http://localhost:${PORT}/app.html\n`);
});
