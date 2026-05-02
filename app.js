// UltraProspec - App JS

// ============================================
// Créditos — separados por fonte (localStorage)
// ============================================
const CREDITS_KEY_IG   = 'up_credits_ig';
const CREDITS_KEY_CNPJ = 'up_credits_cnpj';

// Migração do sistema antigo (chave única → por fonte)
(function migrateLegacyCredits() {
    const old = localStorage.getItem('up_credits');
    if (old !== null && !localStorage.getItem('up_credits_migrated')) {
        const n = parseInt(old) || 0;
        if (n > 0) localStorage.setItem(CREDITS_KEY_IG, String(n));
        localStorage.removeItem('up_credits');
        localStorage.setItem('up_credits_migrated', '1');
    }
})();

function getCreditsIG()    { return parseInt(localStorage.getItem(CREDITS_KEY_IG)   || '0'); }
function getCreditsCNPJ()  { return parseInt(localStorage.getItem(CREDITS_KEY_CNPJ) || '0'); }
function getActiveCredits(){ return state.activeSource === 'cnpj' ? getCreditsCNPJ() : getCreditsIG(); }

function setCreditsIG(n)   { localStorage.setItem(CREDITS_KEY_IG,   String(Math.max(0, n))); updateCreditsUI(); }
function setCreditsCNPJ(n) { localStorage.setItem(CREDITS_KEY_CNPJ, String(Math.max(0, n))); updateCreditsUI(); }
function deductCredit()    {
    if (state.activeSource === 'cnpj') setCreditsCNPJ(getCreditsCNPJ() - 1);
    else setCreditsIG(getCreditsIG() - 1);
}
function addCredits(n, type) {
    const t = type || state.activeSource || 'instagram';
    if (t === 'cnpj') {
        setCreditsCNPJ(getCreditsCNPJ() + n);
    } else {
        const wasZero = getCreditsIG() === 0;
        setCreditsIG(getCreditsIG() + n);
        if (wasZero && !localStorage.getItem('up_warned')) {
            localStorage.setItem('up_warned', '1');
            setTimeout(() => showToast(
                '💡 Dica: faça capturas com calma — o Instagram pode limitar perfis com muitas requisições seguidas.',
                'warning', 9000
            ), 600);
        }
    }
}

function updateCreditsUI() {
    const ig   = getCreditsIG();
    const cnpj = getCreditsCNPJ();
    const total = ig + cnpj;

    const elIG   = document.getElementById('creditsCountIG');
    const elCNPJ = document.getElementById('creditsCountCNPJ');
    const dispIG   = document.getElementById('creditsDisplayIG');
    const dispCNPJ = document.getElementById('creditsDisplayCNPJ');
    const buyBtn   = document.getElementById('btnBuyCredits');

    if (elIG)   elIG.textContent   = ig;
    if (elCNPJ) elCNPJ.textContent = cnpj;

    if (dispIG) {
        dispIG.style.display = 'flex';
        dispIG.classList.toggle('credits-low',   ig > 0 && ig <= 10);
        dispIG.classList.toggle('credits-empty', ig <= 0);
    }
    if (dispCNPJ) {
        dispCNPJ.style.display = cnpj > 0 ? 'flex' : 'none';
        dispCNPJ.classList.toggle('credits-low', cnpj > 0 && cnpj <= 10);
    }
    if (buyBtn) buyBtn.style.display = 'inline-flex';
}

// ============================================
// State
// ============================================
const state = {
    leads: [],
    filteredLeads: [],
    isCapturing: false,
    startTime: null,
    timerInterval: null,
    selectedIds: new Set(),
    eventSource: null,
    activeFilter: 'all',
    filterWhatsApp: false,
    filterEmail: false,
    filterPublic: false,
    filterSearch: '',
    segmentType: 'all',
    segmentCity: '',
    segmentActive: false,
    segmentReachable: false,
    activeSource: 'instagram', // 'instagram' | 'cnpj'
    cnaeList: [],
    selectedPackType: 'instagram'
};

// ============================================
// Source Toggle (Instagram / CNPJ)
// ============================================
function setSource(source) {
    state.activeSource = source;

    document.getElementById('btnSourceIG').classList.toggle('active',   source === 'instagram');
    document.getElementById('btnSourceCNPJ').classList.toggle('active', source === 'cnpj');
    document.getElementById('sidebarIG').style.display   = source === 'instagram' ? '' : 'none';
    document.getElementById('sidebarCNPJ').style.display = source === 'cnpj'      ? '' : 'none';

    // Troca cabeçalho da tabela
    document.getElementById('theadIG').style.display   = source === 'instagram' ? '' : 'none';
    document.getElementById('theadCNPJ').style.display = source === 'cnpj'      ? '' : 'none';

    // Ajusta filtros visíveis
    const filterTemp = document.querySelector('.filter-group:first-child');
    if (filterTemp) filterTemp.style.display = source === 'instagram' ? '' : 'none';

    // Limpa leads ao trocar fonte
    state.leads = [];
    state.filteredLeads = [];
    document.getElementById('resultsBody').innerHTML =
        `<tr class="empty-row" id="emptyRow"><td colspan="9"><div class="empty-state">
            <i class="fas fa-crosshairs"></i>
            <p>Nenhum lead capturado ainda</p>
            <small>Selecione um tipo de captura e clique em Iniciar</small>
        </div></td></tr>`;
    updateCounts();

    // Pré-seleciona pack no modal
    state.selectedPackType = source;
}

// ============================================
// CNAE Autocomplete
// ============================================
async function loadCnaeList() {
    if (state.cnaeList.length) return;
    try {
        const r = await fetch('/api/cnae/list');
        state.cnaeList = await r.json();
    } catch { state.cnaeList = []; }
}

function filterCnae(query) {
    const dropdown = document.getElementById('cnaeDropdown');
    if (!query || query.length < 2) { dropdown.style.display = 'none'; return; }
    const q = query.toLowerCase();
    const matches = state.cnaeList.filter(c =>
        c.desc.toLowerCase().includes(q) || c.code.startsWith(q)
    ).slice(0, 8);

    if (!matches.length) { dropdown.style.display = 'none'; return; }
    dropdown.innerHTML = matches.map(c =>
        `<div class="cnae-item" onclick="selectCnae('${c.code}','${c.desc.replace(/'/g,"\\'")}')">
            <strong>${c.code}</strong> — ${c.desc}
        </div>`
    ).join('');
    dropdown.style.display = 'block';
}

function selectCnae(code, desc) {
    document.getElementById('cnaeSelected').value = code;
    document.getElementById('cnaeSearch').value   = desc;
    document.getElementById('cnaeSelectedLabel').textContent = `Código: ${code}`;
    document.getElementById('cnaeDropdown').style.display = 'none';
}

function cnpjUFChanged() { /* placeholder para futura busca de municípios */ }

// ============================================
// Buy Modal
// ============================================
function openBuyModal() {
    document.getElementById('buyError').style.display = 'none';
    // Pré-seleciona o pack da fonte ativa
    selectPack(state.activeSource === 'cnpj' ? 'cnpj' : 'instagram');
    document.getElementById('buyModal').classList.add('active');
}

function closeBuyModal() {
    document.getElementById('buyModal').classList.remove('active');
}

function selectPack(type) {
    state.selectedPackType = type;
    const packIG   = document.getElementById('packIG');
    const packCNPJ = document.getElementById('packCNPJ');
    if (packIG && packCNPJ) {
        packIG.style.border   = type === 'instagram' ? '2px solid var(--primary)' : '2px solid transparent';
        packIG.style.background   = type === 'instagram' ? 'rgba(0,200,83,.06)' : 'rgba(255,255,255,.04)';
        packCNPJ.style.border = type === 'cnpj'      ? '2px solid var(--primary)' : '2px solid transparent';
        packCNPJ.style.background = type === 'cnpj' ? 'rgba(0,200,83,.06)' : 'rgba(255,255,255,.04)';
    }
}

function simulatePayment() {
    const type = state.selectedPackType || 'instagram';
    const n    = type === 'cnpj' ? 50 : 100;
    addCredits(n, type);
    closeBuyModal();
    showToast(`✅ ${n} leads ${type === 'cnpj' ? 'CNPJ' : 'Instagram'} adicionados (modo teste)`, 'success');
}

async function goToCheckout() {
    const btn  = document.getElementById('btnCheckout');
    const type = state.selectedPackType || 'instagram';
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Aguarde...';
    document.getElementById('buyError').style.display = 'none';
    try {
        const res  = await fetch('/api/payment/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }) });
        const data = await res.json();
        if (data.checkoutUrl) {
            window.location.href = data.checkoutUrl;
        } else {
            document.getElementById('buyError').textContent = data.error || 'Erro ao criar pagamento.';
            document.getElementById('buyError').style.display = 'block';
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-credit-card"></i> Pagar R$10 com Stripe';
        }
    } catch {
        document.getElementById('buyError').textContent = 'Erro de conexão. Tente novamente.';
        document.getElementById('buyError').style.display = 'block';
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-credit-card"></i> Pagar R$10 com Stripe';
    }
}

// ============================================
// Score
// ============================================
function recencyMultiplier(ts) {
    if (!ts) return 0;
    const days = (Date.now() / 1000 - ts) / 86400;
    if (days <= 1)  return 2.0;
    if (days <= 3)  return 1.6;
    if (days <= 7)  return 1.3;
    if (days <= 30) return 1.0;
    if (days <= 90) return 0.6;
    return 0.3;
}

function recencyText(ts) {
    if (!ts) return '';
    const days = (Date.now() / 1000 - ts) / 86400;
    if (days <= 1)   return 'hoje';
    if (days <= 2)   return 'ontem';
    if (days <= 7)   return `há ${Math.round(days)} dias`;
    if (days <= 30)  return `há ${Math.round(days / 7)} sem.`;
    if (days <= 365) return `há ${Math.round(days / 30)} meses`;
    return 'há +1 ano';
}

function calculateScore(lead) {
    let s = 0;
    // Engajamento ponderado por recência
    if (lead.mostRecentComment) { s += Math.round(38 * recencyMultiplier(lead.mostRecentComment)); if (lead.commentCount >= 3) s += 8; }
    else if (lead.commentCount >= 1) s += 35;

    if (lead.mostRecentLike) { s += Math.round((lead.likeCount >= 3 ? 22 : 14) * recencyMultiplier(lead.mostRecentLike)); }
    else if (lead.likeCount >= 3) s += 22;
    else if (lead.likeCount >= 1) s += 12;

    if (lead.isFollower)      s += 15;
    if (lead.crossCount >= 2) s += 15;
    // Contato direto
    if (lead.whatsapp)        s += 20;
    if (lead.publicPhone)     s += 15;
    if (lead.email)           s += 12;
    if (lead.publicEmail)     s += 10;
    // Perfil ativo
    if (lead.mediaCount > 10)      s += 8;
    else if (lead.mediaCount > 0)  s += 3;
    if (lead.bio?.length > 20)     s += 5;
    if (!lead.isPrivate)           s += 5;
    // Ratio seguidor/seguindo
    if (lead.followingCount > 0 && (lead.followerCount / lead.followingCount) < 0.5) s += 5;
    return Math.min(s, 100);
}

function scoreLabel(score) {
    if (score >= 65) return { label: '🔥 Quente',  cls: 'score-hot'  };
    if (score >= 35) return { label: '🌡️ Morno',   cls: 'score-warm' };
    return            { label: '❄️ Frio',      cls: 'score-cold' };
}

function isB2B(lead) {
    if (lead.isBusinessAccount) return true;
    const bio = (lead.bio || '').toLowerCase();
    const b2bKw = ['ceo','fundador','founder','empresa','ltda',' me,','cnpj','diretor','gerente',
                   'proprietário','sócio','empresário','agência','consultoria','marketing','vendas',
                   'empreendedor','negócio','startup','comercial'];
    return b2bKw.some(k => bio.includes(k));
}

function buildWhyHtml(lead) {
    const pills = [];
    if (lead.commentCount >= 1) {
        const when = lead.mostRecentComment ? ` (${recencyText(lead.mostRecentComment)})` : '';
        pills.push(`<span class="why-pill why-comment">Comentou ${lead.commentCount}x${when}</span>`);
    }
    if (lead.likeCount >= 1) {
        const when = lead.mostRecentLike ? ` (${recencyText(lead.mostRecentLike)})` : '';
        pills.push(`<span class="why-pill why-like">Curtiu ${lead.likeCount}x${when}</span>`);
    }
    if (lead.isFollower)          pills.push('<span class="why-pill why-follower">Segue o perfil</span>');
    if (lead.crossCount >= 2)     pills.push(`<span class="why-pill why-cross">Segue ${lead.crossCount} perfis</span>`);
    if (lead.whatsapp)            pills.push('<span class="why-pill why-contact">WhatsApp</span>');
    if (lead.publicPhone)         pills.push('<span class="why-pill why-contact">Tel. público</span>');
    if (lead.email || lead.publicEmail) pills.push('<span class="why-pill why-contact">Email</span>');
    if (lead.city)                pills.push(`<span class="why-pill why-cross">${lead.city}</span>`);
    if (lead.isBusinessAccount)   pills.push('<span class="why-pill why-follower">Conta Business</span>');
    if (lead.category)            pills.push(`<span class="why-pill why-follower">${lead.category}</span>`);
    if (lead.mediaCount > 10)     pills.push('<span class="why-pill why-follower">Conta ativa</span>');
    if (lead.actions?.length && !pills.length)
        lead.actions.forEach(a => pills.push(`<span class="why-pill why-follower">${a}</span>`));
    return pills.join('') || '<span style="color:var(--gray);font-size:.75rem">Dados insuficientes</span>';
}

// ============================================
// Login
// ============================================
let loginStep = 1;
let activeLoginTab = 'cookie';

const IG_KEY = 'up_ig_session';

function saveIgSession(creds)  { localStorage.setItem(IG_KEY, JSON.stringify(creds)); }
function clearIgSession()      { localStorage.removeItem(IG_KEY); }
function loadIgSession()       { try { return JSON.parse(localStorage.getItem(IG_KEY) || 'null'); } catch { return null; } }

async function checkLoginStatus() {
    try {
        const res  = await fetch('/api/status');
        const data = await res.json();
        if (data.loggedIn) { updateLoginUI(true, data.user); return; }

        // Sessão do servidor perdida (restart) — tenta restaurar do localStorage
        const saved = loadIgSession();
        if (!saved?.sessionid) { updateLoginUI(false, null); return; }

        const r = await fetch('/api/login-cookie', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(saved)
        });
        const d = await r.json();
        if (d.success) {
            updateLoginUI(true, d.user);
            showToast(`Instagram reconectado: @${d.user.username}`, 'success');
        } else {
            clearIgSession();
            updateLoginUI(false, null);
        }
    } catch { updateLoginUI(false, null); }
}

function updateLoginUI(loggedIn, user) {
    const dot     = document.getElementById('statusDot');
    const text    = document.getElementById('loginStatusText');
    const btn     = document.getElementById('btnAbrirLogin');
    const prompt  = document.getElementById('igLoginPrompt');

    if (loggedIn && user) {
        dot.className    = 'status-dot online';
        text.textContent = `@${user.username}`;
        btn.innerHTML    = '<i class="fas fa-sign-out-alt"></i> Sair';
        btn.onclick      = logout;
        if (prompt) prompt.style.display = 'none';
    } else {
        dot.className    = 'status-dot offline';
        text.textContent = 'Não conectado';
        btn.innerHTML    = '<i class="fas fa-sign-in-alt"></i> Login';
        btn.onclick      = openLoginModal;
        if (prompt) prompt.style.display = 'block';
    }
}

function openLoginModal() {
    loginStep = 1;
    activeLoginTab = 'cookie';
    document.getElementById('loginModal').classList.add('active');
    document.getElementById('tabCookie').style.display   = 'block';
    document.getElementById('tabPassword').style.display = 'none';
    document.querySelectorAll('.login-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'cookie'));
}

function closeLoginModal() {
    document.getElementById('loginModal').classList.remove('active');
    document.getElementById('loginError').style.display = 'none';
    ['igCookieUsername','igSessionId','igCsrfToken','igDsUserId','igUsername','igPassword','igCode'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    loginStep = 1;
}

function switchLoginTab(tab) {
    activeLoginTab = tab;
    document.getElementById('tabCookie').style.display   = tab === 'cookie'   ? 'block' : 'none';
    document.getElementById('tabPassword').style.display = tab === 'password' ? 'block' : 'none';
    document.querySelectorAll('.login-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const btn = document.getElementById('btnConfirmLogin');
    btn.innerHTML = tab === 'cookie' ? '<i class="fas fa-sign-in-alt"></i> Entrar com Session ID' : '<i class="fas fa-sign-in-alt"></i> Entrar';
    document.getElementById('loginError').style.display = 'none';
}

async function login() {
    if (activeLoginTab === 'cookie') { await loginWithCookie(); return; }
    if (loginStep === 2)             { await submitChallenge(); return; }

    const username = document.getElementById('igUsername').value.trim();
    const password = document.getElementById('igPassword').value;
    const errorEl  = document.getElementById('loginError');
    const btn      = document.getElementById('btnConfirmLogin');

    if (!username || !password) { errorEl.textContent = 'Preencha usuário e senha.'; errorEl.style.display = 'block'; return; }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Entrando...';
    errorEl.style.display = 'none';

    try {
        const res  = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
        const data = await res.json();
        if (data.success) { closeLoginModal(); updateLoginUI(true, data.user); showToast(`Conectado como @${data.user.username}`, 'success'); }
        else if (data.checkpointRequired) {
            loginStep = 2;
            document.getElementById('loginStep1').style.display = 'none';
            document.getElementById('loginStep2').style.display = 'block';
            btn.innerHTML = '<i class="fas fa-check"></i> Verificar';
            showToast('Código enviado! Verifique seu email ou SMS.', 'info');
        } else { errorEl.textContent = data.error || 'Falha no login.'; errorEl.style.display = 'block'; }
    } catch { errorEl.textContent = 'Erro de conexão.'; errorEl.style.display = 'block'; }
    finally { btn.disabled = false; if (loginStep === 1) btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Entrar'; }
}

async function loginWithCookie() {
    const sessionid = document.getElementById('igSessionId').value.trim();
    const username  = document.getElementById('igCookieUsername').value.trim();
    const csrftoken = document.getElementById('igCsrfToken').value.trim();
    const dsUserId  = document.getElementById('igDsUserId').value.trim();
    const errorEl   = document.getElementById('loginError');
    const btn       = document.getElementById('btnConfirmLogin');

    if (!username || !sessionid) { errorEl.textContent = 'Usuário e Session ID obrigatórios.'; errorEl.style.display = 'block'; return; }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verificando...';
    errorEl.style.display = 'none';

    try {
        const res  = await fetch('/api/login-cookie', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionid, username, csrftoken, dsUserId }) });
        const data = await res.json();
        if (data.success) { saveIgSession({ username, sessionid, csrftoken, dsUserId }); closeLoginModal(); updateLoginUI(true, data.user); showToast(`Conectado como @${data.user.username}`, 'success'); }
        else { errorEl.textContent = data.error || 'Falha.'; errorEl.style.display = 'block'; }
    } catch { errorEl.textContent = 'Erro de conexão.'; errorEl.style.display = 'block'; }
    finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Entrar com Session ID'; }
}

async function submitChallenge() {
    const code    = document.getElementById('igCode').value.trim();
    const errorEl = document.getElementById('loginError');
    const btn     = document.getElementById('btnConfirmLogin');
    if (!code) { errorEl.textContent = 'Digite o código.'; errorEl.style.display = 'block'; return; }
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verificando...';
    try {
        const res  = await fetch('/api/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
        const data = await res.json();
        if (data.success) { closeLoginModal(); updateLoginUI(true, data.user); showToast(`Conectado como @${data.user.username}`, 'success'); }
        else { errorEl.textContent = data.error || 'Código inválido.'; errorEl.style.display = 'block'; btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Verificar'; }
    } catch { errorEl.textContent = 'Erro de conexão.'; errorEl.style.display = 'block'; btn.disabled = false; }
}

async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    clearIgSession();
    updateLoginUI(false, null);
    showToast('Sessão encerrada', 'info');
}

// ============================================
// Capture Type Switcher
// ============================================
function getCurrentConfig() {
    const type = document.querySelector('input[name="captureType"]:checked')?.value;
    const config = document.getElementById(`config-${type}`);
    const target = config?.querySelector('.target-input')?.value?.trim() || '';
    const posts  = config?.querySelector('.posts-input')?.value || '10';
    const profileTarget = type === 'hashtag'
        ? (document.getElementById('hashtagProfile')?.value?.trim() || '')
        : '';
    return { type, target, posts, profileTarget };
}

document.querySelectorAll('input[name="captureType"]').forEach(radio => {
    radio.addEventListener('change', () => {
        document.querySelectorAll('.capture-config').forEach(c => c.style.display = 'none');
        document.querySelectorAll('.capture-type-card').forEach(c => c.classList.remove('active'));
        const activeCard = document.querySelector(`.capture-type-card[data-type="${radio.value}"]`);
        if (activeCard) activeCard.classList.add('active');
        const config = document.getElementById(`config-${radio.value}`);
        if (config) config.style.display = 'block';
    });
});

// ============================================
// Capture
// ============================================
async function startCapture() {
    if (state.activeSource === 'cnpj') { startCaptureCNPJ(); return; }

    // Créditos primeiro — sem créditos abre compra imediatamente
    if (getCreditsIG() <= 0) {
        openBuyModal();
        return;
    }

    // Depois verifica login do Instagram
    const igSession = loadIgSession();
    if (!igSession?.loggedIn) {
        openLoginModal();
        return;
    }

    const { type, target, posts, profileTarget } = getCurrentConfig();
    const quantity  = parseInt(document.getElementById('quantity').value) || 200;
    const fetchBio  = document.getElementById('extractWhatsApp').checked || document.getElementById('extractEmail').checked;

    if (type === 'hashtag' && !profileTarget) { showToast('Informe o perfil alvo para varrer', 'error'); return; }
    if (!target) { showToast('Informe o alvo da captura', 'error'); return; }

    state.isCapturing = true;
    state.startTime   = new Date();
    updateCaptureUI(true);
    document.getElementById('progressContainer').style.display = 'block';
    setCaptureStatus('Capturando...', true);
    startTimer();

    const params = new URLSearchParams({ type, target, quantity, fetchBio: fetchBio ? 'true' : 'false', posts });
    if (profileTarget) params.set('profileTarget', profileTarget);
    const es = new EventSource(`/api/capture?${params}`);
    state.eventSource = es;

    es.onmessage = e => {
        const data = JSON.parse(e.data);
        if (data.type === 'lead') {
            if (state.leads.some(l => l.id === data.lead.id)) return; // dedup

            // Deduz 1 crédito do localStorage a cada lead recebido
            const remaining = getCreditsIG() - 1;
            setCreditsIG(remaining);

            data.lead.score = calculateScore(data.lead);
            state.leads.push(data.lead);
            updateProgress(state.leads.length, quantity);

            // Parar captura se créditos acabaram
            if (remaining <= 0) {
                es.close(); state.eventSource = null;
                renderAllLeads(); updateCounts();
                finishCapture(`${state.leads.length} leads capturados — créditos esgotados`, 'warning');
                setTimeout(() => openBuyModal(), 800);
                return;
            }

            const captureType = document.querySelector('input[name="captureType"]:checked')?.value;
            if (captureType !== 'profile_analysis') {
                try { renderRow(data.lead); } catch(e) { console.error('renderRow error:', e); }
                updateCounts();
            }
        } else if (data.type === 'log') {
            document.getElementById('progressText').textContent = data.message;
            const msg = data.message;
            if      (msg.includes('Fase 1/3')) setProgress(15, msg);
            else if (msg.includes('Fase 2/3')) setProgress(45, msg);
            else if (msg.includes('Fase 3/3')) {
                const m = msg.match(/Post (\d+)\/(\d+)/);
                if (m) setProgress(50 + Math.round((parseInt(m[1]) / parseInt(m[2])) * 40), msg);
                else   setProgress(50, msg);
            }
            else if (msg.includes('Calculando')) setProgress(92, msg);
            else if (msg.includes('Enviando'))   setProgress(97, msg);
        } else if (data.type === 'done') {
            es.close(); state.eventSource = null;
            renderAllLeads();
            updateCounts();
            setProgress(100, `${state.leads.length} leads carregados`);
            finishCapture(`Concluído — ${state.leads.length} leads encontrados`, 'success');
            updateCreditsUI();
        } else if (data.type === 'error') {
            es.close(); state.eventSource = null;
            if (data.message?.includes('Créditos')) openBuyModal();
            finishCapture(data.message, 'error');
        }
    };

    es.onerror = () => {
        es.close();
        const wasCapturing = state.isCapturing;
        state.eventSource = null;
        if (wasCapturing) finishCapture('Conexão interrompida', 'error');
    };
}

function stopCapture() {
    if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
    finishCapture('Captura interrompida', 'warning');
}

// ============================================
// Captura CNPJ
// ============================================
function startCaptureCNPJ() {
    if (getCreditsCNPJ() <= 0) { openBuyModal(); return; }

    const cnae     = document.getElementById('cnaeSelected').value.trim();
    const uf       = document.getElementById('cnpjUF').value.trim();
    const city     = document.getElementById('cnpjCity').value.trim();
    const quantity = Math.min(parseInt(document.getElementById('cnpjQuantity').value) || 50, 50);
    const hasPhone  = document.getElementById('cnpjHasPhone').checked;
    const hasMobile = document.getElementById('cnpjHasMobile').checked;
    const hasEmail  = document.getElementById('cnpjHasEmail').checked;

    state.isCapturing = true;
    state.startTime   = new Date();
    updateCaptureUI(true);
    document.getElementById('progressContainer').style.display = 'block';
    setCaptureStatus('Buscando empresas...', true);
    startTimer();

    const params = new URLSearchParams({ quantity, hasPhone, hasMobile, hasEmail });
    if (cnae) params.set('cnae', cnae);
    if (uf)   params.set('uf', uf);
    if (city) params.set('municipio', city);

    const es = new EventSource(`/api/cnpj/search?${params}`);
    state.eventSource = es;

    es.onmessage = e => {
        const data = JSON.parse(e.data);
        if (data.type === 'lead') {
            if (state.leads.some(l => l.id === data.lead.id)) return;

            const remaining = getCreditsCNPJ() - 1;
            setCreditsCNPJ(remaining);

            state.leads.push(data.lead);
            updateProgress(state.leads.length, quantity);
            try { renderRowCNPJ(data.lead); } catch(err) { console.error(err); }
            updateCounts();

            if (remaining <= 0) {
                es.close(); state.eventSource = null;
                finishCapture(`${state.leads.length} leads capturados — créditos esgotados`, 'warning');
                setTimeout(() => openBuyModal(), 800);
            }
        } else if (data.type === 'log') {
            document.getElementById('progressText').textContent = data.message;
        } else if (data.type === 'done') {
            es.close(); state.eventSource = null;
            setProgress(100, `${state.leads.length} empresas encontradas`);
            finishCapture(`Concluído — ${state.leads.length} leads CNPJ encontrados`, 'success');
            updateCreditsUI();
        } else if (data.type === 'error') {
            es.close(); state.eventSource = null;
            finishCapture(data.message, 'error');
        }
    };

    es.onerror = () => {
        es.close();
        const wasCapturing = state.isCapturing;
        state.eventSource = null;
        if (wasCapturing) finishCapture('Conexão interrompida', 'error');
    };
}

function renderRowCNPJ(lead) {
    const tbody = document.getElementById('resultsBody');
    document.getElementById('emptyRow')?.remove();

    const nome = lead.nomeFantasia || lead.razaoSocial || '-';
    const tel1 = lead.telefone  || '-';
    const tel2 = lead.isMobile ? lead.telefone : (lead.telefone2 || '-');
    const celular = lead.isMobile ? lead.telefone : (lead.telefone2 && lead.telefone2.replace(/\D/g,'').length === 11 ? lead.telefone2 : '-');
    const fixo    = !lead.isMobile ? lead.telefone : (lead.telefone2 || '-');

    const row = document.createElement('tr');
    row.dataset.id       = lead.id;
    row.dataset.has_email = lead.email ? '1' : '0';

    row.innerHTML = `
        <td><input type="checkbox" class="row-checkbox" data-id="${lead.id}"></td>
        <td style="max-width:160px"><strong style="font-size:.85rem">${nome}</strong><br><small style="color:var(--gray);font-size:.75rem">${lead.razaoSocial !== nome ? lead.razaoSocial : ''}</small></td>
        <td style="font-size:.8rem;font-family:monospace">${lead.cnpj || '-'}</td>
        <td style="font-size:.78rem;max-width:140px" title="${lead.cnaeDesc}">${lead.cnaeDesc ? lead.cnaeDesc.slice(0,40)+(lead.cnaeDesc.length>40?'…':'') : lead.cnae || '-'}</td>
        <td style="font-size:.82rem">${fixo !== '-' ? `<i class="fas fa-phone" style="color:var(--gray);font-size:.7rem"></i> ${fixo}` : '-'}</td>
        <td style="font-size:.82rem">${celular !== '-' ? `<a href="https://wa.me/55${celular.replace(/\D/g,'')}" target="_blank" class="contact-link wa-link"><i class="fab fa-whatsapp"></i> ${celular}</a>` : '-'}</td>
        <td class="email-value">${lead.email ? `<a href="mailto:${lead.email}" class="contact-link mail-link"><i class="fas fa-envelope"></i> ${lead.email}</a>` : '-'}</td>
        <td style="font-size:.82rem">${lead.municipio || ''}${lead.municipio && lead.uf ? ' / ' : ''}${lead.uf || ''}</td>
        <td><button class="action-btn delete" onclick="deleteLead('${lead.id}')" title="Excluir"><i class="fas fa-trash"></i></button></td>
    `;
    tbody.appendChild(row);
}

function finishCapture(msg, type) {
    state.isCapturing = false;
    stopTimer();
    updateCaptureUI(false);
    setCaptureStatus(msg, false);
    document.getElementById('btnExportar').disabled    = state.leads.length === 0;
    document.getElementById('btnExportarPDF').disabled = state.leads.length === 0;
    showToast(msg, type);
    // Auto-download do PDF sempre que houver leads — evita perda ao recarregar a página
    if (state.leads.length > 0 && type !== 'error') {
        setTimeout(function () {
            showToast('📄 Salvando PDF automaticamente...', 'info', 6000);
            setTimeout(exportToPDF, 600);
        }, 1200);
    }
}

function updateCaptureUI(capturing) {
    document.getElementById('btnIniciarCaptura').style.display = capturing ? 'none' : 'block';
    document.getElementById('btnPararCaptura').style.display   = capturing ? 'block' : 'none';
    document.querySelectorAll('.sidebar input, .sidebar select, .sidebar textarea').forEach(el => el.disabled = capturing);
}

function setCaptureStatus(text, active) {
    const dot = document.getElementById('statusDotCapture');
    document.getElementById('captureStatusText').textContent = text;
    dot.style.color = active ? 'var(--success)' : 'var(--gray)';
}

// ============================================
// Timer
// ============================================
function startTimer() {
    state.timerInterval = setInterval(() => {
        const s = Math.floor((new Date() - state.startTime) / 1000);
        document.getElementById('elapsedTime').textContent =
            `${Math.floor(s / 60).toString().padStart(2,'0')}:${(s % 60).toString().padStart(2,'0')}`;
    }, 1000);
}
function stopTimer() { if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; } }

// ============================================
// Rendering
// ============================================
function renderRow(lead, prepend = false) {
    if (!passesFilter(lead)) return;

    const tbody = document.getElementById('resultsBody');
    document.getElementById('emptyRow')?.remove();

    const score = lead.score ?? calculateScore(lead);
    const { label: slabel, cls } = scoreLabel(score);

    const photoHtml = lead.photoUrl
        ? `<img src="${lead.photoUrl}" class="user-photo" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
           <div class="user-photo-placeholder" style="display:none">${(lead.fullName || lead.username).charAt(0).toUpperCase()}</div>`
        : `<div class="user-photo-placeholder">${(lead.fullName || lead.username).charAt(0).toUpperCase()}</div>`;

    const row = document.createElement('tr');
    row.dataset.id           = lead.id;
    row.dataset.scoreVal     = score;
    row.dataset.score        = cls;
    row.dataset.has_whatsapp = lead.whatsapp ? '1' : '0';
    row.dataset.has_email    = lead.email    ? '1' : '0';
    row.dataset.is_public    = lead.isPrivate ? '0' : '1';
    row.dataset.username     = (lead.username || '').toLowerCase();
    row.dataset.fullname     = (lead.fullName  || '').toLowerCase();

    row.innerHTML = `
        <td><input type="checkbox" class="row-checkbox" data-id="${lead.id}"></td>
        <td>${photoHtml}</td>
        <td><a href="https://instagram.com/${lead.username}" target="_blank" class="ig-link">@${lead.username}</a>${lead.isPrivate ? ' <i class="fas fa-lock" style="color:var(--gray);font-size:.7rem"></i>' : ''}<br><small style="color:var(--gray)">${lead.fullName || ''}</small></td>
        <td><span class="score-badge ${cls}">${slabel}<br><small>${score}pts</small></span></td>
        <td class="why-cell">${buildWhyHtml(lead)}</td>
        <td class="whatsapp-value">${lead.whatsapp ? `<a href="https://wa.me/${lead.whatsapp.replace(/\D/g,'')}" target="_blank" class="contact-link wa-link"><i class="fab fa-whatsapp"></i> ${lead.whatsapp}</a>` : '-'}</td>
        <td class="email-value">${lead.email ? `<a href="mailto:${lead.email}" class="contact-link mail-link"><i class="fas fa-envelope"></i> ${lead.email}</a>` : '-'}</td>
        <td class="bio-text" title="${lead.bio || ''}">${lead.bio ? lead.bio.slice(0, 60) + (lead.bio.length > 60 ? '...' : '') : '-'}</td>
        <td><button class="action-btn delete" onclick="deleteLead('${lead.id}')" title="Excluir"><i class="fas fa-trash"></i></button></td>
    `;

    // Inserir em ordem de score
    const rows = [...tbody.querySelectorAll('tr[data-id]')];
    const insertBefore = rows.find(r => parseInt(r.dataset.scoreVal || 0) < score);
    if (insertBefore) tbody.insertBefore(row, insertBefore);
    else tbody.appendChild(row);
}

function renderAllLeads() {
    const tbody = document.getElementById('resultsBody');
    tbody.innerHTML = '';

    // Ordenar por score antes de renderizar
    state.filteredLeads = state.leads
        .filter(passesFilter)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    if (state.filteredLeads.length === 0) {
        tbody.innerHTML = `<tr class="empty-row" id="emptyRow"><td colspan="10"><div class="empty-state">
            <i class="fas fa-filter"></i><p>Nenhum lead com esses filtros</p></div></td></tr>`;
    } else {
        // Inserir direto sem re-verificar passesFilter dentro de renderRow
        state.filteredLeads.forEach(lead => {
            const score = lead.score ?? 0;
            const { label: slabel, cls } = scoreLabel(score);
            const photoHtml = lead.photoUrl
                ? `<img src="${lead.photoUrl}" class="user-photo" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                   <div class="user-photo-placeholder" style="display:none">${(lead.fullName||lead.username).charAt(0).toUpperCase()}</div>`
                : `<div class="user-photo-placeholder">${(lead.fullName||lead.username).charAt(0).toUpperCase()}</div>`;

            const row = document.createElement('tr');
            row.dataset.id       = lead.id;
            row.dataset.scoreVal = score;
            row.dataset.score    = cls;

            row.innerHTML = `
                <td><input type="checkbox" class="row-checkbox" data-id="${lead.id}"></td>
                <td>${photoHtml}</td>
                <td><a href="https://instagram.com/${lead.username}" target="_blank" class="ig-link">@${lead.username}</a>${lead.isPrivate?' <i class="fas fa-lock" style="color:var(--gray);font-size:.7rem"></i>':''}<br><small style="color:var(--gray)">${lead.fullName||''}</small></td>
                <td><span class="score-badge ${cls}">${slabel}<br><small>${score}pts</small></span></td>
                <td class="why-cell">${buildWhyHtml(lead)}</td>
                <td class="whatsapp-value">${lead.whatsapp?`<a href="https://wa.me/${lead.whatsapp.replace(/\D/g,'')}" target="_blank" class="contact-link wa-link"><i class="fab fa-whatsapp"></i> ${lead.whatsapp}</a>`:'-'}</td>
                <td class="email-value">${lead.email?`<a href="mailto:${lead.email}" class="contact-link mail-link"><i class="fas fa-envelope"></i> ${lead.email}</a>`:'-'}</td>
                <td class="bio-text" title="${lead.bio||''}">${lead.bio?lead.bio.slice(0,60)+(lead.bio.length>60?'...':''):'-'}</td>
                <td><button class="action-btn delete" onclick="deleteLead('${lead.id}')" title="Excluir"><i class="fas fa-trash"></i></button></td>
            `;
            tbody.appendChild(row);
        });
    }

    document.getElementById('filteredCount').textContent = `(${state.filteredLeads.length})`;
}

function passesFilter(lead) {
    // Filtros básicos
    if (state.filterWhatsApp && !lead.whatsapp)  return false;
    if (state.filterEmail    && !lead.email)      return false;
    if (state.filterPublic   && lead.isPrivate)   return false;

    // Busca
    if (state.filterSearch) {
        const q = state.filterSearch.toLowerCase();
        if (!(lead.username || '').toLowerCase().includes(q) &&
            !(lead.fullName  || '').toLowerCase().includes(q)) return false;
    }

    // Temperatura
    const score = lead.score ?? 0;
    if (state.activeFilter === 'hot')  return score >= 65;
    if (state.activeFilter === 'warm') return score >= 35 && score < 65;
    if (state.activeFilter === 'cold') return score < 35;

    // Segmentação
    if (state.segmentType === 'b2b' && !isB2B(lead)) return false;
    if (state.segmentType === 'b2c' && isB2B(lead))  return false;
    if (state.segmentCity) {
        const city = (lead.city || '').toLowerCase();
        if (!city.includes(state.segmentCity.toLowerCase())) return false;
    }
    if (state.segmentActive    && (!lead.mediaCount || lead.mediaCount === 0)) return false;
    // C6 FIX: OR lógico — basta ter qualquer meio de contato
    if (state.segmentReachable && !(lead.whatsapp || lead.email || lead.publicPhone || lead.publicEmail)) return false;

    return true;
}

function updateProgress(current, total) {
    const pct = Math.min(Math.round((current / total) * 100), 100);
    setProgress(pct, `${current} leads recebidos...`);
}

function setProgress(pct, text) {
    document.getElementById('progressFill').style.width = `${pct}%`;
    document.getElementById('progressPercent').textContent = `${pct}%`;
    if (text) document.getElementById('progressText').textContent = text;
}

function updateCounts() {
    document.getElementById('leadCount').textContent = state.leads.length;
    const hot = state.leads.filter(l => (l.score ?? 0) >= 65).length;
    document.getElementById('hotCount').textContent = hot;
    document.getElementById('filteredCount').textContent = `(${document.querySelectorAll('#resultsBody tr:not(.empty-row)').length})`;
}

// ============================================
// Lead Actions
// ============================================
function deleteLead(id) {
    state.leads = state.leads.filter(l => l.id != id);
    document.querySelector(`tr[data-id="${id}"]`)?.remove();
    updateCounts();
    document.getElementById('btnExportar').disabled    = state.leads.length === 0;
    document.getElementById('btnExportarPDF').disabled = state.leads.length === 0;
    if (state.leads.length === 0) showEmptyState();
}

function showEmptyState() {
    document.getElementById('resultsBody').innerHTML = `
        <tr class="empty-row" id="emptyRow"><td colspan="10">
        <div class="empty-state"><i class="fas fa-crosshairs"></i>
        <p>Nenhum lead capturado ainda</p>
        <small>Selecione um tipo de captura e clique em Iniciar</small></div></td></tr>`;
}

function selectAll() {
    document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = true);
    state.selectedIds = new Set(state.leads.map(l => l.id));
}

function clearSelection() {
    document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = false);
    state.selectedIds.clear();
}

function deleteSelected() {
    if (!state.selectedIds.size) { showToast('Nenhum lead selecionado', 'warning'); return; }
    const count = state.selectedIds.size;
    state.leads = state.leads.filter(l => !state.selectedIds.has(l.id));
    state.selectedIds.forEach(id => document.querySelector(`tr[data-id="${id}"]`)?.remove());
    state.selectedIds.clear();
    updateCounts();
    document.getElementById('btnExportar').disabled    = state.leads.length === 0;
    document.getElementById('btnExportarPDF').disabled = state.leads.length === 0;
    if (!state.leads.length) showEmptyState();
    showToast(`${count} leads excluídos`, 'success');
}

// ============================================
// PDF Export
// ============================================
function exportToPDF() {
    if (typeof html2pdf === 'undefined') { showToast('Biblioteca PDF ainda carregando. Aguarde e tente novamente.', 'error'); return; }
    if (!state.leads.length) { showToast('Nenhum lead para exportar', 'warning'); return; }

    // Sempre inclui todos os leads: quentes no topo, frios no final

    // Detectar método de captura pelo source dos leads
    const sources    = [...new Set(state.leads.map(l => l.source).filter(Boolean))];
    const isHashtag  = sources.some(s => s.startsWith('busca:') || s.startsWith('#'));
    const isFollower = sources.some(s => s.includes('seguidor') || s.includes('@'));
    const isLikes    = sources.some(s => s.includes('curtidor'));
    const keywords   = sources.filter(s => s.startsWith('busca:')).map(s => s.replace('busca:', '').trim());

    const captureMethod = isHashtag
        ? `Busca por Profissional — palavras-chave: ${keywords.join(', ') || sources.join(', ')}`
        : isLikes
            ? `Curtidores de Posts Recentes — ${sources.join(', ')}`
            : `Análise de Perfil — ${sources.join(', ')}`;

    // Para busca por profissional, incluir todos (não faz sentido hot/cold para busca por nicho)
    const sorted = [...state.leads]
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)); // hot → warm → cold

    if (!sorted.length) {
        showToast('Nenhum lead para exportar com os filtros atuais', 'warning');
        return;
    }

    const total    = sorted.length;
    const hot      = sorted.filter(l => (l.score ?? 0) >= 65).length;
    const warm     = sorted.filter(l => (l.score ?? 0) >= 35 && (l.score ?? 0) < 65).length;
    const cold     = sorted.filter(l => (l.score ?? 0) < 30).length;
    const withWA   = sorted.filter(l => l.whatsapp).length;
    const withMail = sorted.filter(l => l.email).length;
    const profile  = sorted[0]?.source || 'Instagram';
    const date     = new Date().toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' });

    const actionPill = (text, color) =>
        `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:600;background:${color}20;color:${color};border:1px solid ${color}40;margin:2px">${text}</span>`;

    const recDays = ts => ts ? (Date.now() / 1000 - ts) / 86400 : 999;
    const recTxt  = ts => {
        if (!ts) return '';
        const d = recDays(ts);
        if (d <= 1)   return ' (hoje)';
        if (d <= 2)   return ' (ontem)';
        if (d <= 7)   return ` (há ${Math.round(d)} dias)`;
        if (d <= 30)  return ` (há ${Math.round(d/7)} semanas)`;
        return ` (há ${Math.round(d/30)} meses)`;
    };

    const whyPills = lead => {
        const pills = [];
        if (lead.commentCount > 0)  pills.push(actionPill(`Comentou ${lead.commentCount}x${recTxt(lead.mostRecentComment)}`, '#00962E'));
        if (lead.likeCount > 0)     pills.push(actionPill(`Curtiu ${lead.likeCount}x${recTxt(lead.mostRecentLike)}`,         '#00C853'));
        if (lead.isFollower)          pills.push(actionPill('Segue o perfil',              '#2ECC71'));
        if (lead.crossCount >= 2)     pills.push(actionPill(`Segue ${lead.crossCount} perfis`, '#F39C12'));
        if (lead.whatsapp)            pills.push(actionPill('WhatsApp disponível',           '#25D366'));
        if (lead.publicPhone)         pills.push(actionPill('Telefone público',              '#25D366'));
        if (lead.email || lead.publicEmail) pills.push(actionPill('Email disponível',        '#0088cc'));
        if (lead.city)                pills.push(actionPill(`📍 ${lead.city}`,              '#7b9eff'));
        if (lead.isBusinessAccount)   pills.push(actionPill('Conta Business',               '#00C853'));
        if (lead.category)            pills.push(actionPill(lead.category,                  '#00C853'));
        if (lead.mediaCount > 10)     pills.push(actionPill('Conta ativa',                  '#888'));
        if (lead.actions?.length && !pills.length)
            lead.actions.forEach(a => pills.push(actionPill(a, '#2ECC71')));
        return pills.join('') || '<span style="color:#999;font-size:11px">Sem dados suficientes</span>';
    };

    const scoreColor = s => s >= 65 ? '#E74C3C' : s >= 35 ? '#F39C12' : '#6C757D';
    const scoreName  = s => s >= 65 ? '🔥 Quente' : s >= 35 ? '🌡️ Morno' : '❄️ Frio';

    const leadCards = sorted.map((lead, i) => {
        const score = lead.score ?? 0;
        const sc    = scoreColor(score);
        const igUrl = `https://instagram.com/${lead.username}`;
        const waUrl = lead.whatsapp ? `https://wa.me/${lead.whatsapp.replace(/\D/g,'')}` : null;
        return `
        <div style="page-break-inside:avoid;border:1px solid #e8e8e8;border-radius:12px;padding:16px;margin-bottom:12px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,0.06)">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
                <div>
                    <div style="display:flex;align-items:center;gap:8px">
                        <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#00C853,#00962E);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:14px;flex-shrink:0">
                            ${(lead.fullName || lead.username).charAt(0).toUpperCase()}
                        </div>
                        <div>
                            <a href="${igUrl}" target="_blank" style="color:#00C853;font-weight:700;font-size:14px;text-decoration:none">@${lead.username}</a>
                            ${lead.fullName ? `<div style="color:#666;font-size:12px">${lead.fullName}</div>` : ''}
                        </div>
                    </div>
                </div>
                <div style="text-align:right">
                    <div style="background:${sc}15;color:${sc};border:1px solid ${sc}40;border-radius:8px;padding:4px 10px;font-weight:700;font-size:13px">${scoreName(score)}</div>
                    <div style="color:#999;font-size:11px;margin-top:2px">${score} pontos</div>
                </div>
            </div>
            <div style="margin-bottom:10px">${whyPills(lead)}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
                <a href="${igUrl}" target="_blank" style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;background:#00C853;color:#fff;border-radius:6px;font-size:11px;font-weight:600;text-decoration:none">
                    📸 Ver Perfil
                </a>
                ${waUrl ? `<a href="${waUrl}" target="_blank" style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;background:#25D366;color:#fff;border-radius:6px;font-size:11px;font-weight:600;text-decoration:none">💬 WhatsApp</a>` : ''}
                ${lead.email ? `<a href="mailto:${lead.email}" target="_blank" style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;background:#0088cc;color:#fff;border-radius:6px;font-size:11px;font-weight:600;text-decoration:none">✉️ Email</a>` : ''}
            </div>
            ${lead.whatsapp ? `<div style="font-size:11px;color:#555;margin-bottom:4px">📱 ${lead.whatsapp}</div>` : ''}
            ${lead.email    ? `<div style="font-size:11px;color:#555;margin-bottom:4px">✉️ ${lead.email}</div>` : ''}
            ${lead.bio      ? `<div style="font-size:11px;color:#888;font-style:italic;border-top:1px solid #f0f0f0;padding-top:8px;margin-top:4px">"${lead.bio.slice(0,120)}${lead.bio.length>120?'...':''}"</div>` : ''}
        </div>`;
    }).join('');

    const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;padding:0;margin:0">

        <!-- Capa -->
        <div style="background:linear-gradient(135deg,#071210,#0D3B1E,#00C853);padding:60px 40px 50px;color:#fff;position:relative;overflow:hidden">
            <div style="position:absolute;top:-40px;right:-40px;width:220px;height:220px;border-radius:50%;background:rgba(255,255,255,0.04)"></div>
            <div style="position:absolute;bottom:-60px;left:-30px;width:180px;height:180px;border-radius:50%;background:rgba(255,255,255,0.03)"></div>
            <div style="font-size:11px;font-weight:700;letter-spacing:3px;opacity:.6;text-transform:uppercase;margin-bottom:20px">Inteligência Comercial · Instagram</div>
            <div style="font-size:36px;font-weight:900;letter-spacing:-1.5px;line-height:1.1;margin-bottom:14px">Relatório de<br>Leads Qualificados</div>
            <div style="font-size:15px;opacity:.85;max-width:480px;line-height:1.7;margin-bottom:32px">
                Pessoas reais do seu nicho que já demonstraram interesse ativo em produtos ou serviços como o seu — identificadas por comportamento, não por achismo.
            </div>
            <div style="display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);border-radius:999px;padding:8px 18px;font-size:12px">
                📅 Gerado em ${date}
            </div>
        </div>

        <!-- Texto introdutório -->
        <div style="background:#fff;padding:36px 40px;border-bottom:3px solid #f0f0f0">
            <div style="max-width:680px">
                <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#00C853;text-transform:uppercase;margin-bottom:10px">Como esses leads foram encontrados</div>
                <div style="font-size:20px;font-weight:800;color:#1A1A2E;line-height:1.3;margin-bottom:16px">
                    ${isHashtag
                        ? `${total} profissionais e interessados do seu nicho, encontrados por comportamento no Instagram.`
                        : `${total} pessoas com alto potencial de se tornarem seus clientes.`}
                </div>

                <!-- Método de captura -->
                <div style="background:#1A1A2E08;border:1px solid #1A1A2E15;border-radius:10px;padding:14px 18px;font-size:12px;color:#333;margin-bottom:16px;line-height:1.7">
                    <strong style="color:#1A1A2E">🔍 Método utilizado:</strong> ${captureMethod}
                </div>

                <div style="font-size:13px;color:#444;line-height:1.9;margin-bottom:20px">
                    ${isHashtag ? `
                    Esses perfis foram encontrados por <strong>correspondência direta de profissão ou nicho</strong> no Instagram.
                    A busca identificou contas cujo nome, usuário ou bio contém as palavras-chave do mercado que você atende —
                    garantindo uma lista de prospects altamente relevante e já qualificada pela própria plataforma.
                    ` : `
                    Cada lead foi identificado com base em <strong>comportamento real</strong> dentro do Instagram.
                    Eles não foram escolhidos aleatoriamente — interagiram ativamente com perfis do seu nicho:
                    <strong>curtiram publicações</strong>, <strong>deixaram comentários</strong>, <strong>seguem concorrentes</strong> ou
                    realizaram múltiplas dessas ações. Isso significa que eles já demonstraram interesse pelo que você oferece,
                    mesmo antes de conhecer a sua marca.`}
                </div>

                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px">
                    ${isHashtag ? [
                        ['🔍','Busca por profissão','Perfis identificados pela profissão ou nicho declarado no Instagram.'],
                        ['🎯','Audiência qualificada','Pessoas que atuam na área — não curiosos aleatórios.'],
                        ['📲','Contato direto','WhatsApp e email extraídos automaticamente da bio de cada perfil.']
                    ].map(([icon,title,desc]) => `
                        <div style="background:#fafafa;border:1px solid #eee;border-radius:10px;padding:14px">
                            <div style="font-size:20px;margin-bottom:6px">${icon}</div>
                            <div style="font-size:12px;font-weight:700;color:#1A1A2E;margin-bottom:4px">${title}</div>
                            <div style="font-size:11px;color:#777;line-height:1.5">${desc}</div>
                        </div>`).join('') : [
                        ['💬','Comentaram posts','Demonstraram engajamento ativo — o sinal mais forte de interesse real.'],
                        ['❤️','Curtiram publicações','Interagiram com conteúdo do seu nicho recentemente.'],
                        ['👁️','Seguem o concorrente','Acompanham perfis similares ao seu, buscando soluções.']
                    ].map(([icon,title,desc]) => `
                        <div style="background:#fafafa;border:1px solid #eee;border-radius:10px;padding:14px">
                            <div style="font-size:20px;margin-bottom:6px">${icon}</div>
                            <div style="font-size:12px;font-weight:700;color:#1A1A2E;margin-bottom:4px">${title}</div>
                            <div style="font-size:11px;color:#777;line-height:1.5">${desc}</div>
                        </div>`).join('')}
                </div>
                <div style="background:linear-gradient(135deg,#00C85310,#00962E10);border:1px solid #00C85330;border-radius:10px;padding:14px 18px;font-size:12px;color:#333;line-height:1.7">
                    ${isHashtag
                        ? `<strong style="color:#00C853">⚡ Dica de abordagem:</strong> Esses leads atuam no mercado que você atende. A abordagem ideal é direta e personalizada, mostrando como sua solução resolve um problema que eles vivenciam no dia a dia.`
                        : `<strong style="color:#00C853">⚡ Diferencial:</strong> Os leads estão ordenados do mais quente ao mais frio, com pontuação e justificativa individual. Quanto mais recente a interação, maior o score. Priorize os 🔥 <strong>Quentes</strong> e aborde os 🌡️ <strong>Mornos</strong> com conteúdo personalizado.`}
                </div>
            </div>
        </div>

        <!-- Métricas -->
        <div style="background:#fff;padding:28px 40px;border-bottom:1px solid #e8e8e8">
            <div style="font-size:14px;font-weight:700;color:#1A1A2E;margin-bottom:16px">📊 Visão Geral dos Leads</div>
            <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px">
                ${[
                    ['Total de Leads',  total,    '#00962E', '👥'],
                    ['🔥 Quentes',      hot,      '#E74C3C', ''],
                    ['🌡️ Mornos',       warm,     '#F39C12', ''],
                    ['Com WhatsApp',    withWA,   '#25D366', '📱'],
                    ['Com Email',       withMail, '#0088cc', '✉️']
                ].map(([label, val, color, icon]) => `
                    <div style="background:${color}08;border:1px solid ${color}25;border-radius:12px;padding:16px 12px;text-align:center">
                        <div style="font-size:28px;font-weight:900;color:${color};line-height:1">${val}</div>
                        <div style="font-size:10px;color:#777;margin-top:5px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">${label}</div>
                    </div>`).join('')}
            </div>
        </div>

        <!-- Classificação -->
        <div style="background:#fafafa;padding:22px 40px;border-bottom:1px solid #e8e8e8">
            <div style="font-size:12px;font-weight:700;color:#1A1A2E;margin-bottom:12px">🎯 Como interpretar o score</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
                ${[
                    ['🔥 Quente','65+ pontos','#E74C3C','Interações recentes e múltiplas. Aborde agora — esse lead está procurando uma solução.'],
                    ['🌡️ Morno','35–64 pontos','#F39C12','Interesse identificado. Uma abordagem bem feita pode converter.'],
                    ['❄️ Frio','0–34 pontos','#6C757D','Interação fraca ou antiga. Indicado para nutrição de conteúdo.']
                ].map(([name,pts,color,desc]) => `
                    <div style="background:#fff;border-left:3px solid ${color};border-radius:0 8px 8px 0;padding:12px 14px">
                        <div style="font-size:13px;font-weight:800;color:${color}">${name} <span style="font-size:10px;opacity:.8">${pts}</span></div>
                        <div style="font-size:11px;color:#666;margin-top:4px;line-height:1.5">${desc}</div>
                    </div>`).join('')}
            </div>
        </div>

        <!-- Leads -->
        <div style="padding:20px 40px 40px">
            <div style="font-size:15px;font-weight:800;color:#1A1A2E;margin-bottom:16px;padding-bottom:10px;border-bottom:2px solid #eee">
                👥 Leads Qualificados <span style="font-size:12px;color:#999;font-weight:400">(${total} no total · Quentes, Mornos e Frios)</span>
            </div>
            ${leadCards}
        </div>

        <!-- Rodapé -->
        <div style="text-align:center;padding:20px;color:#999;font-size:10px;border-top:1px solid #eee;margin-top:10px">
            Gerado por UltraProspec • ${date} • Dados extraídos de perfis públicos do Instagram
        </div>
    </div>`;

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    showToast('Gerando PDF... aguarde', 'info');

    html2pdf().set({
        margin: 0,
        filename: `ultraprospec_leads_${getTs()}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 1.5, useCORS: true, logging: false },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        enableLinks: true,
        pagebreak: { mode: ['avoid-all', 'css'] }
    }).from(container).save().then(() => {
        document.body.removeChild(container);
        showToast(`PDF gerado com ${total} leads!`, 'success');
    }).catch(err => {
        document.body.removeChild(container);
        showToast('Erro ao gerar PDF', 'error');
    });
}

// ============================================
// Export CSV
// ============================================
function exportToCSV() {
    if (!state.leads.length) { showToast('Nenhum lead para exportar', 'warning'); return; }
    const headers = ['Usuário','Nome','Score','Temperatura','WhatsApp','Email','Bio','Fonte','Privado','Capturado em'];
    const rows = state.leads.map(l => {
        const s = l.score ?? calculateScore(l);
        const { label } = scoreLabel(s);
        return [
            `@${l.username}`, l.fullName || '', s, label,
            l.whatsapp || '', l.email || '', l.bio || '',
            l.source || '', l.isPrivate ? 'Sim' : 'Não',
            new Date(l.capturedAt).toLocaleString('pt-BR')
        ];
    });
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `ultraprospec_${getTs()}.csv`, style: 'display:none' });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    showToast(`${state.leads.length} leads exportados!`, 'success');
}

function getTs() {
    const n = new Date();
    return `${n.getFullYear()}${(n.getMonth()+1).toString().padStart(2,'0')}${n.getDate().toString().padStart(2,'0')}_${n.getHours().toString().padStart(2,'0')}${n.getMinutes().toString().padStart(2,'0')}`;
}

// ============================================
// Import
// ============================================
function openImportModal()  { document.getElementById('importModal').classList.add('active'); }
function closeImportModal() {
    document.getElementById('importModal').classList.remove('active');
    document.getElementById('importArea').style.display    = 'block';
    document.getElementById('importPreview').style.display = 'none';
    document.getElementById('fileInput').value = '';
    document.getElementById('btnConfirmImport').disabled = true;
}

function processFile(file) {
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    if (!['.csv','.xlsx','.xls'].includes(ext)) { showToast('Use CSV ou Excel', 'error'); return; }
    const reader = new FileReader();
    reader.onload = e => { if (ext === '.csv') parseCSV(e.target.result); else showToast('Excel importado (CSV recomendado)', 'info'); };
    reader.readAsText(file);
}

function parseCSV(content) {
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) { showToast('Arquivo vazio', 'error'); return; }
    const header = lines[0].split(',').map(h => h.trim().replace(/"/g,''));
    const uIdx = header.findIndex(h => /usuário|username|user/i.test(h));
    const nIdx = header.findIndex(h => /nome|name/i.test(h));
    const wIdx = header.findIndex(h => /whatsapp|phone/i.test(h));
    const eIdx = header.findIndex(h => /email|mail/i.test(h));
    const bIdx = header.findIndex(h => /bio/i.test(h));

    const imported = [];
    for (let i = 1; i < lines.length; i++) {
        const vals = parseCSVLine(lines[i]);
        if (!vals.length) continue;
        const lead = {
            id:         `import_${Date.now()}_${i}`,
            username:   uIdx >= 0 ? cleanVal(vals[uIdx]).replace('@','') : `user_${i}`,
            fullName:   nIdx >= 0 ? cleanVal(vals[nIdx]) : '',
            whatsapp:   wIdx >= 0 ? cleanVal(vals[wIdx]) || null : null,
            email:      eIdx >= 0 ? cleanVal(vals[eIdx]) || null : null,
            bio:        bIdx >= 0 ? cleanVal(vals[bIdx]) : '',
            photoUrl:   '', isPrivate: false, source: 'importado',
            capturedAt: new Date().toISOString()
        };
        lead.score = calculateScore(lead);
        if (!state.leads.some(l => l.username === lead.username)) { imported.push(lead); state.leads.push(lead); }
    }
    imported.forEach(l => renderRow(l));
    updateCounts();
    document.getElementById('btnExportar').disabled    = false;
    document.getElementById('btnExportarPDF').disabled = false;
    showImportPreview(imported, header);
    showToast(`${imported.length} leads importados!`, 'success');
}

function parseCSVLine(line) {
    const vals = []; let cur = '', inQ = false;
    for (const ch of line) {
        if (ch === '"') inQ = !inQ;
        else if (ch === ',' && !inQ) { vals.push(cur); cur = ''; }
        else cur += ch;
    }
    vals.push(cur); return vals;
}
function cleanVal(v) { return v ? v.trim().replace(/^"|"$/g,'') : ''; }

function showImportPreview(leads, headers) {
    document.getElementById('importArea').style.display = 'none';
    document.getElementById('importPreview').style.display = 'block';
    document.getElementById('btnConfirmImport').disabled = false;
    document.querySelector('#previewTable thead').innerHTML = '<tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr>';
    document.querySelector('#previewTable tbody').innerHTML = leads.slice(0,5).map(l => `<tr><td>@${l.username}</td><td>${l.fullName||'-'}</td><td>${l.whatsapp||'-'}</td><td>${l.email||'-'}</td></tr>`).join('');
    document.getElementById('importSummary').textContent = `Total: ${leads.length} leads`;
}

// ============================================
// Toast
// ============================================
function showToast(message, type = 'info', duration = 4000) {
    const icons = { success:'fa-check-circle', error:'fa-exclamation-circle', warning:'fa-exclamation-triangle', info:'fa-info-circle' };
    const toast = Object.assign(document.createElement('div'), { className: `toast ${type}`, innerHTML: `<i class="fas ${icons[type]}"></i><span>${message}</span>` });
    document.getElementById('toastContainer').appendChild(toast);
    setTimeout(() => { toast.style.animation = 'slideIn .3s ease reverse'; setTimeout(() => toast.remove(), 300); }, duration);
}

// ============================================
// Event Listeners
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    // 1. Inicializa créditos do localStorage
    updateCreditsUI();

    // 2. Carrega lista de CNAEs em background
    loadCnaeList();

    // 3. Fecha dropdown CNAE ao clicar fora
    document.addEventListener('click', e => {
        if (!e.target.closest('#cnaeSearch') && !e.target.closest('#cnaeDropdown')) {
            const dd = document.getElementById('cnaeDropdown');
            if (dd) dd.style.display = 'none';
        }
    });

    // 4. Verifica status do Instagram
    checkLoginStatus();

    // 3. Fechar modal ao clicar fora
    document.getElementById('buyModal')?.addEventListener('click', e => {
        if (e.target === e.currentTarget) closeBuyModal();
    });

    document.getElementById('btnIniciarCaptura').addEventListener('click', startCapture);
    document.getElementById('btnPararCaptura').addEventListener('click', stopCapture);
    document.getElementById('btnExportar').addEventListener('click', exportToCSV);
    document.getElementById('btnExportarPDF').addEventListener('click', exportToPDF);
    document.getElementById('btnImportar').addEventListener('click', openImportModal);
    document.getElementById('closeImportModal').addEventListener('click', closeImportModal);
    document.getElementById('btnCancelImport').addEventListener('click', closeImportModal);
    document.getElementById('btnConfirmImport').addEventListener('click', closeImportModal);
    document.getElementById('importModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeImportModal(); });

    const importArea = document.getElementById('importArea');
    const fileInput  = document.getElementById('fileInput');
    importArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => { if (e.target.files[0]) processFile(e.target.files[0]); });
    importArea.addEventListener('dragover',  e => { e.preventDefault(); importArea.classList.add('dragover'); });
    importArea.addEventListener('dragleave', e => { e.preventDefault(); importArea.classList.remove('dragover'); });
    importArea.addEventListener('drop',      e => { e.preventDefault(); importArea.classList.remove('dragover'); if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]); });

    document.getElementById('closeLoginModal').addEventListener('click', closeLoginModal);
    document.getElementById('btnCancelLogin').addEventListener('click', closeLoginModal);
    document.getElementById('btnConfirmLogin').addEventListener('click', login);
    document.getElementById('loginModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeLoginModal(); });
    document.getElementById('igPassword')?.addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
    document.getElementById('igCode')?.addEventListener('keydown',    e => { if (e.key === 'Enter') login(); });
    document.querySelectorAll('.login-tab').forEach(btn => btn.addEventListener('click', () => switchLoginTab(btn.dataset.tab)));

    document.getElementById('btnSelecionarTodos').addEventListener('click', selectAll);
    document.getElementById('btnLimparSelecao').addEventListener('click', clearSelection);
    document.getElementById('btnExcluirSelecionados').addEventListener('click', deleteSelected);
    document.getElementById('checkAll').addEventListener('change', e => e.target.checked ? selectAll() : clearSelection());
    document.getElementById('resultsBody').addEventListener('change', e => {
        if (e.target.classList.contains('row-checkbox')) {
            const id = e.target.dataset.id;
            e.target.checked ? state.selectedIds.add(id) : state.selectedIds.delete(id);
        }
    });

    // Filters
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.activeFilter = btn.dataset.filter;
            renderAllLeads();
        });
    });
    document.getElementById('filterWhatsApp').addEventListener('change', e => { state.filterWhatsApp = e.target.checked; renderAllLeads(); });
    document.getElementById('filterEmail').addEventListener('change',    e => { state.filterEmail    = e.target.checked; renderAllLeads(); });
    document.getElementById('filterPublic').addEventListener('change',   e => { state.filterPublic   = e.target.checked; renderAllLeads(); });
    document.getElementById('filterSearch').addEventListener('input',    e => { state.filterSearch   = e.target.value;   renderAllLeads(); });

    // Segmentação
    document.getElementById('segmentType').addEventListener('change',     e => { state.segmentType     = e.target.value;   renderAllLeads(); });
    document.getElementById('segmentCity').addEventListener('input',      e => { state.segmentCity     = e.target.value;   renderAllLeads(); });
    document.getElementById('segmentActive').addEventListener('change',   e => { state.segmentActive   = e.target.checked; renderAllLeads(); });
    document.getElementById('segmentReachable').addEventListener('change',e => { state.segmentReachable= e.target.checked; renderAllLeads(); });

    document.getElementById('quantity').addEventListener('input', e => { if (e.target.value > 2000) e.target.value = 2000; if (e.target.value < 1) e.target.value = 1; });
});

window.deleteLead = deleteLead;
