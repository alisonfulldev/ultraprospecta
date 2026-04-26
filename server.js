require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const { IgApiClient, IgCheckpointError } = require('instagram-private-api');

const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');
if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR);

const app = express();
const ig = new IgApiClient();

app.use(express.json());
app.use(express.static(__dirname));

// ============================================
// State
// ============================================
let session = {
    loggedIn: false,
    user: null,
    sessionid: null,
    csrftoken: null,
    dsUserId: null
};

// ============================================
// Instagram Web API Client
// ============================================

const IG_APP_ID = '936619743392459';

function buildCookie() {
    const parts = [`sessionid=${session.sessionid}`];
    if (session.csrftoken)  parts.push(`csrftoken=${session.csrftoken}`);
    if (session.dsUserId)   parts.push(`ds_user_id=${session.dsUserId}`);
    return parts.join('; ');
}

function igClient(extraHeaders = {}) {
    return axios.create({
        baseURL: 'https://www.instagram.com',
        timeout: 15000,
        maxRedirects: 0,
        validateStatus: (s) => s < 400,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'X-IG-App-ID': IG_APP_ID,
            'X-ASBD-ID': '129477',
            'X-CSRFToken': session.csrftoken || '',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': '*/*',
            'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
            'Referer': 'https://www.instagram.com/',
            'Origin': 'https://www.instagram.com',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'Cookie': buildCookie(),
            ...extraHeaders
        }
    });
}

// ============================================
// Utils
// ============================================

function extractWhatsApp(text) {
    if (!text) return null;
    const patterns = [
        /wa\.me\/(\+?[\d]+)/i,
        /whatsapp[:\s.]*(\+?[\d\s().-]{8,})/i,
        /\+55\s*\(?\d{2}\)?\s*\d{4,5}[-\s]?\d{4}/,
        /\(?\d{2}\)?\s*9\d{4}[-\s]?\d{4}/
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m) return m[1] || m[0];
    }
    return null;
}

function extractEmail(text) {
    if (!text) return null;
    const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return m ? m[0] : null;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function shortcodeToMediaId(shortcode) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = BigInt(0);
    for (const char of shortcode) {
        id = id * BigInt(64) + BigInt(alphabet.indexOf(char));
    }
    return id.toString();
}

function extractUsername(target) {
    if (target.includes('instagram.com')) {
        const m = target.match(/instagram\.com\/([^/?#]+)/);
        if (!m) throw new Error('URL inválida');
        return m[1].replace('@', '');
    }
    return target.replace('@', '');
}

function extractShortcode(postUrl) {
    const m = postUrl.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
    if (!m) throw new Error('URL do post inválida. Use: https://www.instagram.com/p/CODIGO/');
    return m[1];
}

// ============================================
// Auth Routes
// ============================================

app.get('/api/status', (req, res) => {
    res.json({ loggedIn: session.loggedIn, user: session.user });
});

app.post('/api/logout', (req, res) => {
    session = { loggedIn: false, user: null, sessionid: null, csrftoken: null };
    res.json({ success: true });
});

// Login via Session ID
app.post('/api/login-cookie', async (req, res) => {
    const { sessionid, username, csrftoken, dsUserId } = req.body;
    if (!sessionid) return res.status(400).json({ error: 'sessionid obrigatório' });
    if (!username)  return res.status(400).json({ error: 'Usuário obrigatório' });

    const cleanUser = username.trim().replace('@', '');
    session.sessionid = sessionid.trim();
    session.csrftoken = (csrftoken || '').trim();
    session.dsUserId  = (dsUserId || '').trim();
    session.loggedIn  = true;
    session.user      = { username: cleanUser, fullName: '' };

    console.log(`✅ Sessão armazenada para @${cleanUser}`);
    console.log(`   Cookie: ${buildCookie().slice(0, 80)}...`);
    return res.json({ success: true, user: session.user });
});

// Login via usuário/senha (instagram-private-api)
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
    }

    try {
        ig.state.generateDevice(username);
        const user = await ig.account.login(username, password);

        if (ig.state.checkpoint) {
            console.log('🔐 Checkpoint detectado após login. Solicitando código...');
            try { await ig.challenge.auto(true); console.log('📧 Código enviado.'); } catch (_) {}
            return res.json({ checkpointRequired: true });
        }

        try { await ig.account.currentUser(); } catch (verifyErr) {
            if ((verifyErr.message || '').includes('checkpoint')) {
                try { await ig.challenge.auto(true); } catch (_) {}
                return res.json({ checkpointRequired: true });
            }
            throw verifyErr;
        }

        session.loggedIn = true;
        session.user = { username: user.username, fullName: user.full_name };
        console.log(`✅ Logado como @${user.username}`);
        return res.json({ success: true, user: session.user });
    } catch (err) {
        const errName = err.constructor?.name || '';
        console.error(`❌ Login [${errName}]:`, err.message);

        const isCheckpoint = err instanceof IgCheckpointError
            || errName.toLowerCase().includes('checkpoint')
            || (err.message || '').toLowerCase().includes('checkpoint');

        if (isCheckpoint) {
            try { await ig.challenge.auto(true); } catch (_) {}
            return res.json({ checkpointRequired: true });
        }

        session.loggedIn = false;
        const msg = err.message?.includes('bad_password') ? 'Usuário ou senha incorretos' : err.message;
        return res.status(401).json({ error: msg });
    }
});

app.post('/api/challenge', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Código obrigatório' });

    try {
        await ig.challenge.delta(code.trim());
        const user = await ig.account.currentUser();
        session.loggedIn = true;
        session.user = { username: user.username, fullName: user.full_name };
        res.json({ success: true, user: session.user });
    } catch (err) {
        res.status(400).json({ error: 'Código inválido ou expirado.' });
    }
});

app.get('/api/debug', (req, res) => {
    res.json({ loggedIn: session.loggedIn, user: session.user });
});

// ============================================
// Capture — Instagram Web API
// ============================================

app.get('/api/capture', async (req, res) => {
    if (!session.loggedIn) {
        return res.status(401).json({ error: 'Faça login primeiro' });
    }

    const {
        type = 'followers',
        target = '',
        quantity = '100',
        delay: delayMs = '800',
        fetchBio = 'true'
    } = req.query;

    const maxLeads = Math.min(parseInt(quantity) || 100, 1000);
    const delayTime = Math.max(parseInt(delayMs) || 800, 300);
    const shouldFetchBio = fetchBio === 'true';

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let stopped = false;
    req.on('close', () => { stopped = true; });

    const send = (data) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const end = () => { if (!res.writableEnded) res.end(); };

    try {
        const client = igClient();

        if (type === 'followers') {
            const username = extractUsername(target);
            send({ type: 'log', message: `Buscando perfil @${username}...` });

            // Buscar user ID
            const profileRes = await client.get(`/api/v1/users/web_profile_info/`, {
                params: { username }
            });
            console.log(`📡 web_profile_info HTTP ${profileRes.status} — dados:`, JSON.stringify(profileRes.data).slice(0, 300));
            const profileData = profileRes.data?.data?.user;
            if (!profileData) throw new Error(`Perfil não encontrado (HTTP ${profileRes.status})`);

            const userId = profileData.id;
            send({ type: 'log', message: `Capturando seguidores de @${username}...` });

            let count = 0;
            let maxId = null;

            while (count < maxLeads && !stopped) {
                const params = { count: 50, ...(maxId ? { max_id: maxId } : {}) };
                const followRes = await client.get(`/api/v1/friendships/${userId}/followers/`, { params });
                const followers = followRes.data?.users || [];
                maxId = followRes.data?.next_max_id || null;

                for (const user of followers) {
                    if (count >= maxLeads || stopped) break;

                    let bio = user.biography || '';
                    let externalUrl = user.external_url || '';

                    if (shouldFetchBio && !bio) {
                        try {
                            const infoRes = await client.get(`/api/v1/users/${user.pk}/info/`);
                            const info = infoRes.data?.user;
                            bio = info?.biography || '';
                            externalUrl = info?.external_url || '';
                            await sleep(delayTime);
                        } catch (_) {}
                    }

                    const fullText = `${bio} ${externalUrl}`;
                    send({
                        type: 'lead',
                        lead: {
                            id: String(user.pk),
                            username: user.username,
                            fullName: user.full_name || '',
                            bio,
                            whatsapp: extractWhatsApp(fullText),
                            email: extractEmail(fullText),
                            photoUrl: user.profile_pic_url || '',
                            isPrivate: user.is_private || false,
                            capturedAt: new Date().toISOString()
                        }
                    });
                    count++;
                    if (!shouldFetchBio) await sleep(Math.min(delayTime, 200));
                }

                if (!maxId) break;
                await sleep(delayTime);
            }

        } else if (type === 'likes') {
            const shortcode = extractShortcode(target);
            const mediaId = shortcodeToMediaId(shortcode);
            send({ type: 'log', message: 'Buscando curtidores do post...' });

            const likersRes = await client.get(`/api/v1/media/${mediaId}/likers/`);
            const likers = likersRes.data?.users || [];
            let count = 0;

            for (const user of likers) {
                if (count >= maxLeads || stopped) break;

                let bio = user.biography || '';
                let externalUrl = user.external_url || '';

                if (shouldFetchBio && !bio) {
                    try {
                        const infoRes = await client.get(`/api/v1/users/${user.pk}/info/`);
                        const info = infoRes.data?.user;
                        bio = info?.biography || '';
                        externalUrl = info?.external_url || '';
                        await sleep(delayTime);
                    } catch (_) {}
                }

                const fullText = `${bio} ${externalUrl}`;
                send({
                    type: 'lead',
                    lead: {
                        id: String(user.pk),
                        username: user.username,
                        fullName: user.full_name || '',
                        bio,
                        whatsapp: extractWhatsApp(fullText),
                        email: extractEmail(fullText),
                        photoUrl: user.profile_pic_url || '',
                        isPrivate: user.is_private || false,
                        capturedAt: new Date().toISOString()
                    }
                });
                count++;
                if (!shouldFetchBio) await sleep(Math.min(delayTime, 200));
            }
        } else {
            send({ type: 'error', message: 'Tipo inválido' });
            return end();
        }

        send({ type: 'done' });
    } catch (err) {
        const status = err.response?.status;
        const body = err.response?.data;
        console.error(`❌ Capture error [${err.constructor?.name}] HTTP ${status}:`, err.message);
        if (body) console.error('   body:', JSON.stringify(body).slice(0, 300));
        send({ type: 'error', message: body?.message || err.message });
    } finally {
        end();
    }
});

// ============================================
// Monitor System
// ============================================

const monitoredProfiles = new Map();
const monitorClients    = new Set();

function loadSnapshot(username) {
    const file = path.join(SNAPSHOTS_DIR, `${username}.json`);
    if (!fs.existsSync(file)) return new Set();
    try { return new Set(JSON.parse(fs.readFileSync(file, 'utf-8'))); }
    catch { return new Set(); }
}

function saveSnapshot(username, ids) {
    const file = path.join(SNAPSHOTS_DIR, `${username}.json`);
    fs.writeFileSync(file, JSON.stringify([...ids]));
}

function broadcastMonitor(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of monitorClients) {
        if (!client.writableEnded) client.write(msg);
    }
}

async function fetchAllFollowerIds(username) {
    const client = igClient();
    const profileRes = await client.get('/api/v1/users/web_profile_info/', { params: { username } });
    const profileData = profileRes.data?.data?.user;
    if (!profileData) throw new Error(`Perfil @${username} não encontrado`);

    const userId = profileData.id;
    const followers = new Map();
    let maxId = null;
    const MAX_PAGES = 400; // até 20k seguidores

    for (let page = 0; page < MAX_PAGES; page++) {
        const params = { count: 50, ...(maxId ? { max_id: maxId } : {}) };
        const res = await client.get(`/api/v1/friendships/${userId}/followers/`, { params });
        const users = res.data?.users || [];
        for (const u of users) followers.set(String(u.pk), u);
        maxId = res.data?.next_max_id;
        if (!maxId || users.length === 0) break;
        await sleep(800);
    }

    return { userId, followers };
}

async function pollProfile(username) {
    const profile = monitoredProfiles.get(username);
    if (!profile?.active) return;

    try {
        broadcastMonitor({ type: 'polling', username });
        console.log(`🔍 Polling @${username}...`);

        const { followers } = await fetchAllFollowerIds(username);
        const currentIds = new Set(followers.keys());
        const prevIds    = profile.snapshot;

        if (prevIds.size === 0) {
            profile.snapshot      = currentIds;
            profile.followerCount = currentIds.size;
            profile.lastCheck     = new Date().toISOString();
            saveSnapshot(username, currentIds);
            console.log(`📸 Snapshot inicial @${username}: ${currentIds.size} seguidores`);
            broadcastMonitor({ type: 'snapshot', username, count: currentIds.size, lastCheck: profile.lastCheck });
        } else {
            const newIds = [...currentIds].filter(id => !prevIds.has(id));
            console.log(`✅ @${username}: ${currentIds.size} seguidores, ${newIds.length} novos`);

            for (const id of newIds) {
                const u = followers.get(id);
                if (!u) continue;
                const bio = u.biography || '';
                const ext = u.external_url || '';
                const txt = `${bio} ${ext}`;
                broadcastMonitor({
                    type: 'new_follower',
                    username,
                    follower: {
                        id,
                        username:  u.username,
                        fullName:  u.full_name || '',
                        bio,
                        whatsapp:  extractWhatsApp(txt),
                        email:     extractEmail(txt),
                        photoUrl:  u.profile_pic_url || '',
                        isPrivate: u.is_private || false,
                        detectedAt: new Date().toISOString()
                    }
                });
            }

            profile.snapshot      = currentIds;
            profile.followerCount = currentIds.size;
            profile.lastCheck     = new Date().toISOString();
            saveSnapshot(username, currentIds);
            broadcastMonitor({ type: 'checked', username, count: currentIds.size, newCount: newIds.length, lastCheck: profile.lastCheck });
        }
    } catch (err) {
        console.error(`❌ Poll @${username}:`, err.message);
        broadcastMonitor({ type: 'error', username, message: err.message });
    }

    if (monitoredProfiles.get(username)?.active) {
        profile.timer = setTimeout(() => pollProfile(username), profile.interval);
    }
}

// SSE stream para o monitor
app.get('/api/monitor/stream', (req, res) => {
    if (!session.loggedIn) return res.status(401).end();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    monitorClients.add(res);

    // Envia estado atual
    for (const [u, p] of monitoredProfiles) {
        res.write(`data: ${JSON.stringify({ type: 'profile_status', username: u, active: p.active, followerCount: p.followerCount || 0, lastCheck: p.lastCheck, hasSnapshot: p.snapshot.size > 0 })}\n\n`);
    }

    req.on('close', () => monitorClients.delete(res));
});

// Adicionar perfil ao monitor
app.post('/api/monitor/add', (req, res) => {
    if (!session.loggedIn) return res.status(401).json({ error: 'Faça login primeiro' });

    const { username, interval = 300 } = req.body;
    if (!username) return res.status(400).json({ error: 'Usuário obrigatório' });

    const clean = username.trim().replace('@', '').replace(/.*instagram\.com\//, '').replace(/\/$/, '');

    if (monitoredProfiles.size >= 4 && !monitoredProfiles.has(clean))
        return res.status(400).json({ error: 'Máximo de 4 perfis simultâneos' });

    if (monitoredProfiles.has(clean))
        return res.status(400).json({ error: 'Perfil já monitorado' });

    const intervalMs = Math.max(interval, 120) * 1000;
    const snapshot   = loadSnapshot(clean);

    monitoredProfiles.set(clean, {
        active: true, snapshot, followerCount: snapshot.size,
        interval: intervalMs, lastCheck: null, timer: null
    });

    const stagger = (monitoredProfiles.size - 1) * 20000;
    setTimeout(() => pollProfile(clean), stagger);

    console.log(`👁️  Monitorando @${clean} a cada ${interval}s`);
    res.json({ success: true, username: clean, hasSnapshot: snapshot.size > 0 });
});

// Remover perfil do monitor
app.post('/api/monitor/remove', (req, res) => {
    const { username } = req.body;
    const p = monitoredProfiles.get(username);
    if (p) {
        p.active = false;
        if (p.timer) clearTimeout(p.timer);
        monitoredProfiles.delete(username);
    }
    console.log(`🛑 Parou @${username}`);
    res.json({ success: true });
});

// ============================================
// Start
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅ UltraProspec rodando em http://localhost:3000\n`);
});
