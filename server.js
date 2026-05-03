require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const axios    = require('axios');
const crypto   = require('crypto');
const Stripe   = require('stripe');
const { IgApiClient, IgCheckpointError } = require('instagram-private-api');
const { getDb } = require('./db');
let puppeteer; try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }

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
    const parts = [`sessionid=${ig.sessionid}`];
    if (ig.csrftoken) parts.push(`csrftoken=${ig.csrftoken}`);
    if (ig.dsUserId)  parts.push(`ds_user_id=${ig.dsUserId}`);
    return parts.join('; ');
}

function igWebClient(req) {
    const ig = getIg(req);
    return axios.create({
        baseURL: 'https://www.instagram.com', timeout: 25000,
        maxRedirects: 0, validateStatus: s => s < 500,
        headers: {
            'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'X-IG-App-ID':      '936619743392459', 'X-ASBD-ID': '129477',
            'X-CSRFToken':      ig.csrftoken || '', 'X-Requested-With': 'XMLHttpRequest',
            'Accept': '*/*', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
            'Referer': 'https://www.instagram.com/', 'Origin': 'https://www.instagram.com',
            'Cookie': buildCookie(ig)
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
    if (!m) throw new Error('URL do post inválida.');
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

async function getUserId(client, username) {
    const res = await client.get('/api/v1/users/web_profile_info/', { params: { username } });
    if (res.status === 302 || res.status === 401)
        throw new Error('Session ID inválido ou expirado. Reconecte o Instagram.');
    igAssert(res.data, `busca de @${username}`);
    const user = res.data?.data?.user;
    if (!user) throw new Error(`Perfil @${username} não encontrado ou é privado.`);
    const id = user.id || user.pk;
    if (!id)   throw new Error(`Não foi possível obter o ID de @${username}`);
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
    res.json({ loggedIn: ig.loggedIn || false, user: ig.loggedIn ? { username: ig.username } : null });
});

app.post('/api/logout', (req, res) => {
    setIg(req, { loggedIn: false, username: null, sessionid: null, csrftoken: null, dsUserId: null });
    res.json({ success: true });
});

app.post('/api/login-cookie', (req, res) => {
    const { sessionid, username, csrftoken, dsUserId } = req.body;
    if (!sessionid) return res.status(400).json({ error: 'sessionid obrigatório' });
    // username é opcional — usa dsUserId como fallback para não bloquear login automático via browser
    const user = (username || dsUserId || 'usuario').trim().replace('@', '');
    setIg(req, { loggedIn: true, username: user, sessionid: sessionid.trim(), csrftoken: (csrftoken||'').trim(), dsUserId: (dsUserId||'').trim() });
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
// PAYMENT ROUTES — Stripe
// Instagram: 100 leads = R$10,00
// CNPJ:      50 leads  = R$10,00
// ============================================
const PACKS = {
    instagram: { credits: 100, price: 1000, name: 'UltraProspec — 100 Leads Instagram', desc: 'R$0,10 por lead qualificado do Instagram' },
    cnpj:      { credits: 50,  price: 1000, name: 'UltraProspec — 50 Leads CNPJ',      desc: 'R$0,20 por lead empresarial da Receita Federal' }
};

app.post('/api/payment/create', async (req, res) => {
    if (!process.env.STRIPE_SECRET_KEY)
        return res.status(500).json({ error: 'STRIPE_SECRET_KEY não configurada no .env' });

    const type = (req.body.type === 'cnpj') ? 'cnpj' : 'instagram';
    const pack = PACKS[type];
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
            metadata:    { credits: String(pack.credits), type }
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
        const type    = session.metadata?.type || 'instagram';
        const credits = parseInt(session.metadata?.credits) || PACKS[type]?.credits || 100;
        res.json({ approved: true, credits, type, amount: session.amount_total / 100 });
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
// CAPTURE — SSE  (créditos controlados pelo cliente/localStorage)
// ============================================
app.get('/api/capture', async (req, res) => {
    const ig = getIg(req);
    if (!ig.loggedIn) return res.status(401).json({ error: 'Conecte sua conta do Instagram primeiro' });

    const { type='followers', target='', quantity='200', delay:delayMs='1500', fetchBio:fetchBioParam='false', posts='10' } = req.query;
    const maxLeads       = Math.min(parseInt(quantity)||200, 2000);
    const delayTime      = Math.max(parseInt(delayMs)||1500, 1000); // mínimo 1s entre requests
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
            const { userId } = await getUserId(web, username);
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
                await sleep(1000);
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
                await sleep(delayTime);
            }

            const toEnrich=[...new Set([...commenterCounts.keys(),...[...likerCounts.entries()].filter(([,c])=>c>=2).map(([id])=>id),...[...followerIds].filter(id=>likerCounts.has(id)||commenterCounts.has(id))])].slice(0,400);
            const enriched=new Map();
            if(toEnrich.length){
                send({type:'log',message:`Enriquecendo ${toEnrich.length} perfis...`});
                for(let i=0;i<toEnrich.length&&!stopped;i++){const tpk=toEnrich[i];enriched.set(tpk,await fetchBio(web,mobile,tpk,uMap.get(tpk)?.username));if(i%10===0)send({type:'log',message:`Enriquecendo: ${i+1}/${toEnrich.length}...`});await sleep(800);}
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
            let count=0;for(const lead of leads){if(count>=maxLeads||stopped)break;sendLead(lead);count++;}

        } else if (type==='followers') {
            const username=extractUsername(target);
            send({type:'log',message:`Seguidores de @${username}...`});
            const {userId}=await getUserId(web,username);
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
                    if(shouldFetchBio){ const d=await fetchBio(web,mobile,u.pk,u.username); enrichLead(lead,d); await sleep(delayTime); }
                    sendLead(lead); count++;
                }
                maxId=r.data?.next_max_id;if(!maxId)break;await sleep(delayTime);
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
                if(shouldFetchBio){ const d=await fetchBio(web,mobile,u.pk,u.username); enrichLead(lead,d); await sleep(delayTime); }
                sendLead(lead); count++;
            }

        } else if (type==='recent_likes') {
            const username=extractUsername(target);
            const {userId}=await getUserId(web,username);
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
                        if(shouldFetchBio){ const d=await fetchBio(web,mobile,u.pk,u.username); enrichLead(lead,d); await sleep(delayTime); }
                        sendLead(lead); count++;
                    }
                }catch(e){send({type:'log',message:`⚠️ Post ${i+1}: ${e.message}`});}
                await sleep(delayTime);
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
                    if(shouldFetchBio){ const d=await fetchBio(web,mobile,u.pk,u.username); enrichLead(lead,d); await sleep(delayTime); }
                    sendLead(lead); count++;
                }
                minId=r.data?.next_min_id;if(!minId)break;await sleep(delayTime);
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
            const {userId:targetId}=await getUserId(web,profileTarget);
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
                        maxId=fr.data?.next_max_id;if(!maxId)break;await sleep(1000);
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
            for(let i=0;i<quick.length&&count<maxLeads&&!stopped;i+=B){const bt=quick.slice(i,i+B);const bs=await Promise.all(bt.map(u=>fetchBio(web,mobile,String(u.pk||u.id),u.username)));let ok=true;bt.forEach((u,j)=>{if(ok)ok=emit(u,bs[j])!==false;});if(!ok)break;await sleep(800);}
            let bc=0;
            for(let i=0;i<needBio.length&&count<maxLeads&&!stopped;i+=B){const bt=needBio.slice(i,i+B);const bs=await Promise.all(bt.map(u=>fetchBio(web,mobile,String(u.pk||u.id),u.username)));let ok=true;bt.forEach((u,j)=>{if(ok&&matchProf(u,bs[j]))ok=emit(u,bs[j])!==false;});bc+=bt.length;if(!ok)break;if(bc%40===0||i+B>=needBio.length)send({type:'log',message:`Bio: ${bc}/${needBio.length} — ${count} encontrados`});await sleep(800);}

        } else if (type==='common_followers') {
            const usernames=target.split(',').map(u=>u.trim().replace('@','')).filter(Boolean);
            if(usernames.length<2)throw new Error('Informe pelo menos 2 perfis');
            const sets=[],maps=[];
            for(const uname of usernames){
                if(stopped)break;
                send({type:'log',message:`Coletando @${uname}...`});
                try{
                    const {userId}=await getUserId(web,uname);
                    const fMap=new Map();let maxId=null;
                    for(let pg=0;pg<400&&!stopped;pg++){
                        const r=await web.get(`/api/v1/friendships/${userId}/followers/`,{params:{count:50,...(maxId?{max_id:maxId}:{})}});
                        igAssert(r.data,`followers @${uname}`);
                        const users=r.data?.users||[];if(!users.length)break;
                        for(const u of users)fMap.set(String(u.pk),u);
                        maxId=r.data?.next_max_id;if(!maxId)break;
                        send({type:'log',message:`@${uname}: ${fMap.size}...`});
                        await sleep(1000);
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
// CNAE LIST — proxy IBGE (com cache em memória)
// ============================================
let cnaeCache = null;
app.get('/api/cnae/list', async (req, res) => {
    if (cnaeCache) return res.json(cnaeCache);
    try {
        const r = await axios.get('https://servicodados.ibge.gov.br/api/v2/cnae/classes', { timeout: 10000 });
        cnaeCache = r.data.map(c => ({ code: String(c.id), desc: c.descricao }));
        res.json(cnaeCache);
    } catch {
        res.json([]);
    }
});

// ============================================
// CNPJ SEARCH — SSE, busca no SQLite local
// ============================================
app.get('/api/cnpj/search', (req, res) => {
    const db = getDb();
    if (!db) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.flushHeaders();
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Base CNPJ não carregada. Execute "node import-receita.js" primeiro.' })}\n\n`);
        return res.end();
    }

    const { cnae, uf, municipio, quantity = '50', hasPhone = 'false', hasMobile = 'false', hasEmail = 'false' } = req.query;
    const maxLeads = Math.min(parseInt(quantity) || 50, 50);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = d => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(d)}\n\n`); };

    try {
        const where  = ["situacao = '02'"]; // só ativas
        const params = [];

        if (cnae)     { where.push('cnae_principal = ?');              params.push(cnae); }
        if (uf)       { where.push('uf = ?');                          params.push(uf.toUpperCase()); }
        if (municipio){ where.push('municipio LIKE ?');                params.push(`%${municipio.toUpperCase()}%`); }
        if (hasPhone  === 'true') { where.push('telefone1 IS NOT NULL AND telefone1 != ""'); }
        if (hasMobile === 'true') { where.push('(length(telefone1) = 9 AND telefone1 LIKE "9%")'); }
        if (hasEmail  === 'true') { where.push('email IS NOT NULL AND email != ""'); }

        send({ type: 'log', message: 'Buscando na base da Receita Federal...' });

        const rows = db.prepare(`
            SELECT * FROM estabelecimentos
            WHERE ${where.join(' AND ')}
            ORDER BY RANDOM()
            LIMIT ?
        `).all(...params, maxLeads);

        rows.forEach(row => {
            const isMobile = row.telefone1 && row.telefone1.length === 9 && row.telefone1.startsWith('9');
            const lead = {
                id:           row.cnpj,
                cnpj:         row.cnpj,
                razaoSocial:  row.razao_social  || '',
                nomeFantasia: row.nome_fantasia  || '',
                cnae:         row.cnae_principal || '',
                cnaeDesc:     row.cnae_desc      || '',
                uf:           row.uf             || '',
                municipio:    row.municipio      || '',
                telefone:     row.ddd1 && row.telefone1 ? `(${row.ddd1}) ${row.telefone1}` : '',
                telefone2:    row.ddd2 && row.telefone2 ? `(${row.ddd2}) ${row.telefone2}` : '',
                email:        row.email          || '',
                endereco:     [row.logradouro, row.numero, row.bairro].filter(Boolean).join(', '),
                cep:          row.cep            || '',
                porte:        row.porte          || '',
                isMobile,
                source: 'cnpj'
            };
            send({ type: 'lead', lead });
        });

        send({ type: 'done', total: rows.length });
    } catch (err) {
        send({ type: 'error', message: err.message });
    }
    res.end();
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

                    igBrowserState.data = {
                        sessionid: sessionid.value,
                        csrftoken: csrftoken?.value || '',
                        dsUserId:  dsUserId?.value  || '',
                        username,
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
// Start
// ============================================
app.listen(PORT, () => {
    console.log(`\n✅ UltraProspec rodando em http://localhost:${PORT}`);
    console.log(`   → Landing:    http://localhost:${PORT}/index.html`);
    console.log(`   → Plataforma: http://localhost:${PORT}/app.html\n`);
});
