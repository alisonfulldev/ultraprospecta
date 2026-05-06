// UltraProspec - App JS

// ============================================
// Créditos — separados por fonte (localStorage)
// ============================================
const CREDITS_KEY_IG     = 'up_credits_ig';
const CREDITS_KEY_GOOGLE = 'up_credits_google';

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

function getCreditsIG()     { return parseInt(localStorage.getItem(CREDITS_KEY_IG)     || '0'); }
function getCreditsGoogle() { return parseInt(localStorage.getItem(CREDITS_KEY_GOOGLE) || '0'); }
function getActiveCredits() { return state.activeSource === 'google' ? getCreditsGoogle() : getCreditsIG(); }

const FREE_TRIAL_LEADS = 4;
function isFreeTrial()  { return getActiveCredits() <= 0; }

function showFreeTrialBanner() {
    const el = document.getElementById('freeTrialBanner');
    if (el) el.style.display = 'block';
}
function hideFreeTrialBanner() {
    const el = document.getElementById('freeTrialBanner');
    if (el) el.style.display = 'none';
}

// Adiciona os leads do trial diretamente na tabela (sem preview, sem crédito, sem PDF)
function commitFreeTrialLeads() {
    const toAdd = state.pendingLeads.slice(0, FREE_TRIAL_LEADS);
    toAdd.forEach(lead => {
        addLeadToHistory(lead);
        state.leads.push(lead);
    });
    state.pendingLeads      = [];
    state.duplicatesSkipped = 0;
    renderAllLeads();
    updateCounts();
    updateHistoryInfo();
    finishCapture(`${toAdd.length} leads gratuitos capturados — compre créditos para ver os 50 melhores`, 'success', true);
    showFreeTrialBanner();
}

function setCreditsIG(n)     { localStorage.setItem(CREDITS_KEY_IG,     String(Math.max(0, n))); updateCreditsUI(); }
function setCreditsGoogle(n) { localStorage.setItem(CREDITS_KEY_GOOGLE, String(Math.max(0, n))); updateCreditsUI(); }
function deductCredit()    {
    if (state.activeSource === 'google') setCreditsGoogle(getCreditsGoogle() - 1);
    else setCreditsIG(getCreditsIG() - 1);
}
function addCredits(n, type) {
    const t = type || state.activeSource || 'instagram';
    if (t === 'google') {
        setCreditsGoogle(getCreditsGoogle() + n);
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
    hideFreeTrialBanner();
    // Após compra: re-executa o step de créditos do wizard para auto-avançar
    setTimeout(() => {
        if (mwState.currentStep === 'ig_credits'     && t !== 'google') mwSetupCreditsStep('ig');
        if (mwState.currentStep === 'google_credits' && t === 'google') mwSetupCreditsStep('google');
    }, 350);
}

function updateCreditsUI() {
    const ig     = getCreditsIG();
    const google = getCreditsGoogle();

    const elIG     = document.getElementById('creditsCountIG');
    const elGoogle = document.getElementById('creditsCountGoogle');
    const dispIG     = document.getElementById('creditsDisplayIG');
    const dispGoogle = document.getElementById('creditsDisplayGoogle');
    const buyBtn     = document.getElementById('btnBuyCredits');

    if (elIG)     elIG.textContent     = ig;
    if (elGoogle) elGoogle.textContent = google;

    if (dispIG) {
        dispIG.style.display = 'flex';
        dispIG.classList.toggle('credits-low',   ig > 0 && ig <= 10);
        dispIG.classList.toggle('credits-empty', ig <= 0);
    }
    if (dispGoogle) {
        dispGoogle.style.display = google > 0 ? 'flex' : 'none';
        dispGoogle.classList.toggle('credits-low', google > 0 && google <= 10);
    }
    if (buyBtn) {
        buyBtn.style.display = 'inline-flex';
        buyBtn.disabled = false;
        buyBtn.style.opacity = '';
        buyBtn.title = '';
    }
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
    activeSource: 'instagram', // 'instagram' | 'google'
    selectedPackType: 'instagram',
    pendingLeads: [],
    duplicatesSkipped: 0,
    flowMode: 'auto',          // 'auto' | 'advanced'
    segmentProfile: null,      // resultado de analyzeSegment()
    autoSegment: '',           // texto do segmento no modo auto
    autoCollecting: false      // true durante coleta no modo auto (ignora corte por crédito)
};

// ============================================
// Lead History — Deduplicação cross-session
// ============================================
const LEAD_HISTORY_KEY    = 'up_lead_history';
const COMPETITOR_HIST_KEY = 'up_competitor_hist';
const MAX_LEAD_HISTORY    = 5000;

function getLeadHistory() {
    try { return JSON.parse(localStorage.getItem(LEAD_HISTORY_KEY) || '[]'); } catch { return []; }
}
function isLeadInHistory(id) {
    const sid = String(id);
    return getLeadHistory().some(item => item.id === sid);
}
function addLeadToHistory(lead) {
    const h = getLeadHistory();
    const sid = String(lead.id);
    if (h.some(item => item.id === sid)) return;
    h.push({ id: sid, ts: Date.now() });
    if (h.length > MAX_LEAD_HISTORY) h.splice(0, h.length - MAX_LEAD_HISTORY);
    localStorage.setItem(LEAD_HISTORY_KEY, JSON.stringify(h));
}
function getLeadHistoryCount() { return getLeadHistory().length; }
function clearLeadHistory() {
    localStorage.removeItem(LEAD_HISTORY_KEY);
    showToast('Histórico limpo — próximas capturas podem trazer leads já vistos.', 'info', 5000);
    updateHistoryInfo();
}

function getCompetitorHist() {
    try { return JSON.parse(localStorage.getItem(COMPETITOR_HIST_KEY) || '{}'); } catch { return {}; }
}
function normalizeTarget(t) {
    return (t || '').toLowerCase()
        .replace(/^@/, '')
        .replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, '')
        .replace(/\/.*$/, '')
        .trim();
}
function recordCompetitorUse(target) {
    const h   = getCompetitorHist();
    const key = normalizeTarget(target);
    if (!key) return;
    if (!h[key]) h[key] = { count: 0, last: 0 };
    h[key].count++;
    h[key].last = Date.now();
    localStorage.setItem(COMPETITOR_HIST_KEY, JSON.stringify(h));
}
function checkCompetitorRepeat(target) {
    const h   = getCompetitorHist();
    const key = normalizeTarget(target);
    return (h[key]?.count >= 1) ? h[key] : null;
}

function updateHistoryInfo() {
    const el = document.getElementById('historyInfo');
    if (!el) return;
    const count = getLeadHistoryCount();
    el.style.display = count > 0 ? 'flex' : 'none';
    const span = document.getElementById('historyCount');
    if (span) span.textContent = count;
}

function maskUsername(username) {
    const clean = (username || '').replace(/^@/, '');
    if (!clean) return '***';
    const show = Math.max(2, Math.min(3, Math.floor(clean.length * 0.35)));
    return '@' + clean.slice(0, show) + '***';
}

function updateDupBadge() {
    const el = document.getElementById('dupBadge');
    if (!el) return;
    const n = state.duplicatesSkipped;
    if (n > 0) {
        el.style.display = 'inline-flex';
        el.textContent = `${n} duplicado${n > 1 ? 's' : ''} ignorado${n > 1 ? 's' : ''}`;
    } else {
        el.style.display = 'none';
    }
}

// ============================================
// Source Toggle (Instagram / Google Maps)
// ============================================
function setSource(source) {
    state.activeSource = source;

    document.getElementById('btnSourceIG').classList.toggle('active',     source === 'instagram');
    document.getElementById('btnSourceGoogle').classList.toggle('active', source === 'google');

    // Modo avançado: mostra sidebars originais
    const isAdv = state.flowMode === 'advanced';
    document.getElementById('sidebarIG').style.display          = (source === 'instagram' && isAdv) ? '' : 'none';
    document.getElementById('sidebarGoogle').style.display      = (source === 'google'    && isAdv) ? '' : 'none';
    // Modo auto: mostra sidebars automáticos
    document.getElementById('sidebarAutoIG').style.display      = (source === 'instagram' && !isAdv) ? '' : 'none';
    document.getElementById('sidebarAutoGoogle').style.display  = (source === 'google'    && !isAdv) ? '' : 'none';

    // Troca cabeçalho da tabela
    document.getElementById('theadIG').style.display     = source === 'instagram' ? '' : 'none';
    document.getElementById('theadGoogle').style.display = source === 'google'    ? '' : 'none';

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
    state.selectedPackType = source === 'google' ? 'google' : 'instagram';
}

// ============================================
// Flow Mode (Auto / Avançado)
// ============================================
function setFlowMode(mode) {
    state.flowMode = mode;
    const isAuto = mode === 'auto';

    document.getElementById('btnFlowAuto').classList.toggle('active',     isAuto);
    document.getElementById('btnFlowAdvanced').classList.toggle('active', !isAuto);

    const src = state.activeSource;
    document.getElementById('sidebarIG').style.display          = (src === 'instagram' && !isAuto) ? '' : 'none';
    document.getElementById('sidebarGoogle').style.display      = (src === 'google'    && !isAuto) ? '' : 'none';
    document.getElementById('sidebarAutoIG').style.display      = (src === 'instagram' &&  isAuto) ? '' : 'none';
    document.getElementById('sidebarAutoGoogle').style.display  = (src === 'google'    &&  isAuto) ? '' : 'none';
}

// ============================================
// Segment Scoring Engine
// ============================================
// ============================================
// Follower Snapshot UI helpers
// ============================================
let _rfSnapTimer = null;
function checkFollowerSnapshot(rawTarget) {
    clearTimeout(_rfSnapTimer);
    const infoEl   = document.getElementById('rfSnapshotInfo');
    const noEl     = document.getElementById('rfNoSnapshot');
    const textEl   = document.getElementById('rfSnapshotText');
    if (!rawTarget?.trim()) {
        if (infoEl) infoEl.style.display = 'none';
        if (noEl)   noEl.style.display   = 'none';
        return;
    }
    _rfSnapTimer = setTimeout(async () => {
        const username = rawTarget.trim().replace(/^@/, '').replace(/.*instagram\.com\//i,'').replace(/\/.*/,'');
        try {
            const r = await fetch(`/api/ig/follower-snapshot?username=${encodeURIComponent(username)}`);
            const d = await r.json();
            if (d.exists) {
                const age = d.ageMin < 60
                    ? `${d.ageMin} min atrás`
                    : `${Math.round(d.ageMin / 60)}h atrás`;
                if (textEl) textEl.textContent = `📸 Snapshot: ${d.count} seguidores (${age}) — próxima captura mostra apenas NOVOS`;
                if (infoEl) infoEl.style.display = 'block';
                if (noEl)   noEl.style.display   = 'none';
            } else {
                if (infoEl) infoEl.style.display = 'none';
                if (noEl)   noEl.style.display   = 'block';
            }
        } catch {}
    }, 600);
}

async function resetFollowerSnapshot() {
    const rawTarget = document.getElementById('rfTargetInput')?.value?.trim() || '';
    if (!rawTarget) return;
    const username = rawTarget.replace(/^@/, '').replace(/.*instagram\.com\//i,'').replace(/\/.*/,'');
    await fetch(`/api/ig/follower-snapshot?username=${encodeURIComponent(username)}`, { method: 'DELETE' });
    checkFollowerSnapshot(rawTarget);
    showToast('Snapshot resetado — próxima captura cria nova base', 'info');
}

function friendlyIGError(msg) {
    if (!msg) return 'Erro desconhecido na captura.';
    if (msg.includes('Snapshot criado'))
        return msg; // mensagem informativa — não é erro real
    if (msg.includes('Nenhum seguidor novo'))
        return msg;
    if (msg.includes('não encontrado ou é privado'))
        return `${msg}\n\n💡 Verifique se: o perfil existe e é público, ou se sua sessão do Instagram ainda está válida (reconecte se necessário).`;
    if (msg.includes('Session ID inválido') || msg.includes('expirad') || msg.includes('401') || msg.includes('302'))
        return 'Sessão do Instagram expirada. Clique em "Conectar IG" e reconecte sua conta.';
    if (msg.includes('rate') || msg.includes('Please wait') || msg.includes('limit'))
        return 'Instagram limitou as requisições. Aguarde alguns minutos e tente novamente.';
    if (msg.includes('checkpoint') || msg.includes('challenge'))
        return 'Instagram solicitou verificação de segurança. Acesse instagram.com, resolva e reconecte.';
    return msg;
}

function analyzeSegment(segment) {
    if (!segment) return {};
    const s = segment.toLowerCase();
    return {
        needsWebsite:    ['site', 'web', 'loja virtual', 'e-commerce', 'ecommerce', 'landing', 'wordpress',
                          'desenvolvimento', 'criar site', 'criação de site'].some(k => s.includes(k)),
        needsMarketing:  ['tráfego', 'trafego', 'ads', 'anúncio', 'anuncio', 'facebook ads', 'google ads',
                          'meta ads', 'marketing digital', 'gestão de tráfego', 'gestor de trafego'].some(k => s.includes(k)),
        needsSEO:        ['seo', 'otimização', 'posicionamento', 'ranqueamento', 'orgânico',
                          'busca orgânica'].some(k => s.includes(k)),
        needsSocial:     ['redes sociais', 'social media', 'gestão de redes', 'conteúdo', 'feed',
                          'gerenciamento de instagram', 'smm'].some(k => s.includes(k)),
        needsDesign:     ['design', 'identidade visual', 'logo', 'branding', 'marca',
                          'criação de identidade'].some(k => s.includes(k)),
        needsAccounting: ['contabilidade', 'contábil', 'contador', 'fiscal', 'tributário',
                          'imposto', 'declaração'].some(k => s.includes(k)),
        needsLegal:      ['jurídico', 'advocacia', 'direito', 'legal', 'contrato', 'advogado'].some(k => s.includes(k)),
        rawSegment: segment
    };
}

function calculateSegmentBonus(lead, segmentProfile) {
    if (!segmentProfile || !segmentProfile.rawSegment) return { bonus: 0, reasons: [] };

    const isGmaps = state.activeSource === 'google';
    const bio     = (lead.bio || '').toLowerCase();
    let bonus = 0;
    const reasons = [];

    if (segmentProfile.needsWebsite) {
        if (isGmaps) {
            if (!lead.website) { bonus += 35; reasons.push('Sem site — potencial ideal'); }
            else                bonus -= 15;
        } else {
            if (lead.isBusinessAccount && !lead.website) { bonus += 30; reasons.push('Negócio sem presença web'); }
            else if (!lead.website)                       { bonus += 15; reasons.push('Sem site detectado'); }
            if (lead.followerCount >= 300 && lead.followerCount <= 80000)
                { bonus += 10; reasons.push('Porte ideal para prospecção'); }
        }
    }

    if (segmentProfile.needsMarketing) {
        if (lead.isBusinessAccount)              { bonus += 20; reasons.push('Conta empresarial'); }
        if (!isGmaps && lead.mediaCount > 20)    { bonus += 10; reasons.push('Publica ativamente'); }
        if (isGmaps && lead.website)             { bonus += 15; reasons.push('Tem produto para anunciar'); }
        if (isGmaps && lead.rating && lead.reviewCount > 5) { bonus += 10; reasons.push('Negócio ativo'); }
        if (!isGmaps && !lead.isBusinessAccount &&
            !bio.match(/loja|produto|serviço|venda|empresa|negócio|marca/))
            bonus -= 10;
    }

    if (segmentProfile.needsSEO) {
        if (isGmaps && lead.website)                          { bonus += 25; reasons.push('Tem site — candidato a SEO'); }
        if (isGmaps && lead.rating != null && lead.reviewCount < 20)
                                                               { bonus += 15; reasons.push('Poucas avaliações — SEO local'); }
        if (!isGmaps && lead.isBusinessAccount)               { bonus += 15; reasons.push('Empresa com presença digital'); }
    }

    if (segmentProfile.needsSocial) {
        if (!isGmaps && !lead.isPrivate)                      { bonus += 10; reasons.push('Perfil público'); }
        if (!isGmaps && lead.followerCount > 100 && lead.followerCount < 20000)
                                                               { bonus += 15; reasons.push('Porte ideal para gestão'); }
        if (lead.isBusinessAccount)                            { bonus += 15; reasons.push('Conta empresarial'); }
        if (!isGmaps && lead.mediaCount < 30 && lead.isBusinessAccount)
                                                               { bonus += 10; reasons.push('Pouco conteúdo — oportunidade'); }
    }

    if (segmentProfile.needsDesign) {
        if (lead.isBusinessAccount) { bonus += 15; reasons.push('Empresa — identidade visual'); }
        if (isGmaps)                { bonus += 10; reasons.push('Negócio local estabelecido'); }
    }

    if (segmentProfile.needsAccounting) {
        if (lead.isBusinessAccount) { bonus += 25; reasons.push('Empresa — demanda contábil'); }
        if (isGmaps)                { bonus += 20; reasons.push('Negócio físico — cliente potencial'); }
    }

    if (segmentProfile.needsLegal) {
        if (lead.isBusinessAccount) { bonus += 25; reasons.push('Empresa — demanda jurídica'); }
        if (isGmaps)                { bonus += 20; reasons.push('Negócio estabelecido'); }
    }

    return { bonus: Math.max(0, bonus), reasons: reasons.slice(0, 3) };
}

function applyAutoRanking(leads) {
    const seg = state.segmentProfile;
    leads.forEach(lead => {
        const base              = lead.score || calculateScore(lead);
        const { bonus, reasons} = calculateSegmentBonus(lead, seg);
        lead.score              = Math.min(base + bonus, 100);
        lead.segmentBonus       = bonus;
        lead.segmentReasons     = reasons;
    });
    leads.sort((a, b) => (b.score || 0) - (a.score || 0));
    leads.forEach((lead, i) => { lead.isTop10 = i < 10; lead.rank = i + 1; });
    return leads;
}

// ============================================
// AI Analysis (Ollama)
// ============================================
let aiModalCurrentLead = null;

function openAIModal(lead) {
    aiModalCurrentLead = lead;
    const seg   = state.autoSegment || state.segmentProfile?.rawSegment || '';
    const model = getAutoAIModel();

    document.getElementById('aiModalLeadName').textContent    = lead.name || lead.fullName || ('@' + lead.username) || 'Lead';
    document.getElementById('aiModalSegmentInfo').textContent = `Segmento analisado: "${seg}" · Modelo: ${model}`;
    document.getElementById('aiModalLoading').style.display   = 'block';
    document.getElementById('aiModalResult').style.display    = 'none';
    document.getElementById('aiModalError').style.display     = 'none';
    document.getElementById('aiModalModelName').textContent   = model;
    document.getElementById('aiModal').classList.add('active');

    fetch('/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead, segment: seg, model })
    })
    .then(r => r.json())
    .then(data => {
        document.getElementById('aiModalLoading').style.display = 'none';
        if (data.success) {
            document.getElementById('aiModalResult').style.display  = 'block';
            document.getElementById('aiModalContent').textContent   = data.analysis;
        } else {
            document.getElementById('aiModalError').style.display   = 'block';
            document.getElementById('aiModalError').textContent     = '⚠️ ' + (data.error || 'Erro desconhecido');
        }
    })
    .catch(() => {
        document.getElementById('aiModalLoading').style.display = 'none';
        document.getElementById('aiModalError').style.display   = 'block';
        document.getElementById('aiModalError').textContent     = '⚠️ Erro ao conectar com o servidor.';
    });
}

function closeAIModal() {
    document.getElementById('aiModal').classList.remove('active');
    aiModalCurrentLead = null;
}

function getAutoAIModel() {
    const src = state.activeSource;
    const igEl    = document.getElementById('autoAIModelIG');
    const gmapsEl = document.getElementById('autoAIModelGmaps');
    return (src === 'google' ? gmapsEl : igEl)?.value?.trim() || 'llama3';
}

function isAutoAIEnabled() {
    const src = state.activeSource;
    return src === 'google'
        ? document.getElementById('autoUseAIGmaps')?.checked
        : document.getElementById('autoUseAIIG')?.checked;
}

function toggleAIConfig(source) {
    const chk = document.getElementById(source === 'gmaps' ? 'autoUseAIGmaps' : 'autoUseAIIG');
    const cfg = document.getElementById(source === 'gmaps' ? 'autoAIConfigGmaps' : 'autoAIConfigIG');
    if (cfg) cfg.style.display = chk?.checked ? 'block' : 'none';
}

// ============================================
// Buy Modal
// ============================================


function openBuyModal() {
    const type  = state.activeSource === 'google' ? 'google' : 'instagram';
    const errEl = document.getElementById('buyError');
    const btn   = document.getElementById('btnCheckout');

    errEl.style.display = 'none';
    selectPack(type);
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }

    document.getElementById('buyModal').classList.add('active');
}

function closeBuyModal() {
    document.getElementById('buyModal').classList.remove('active');
}

function selectPack(type) {
    state.selectedPackType = type;
    const packIG     = document.getElementById('packIG');
    const packGoogle = document.getElementById('packGoogle');
    if (packIG && packGoogle) {
        packIG.style.border       = type === 'instagram' ? '2px solid var(--primary)' : '2px solid transparent';
        packIG.style.background   = type === 'instagram' ? 'rgba(0,200,83,.06)' : 'rgba(255,255,255,.04)';
        packGoogle.style.border   = type === 'google'    ? '2px solid var(--primary)' : '2px solid transparent';
        packGoogle.style.background = type === 'google'  ? 'rgba(0,200,83,.06)' : 'rgba(255,255,255,.04)';
    }
}

function simulatePayment() {
    const type = state.selectedPackType || 'instagram';
    const n = 50;
    addCredits(n, type);
    closeBuyModal();
    showToast(n + ' leads ' + (type === 'google' ? 'Google Maps' : 'Instagram') + ' adicionados (modo teste)', 'success');
}

async function goToCheckout() {
    const type = state.selectedPackType || 'instagram';
    const btn  = document.getElementById('btnCheckout');
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
    // Bônus para últimos seguidores: posição 1-10 = mais recente = maior score
    if (lead.recentFollowerOrder) {
        const bonus = Math.max(0, 20 - (lead.recentFollowerOrder - 1) * 0.5);
        s += Math.round(bonus);
    }
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
    if (lead.recentFollowerOrder) {
        const label = lead.recentFollowerOrder <= 10
            ? `⏱️ ${lead.recentFollowerOrder}º seguidor mais recente`
            : `⏱️ Seguidor recente #${lead.recentFollowerOrder}`;
        pills.push(`<span class="why-pill why-recent-follower">${label}</span>`);
    }
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
const IG_KEY = 'up_ig_session';

function saveIgSession(creds)  { localStorage.setItem(IG_KEY, JSON.stringify({ loggedIn: true, ...creds })); }
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

function lgSetState(state) {
    ['Idle','Waiting','Success','Error'].forEach(s =>
        document.getElementById(`lgState${s}`)?.style.setProperty('display', s.toLowerCase() === state ? '' : 'none')
    );
}

function openLoginModal() {
    lgSetState('idle');
    document.getElementById('loginModal').classList.add('active');
}

function closeLoginModal() {
    cancelBrowserLogin();
    document.getElementById('loginModal').classList.remove('active');
    lgSetState('idle');
}

function resetLoginModal() { lgSetState('idle'); }

let _lgPollTimer = null;

async function startBrowserLogin() {
    lgSetState('waiting');
    document.getElementById('lgWaitMsg').textContent = 'Abrindo o Chrome com o Instagram...';

    try {
        const res  = await fetch('/api/ig-auth/browser-login', { method: 'POST' });
        const data = await res.json();
        if (!data.success) {
            document.getElementById('lgErrorMsg').textContent = data.error || 'Erro ao abrir o navegador.';
            lgSetState('error');
            return;
        }
        document.getElementById('lgWaitMsg').textContent = 'Chrome aberto — faça login no Instagram';

        _lgPollTimer = setInterval(async () => {
            try {
                const r    = await fetch('/api/ig-auth/browser-status');
                const info = await r.json();

                if (info.status === 'done' && info.data) {
                    clearInterval(_lgPollTimer); _lgPollTimer = null;
                    const d = info.data;
                    try {
                        const lr = await fetch('/api/login-cookie', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                sessionid:    d.sessionid,
                                csrftoken:    d.csrftoken,
                                dsUserId:     d.dsUserId,
                                username:     d.username,
                                cookieString: d.cookieString || '',
                                userAgent:    d.userAgent   || '',
                            })
                        });
                        const ld = await lr.json();
                        const user = ld.success ? ld.user : { username: d.username };
                        saveIgSession({ username: user.username || d.username, sessionid: d.sessionid, csrftoken: d.csrftoken, dsUserId: d.dsUserId, cookieString: d.cookieString || '', userAgent: d.userAgent || '' });
                        updateLoginUI(true, user);
                        document.getElementById('lgSuccessUser').textContent = `@${user.username || d.username}`;
                        lgSetState('success');
                        showToast(`Conectado como @${user.username || d.username}!`, 'success');
                        // wizard mobile: avança step se necessário
                        mwRefreshLoginStep?.();
                        setTimeout(() => { if (mwState?.currentStep === 'ig_login') mwGoToStep?.('ig_ready'); }, 600);
                    } catch {
                        saveIgSession({ username: d.username, sessionid: d.sessionid, csrftoken: d.csrftoken, dsUserId: d.dsUserId, cookieString: d.cookieString || '', userAgent: d.userAgent || '' });
                        updateLoginUI(true, { username: d.username });
                        document.getElementById('lgSuccessUser').textContent = `@${d.username}`;
                        lgSetState('success');
                        showToast('Instagram conectado!', 'success');
                    }
                } else if (['timeout','error','cancelled'].includes(info.status)) {
                    clearInterval(_lgPollTimer); _lgPollTimer = null;
                    if (info.status === 'cancelled') { lgSetState('idle'); return; }
                    document.getElementById('lgErrorMsg').textContent = 'Login encerrado ou expirou. Tente novamente.';
                    lgSetState('error');
                }
            } catch {}
        }, 1500);

    } catch {
        document.getElementById('lgErrorMsg').textContent = 'Servidor indisponível. Verifique se o servidor está rodando.';
        lgSetState('error');
    }
}

async function cancelBrowserLogin() {
    if (_lgPollTimer) { clearInterval(_lgPollTimer); _lgPollTimer = null; }
    try { await fetch('/api/ig-auth/browser-cancel', { method: 'POST' }); } catch {}
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
    if (state.activeSource === 'google') { startCaptureGoogle(); return; }

    // Verifica login do Instagram (obrigatório sempre)
    const igSession = loadIgSession();
    if (!igSession?.loggedIn) {
        openLoginModal();
        return;
    }

    hideFreeTrialBanner();

    // Modo automático: lê dos campos auto e configura internamente
    if (state.flowMode === 'auto') {
        const autoTarget  = document.getElementById('autoIGTarget')?.value?.trim() || '';
        const autoSegment = document.getElementById('autoSegmentIG')?.value?.trim() || '';
        const autoPosts   = document.getElementById('autoIGPosts')?.value || '10';

        if (!autoTarget)  { showToast('Informe o perfil do concorrente', 'error'); return; }
        if (!autoSegment) { showToast('Informe seu segmento/serviço — é obrigatório para o ranking', 'error'); return; }

        state.autoSegment   = autoSegment;
        state.segmentProfile = analyzeSegment(autoSegment);
        state.autoCollecting = true;

        state.isCapturing       = true;
        state.startTime         = new Date();
        state.pendingLeads      = [];
        state.duplicatesSkipped = 0;
        updateCaptureUI(true);
        document.getElementById('progressContainer').style.display = 'block';
        setCaptureStatus('Coletando leads para ranking...', true);
        startTimer();
        updateDupBadge();

        const autoQty = 200;
        const params  = new URLSearchParams({
            type: 'profile_analysis', target: autoTarget,
            quantity: autoQty, fetchBio: 'true', posts: autoPosts
        });
        const es = new EventSource(`/api/capture?${params}`);
        state.eventSource = es;
        // Flag para evitar reconexão automática do EventSource processar o evento duplicado
        let autoFinished = false;

        const autoClose = () => {
            if (autoFinished) return;
            autoFinished = true;
            es.close();
            state.eventSource    = null;
            state.autoCollecting = false;
        };

        es.onmessage = e => {
            if (autoFinished) return;
            const data = JSON.parse(e.data);
            if (data.type === 'lead') {
                if (state.pendingLeads.some(l => l.id === data.lead.id)) return;
                if (state.leads.some(l => l.id === data.lead.id)) return;
                if (isLeadInHistory(data.lead.id)) data.lead.isDuplicate = true;

                data.lead.score = calculateScore(data.lead);
                state.pendingLeads.push(data.lead);
                updateProgress(state.pendingLeads.length, autoQty);
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
            } else if (data.type === 'done' || data.type === 'error') {
                autoClose();

                if (data.type === 'error') {
                    const friendlyMsg = friendlyIGError(data.message);
                    finishCapture(friendlyMsg, 'error');
                    return;
                }
                if (state.pendingLeads.length === 0) {
                    finishCapture('Nenhum lead encontrado', 'warning');
                    return;
                }
                setProgress(98, 'Aplicando ranking por segmento...');
                applyAutoRanking(state.pendingLeads);
                state.pendingLeads = state.pendingLeads.slice(0, 50);
                setProgress(100, `${state.pendingLeads.length} melhores leads selecionados`);
                openLeadPreviewModal();
            }
        };

        es.onerror = () => {
            if (autoFinished) return;
            autoClose();
            if (state.isCapturing) {
                if (state.pendingLeads.length > 0) {
                    applyAutoRanking(state.pendingLeads);
                    state.pendingLeads = state.pendingLeads.slice(0, 50);
                    openLeadPreviewModal();
                } else {
                    finishCapture('Conexão interrompida. Verifique sua conexão com o Instagram.', 'error');
                }
            }
        };
        return;
    }

    const { type, target, posts, profileTarget } = getCurrentConfig();
    const quantity  = 50;
    const fetchBio  = document.getElementById('extractWhatsApp').checked || document.getElementById('extractEmail').checked;

    if (type === 'hashtag' && !profileTarget) { showToast('Informe o perfil alvo para varrer', 'error'); return; }
    if (!target) { showToast('Informe o alvo da captura', 'error'); return; }

    // Detecta link de perfil colado em modos que exigem URL de post
    const looksLikeProfile = /instagram\.com\/[^/?#]+\/?(\?.*)?$/.test(target) && !/\/p\/|\/reel\//.test(target);
    if ((type === 'comments' || type === 'likes') && looksLikeProfile) {
        const modeLabel = type === 'comments' ? 'Comentaristas de um post' : 'Curtidores de um post';
        showToast(`O modo "${modeLabel}" exige a URL de um post (ex: instagram.com/p/CODIGO), não de um perfil. Para extrair de um perfil use "Análise Completa" ou "Curtidores Recentes".`, 'error', 10000);
        return;
    }

    state.isCapturing      = true;
    state.startTime        = new Date();
    state.pendingLeads     = [];
    state.duplicatesSkipped = 0;
    updateCaptureUI(true);
    document.getElementById('progressContainer').style.display = 'block';
    setCaptureStatus('Capturando...', true);
    startTimer();
    updateDupBadge();

    // Aviso se o perfil já foi usado antes
    const watchTarget = target || profileTarget;
    const repeat = checkCompetitorRepeat(watchTarget);
    if (repeat) {
        const fmt = new Date(repeat.last).toLocaleDateString('pt-BR');
        showToast(
            `Atenção: este perfil já foi capturado antes (última vez: ${fmt}). Leads já extraídos serão ignorados automaticamente — você não será cobrado por duplicatas.`,
            'warning', 10000
        );
    }
    recordCompetitorUse(watchTarget);

    const params = new URLSearchParams({ type, target, quantity, fetchBio: fetchBio ? 'true' : 'false', posts });
    if (profileTarget) params.set('profileTarget', profileTarget);
    const es = new EventSource(`/api/capture?${params}`);
    state.eventSource = es;
    let advDone = false;

    es.onmessage = e => {
        if (advDone) return;
        const data = JSON.parse(e.data);
        if (data.type === 'lead') {
            // Dedup: mesmo lead na sessão atual
            if (state.leads.some(l => l.id === data.lead.id)) return;
            if (state.pendingLeads.some(l => l.id === data.lead.id)) return;

            // Duplicata cross-session: marca mas não ignora — aparece sem custo de crédito
            if (isLeadInHistory(data.lead.id)) data.lead.isDuplicate = true;

            data.lead.score = calculateScore(data.lead);
            state.pendingLeads.push(data.lead);
            updateProgress(state.leads.length + state.pendingLeads.length, quantity);

            const trial    = isFreeTrial();
            const avail    = getCreditsIG();
            const newCount = state.pendingLeads.filter(l => !l.isDuplicate).length;
            const limit    = trial ? FREE_TRIAL_LEADS : avail;

            if (newCount > 0 && avail <= 0 && !trial) {
                advDone = true;
                es.close(); state.eventSource = null;
                finishCapture('Você não tem créditos. Adquira créditos para capturar leads.', 'warning');
                setTimeout(() => openBuyModal(), 600);
                return;
            }

            if (newCount >= limit) {
                advDone = true;
                es.close(); state.eventSource = null;
                if (trial) {
                    commitFreeTrialLeads();
                } else {
                    setProgress(95, `${state.pendingLeads.length} leads prontos para revisar`);
                    openLeadPreviewModal();
                }
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
            advDone = true;
            es.close(); state.eventSource = null;
            setProgress(100, `${state.pendingLeads.length} novos leads prontos`);
            if (state.pendingLeads.length === 0) {
                finishCapture(
                    state.duplicatesSkipped > 0
                        ? `Nenhum lead novo — ${state.duplicatesSkipped} duplicado${state.duplicatesSkipped > 1 ? 's' : ''} de capturas anteriores foram ignorados`
                        : 'Nenhum lead encontrado',
                    'warning'
                );
            } else if (isFreeTrial()) {
                commitFreeTrialLeads();
            } else {
                openLeadPreviewModal();
            }
        } else if (data.type === 'error') {
            advDone = true;
            es.close(); state.eventSource = null;
            const isInfo = data.message?.includes('Snapshot criado') || data.message?.includes('Nenhum seguidor novo');
            if (isInfo) { finishCapture(friendlyIGError(data.message), 'warning'); return; }
            finishCapture(friendlyIGError(data.message), 'error');
        }
    };

    es.onerror = () => {
        if (advDone) return;
        advDone = true;
        es.close();
        const wasCapturing = state.isCapturing;
        state.eventSource = null;
        if (wasCapturing) finishCapture('Conexão interrompida com o Instagram. Verifique sua sessão.', 'error');
    };
}

function stopCapture() {
    if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
    state.autoCollecting = false;
    if (state.pendingLeads.length > 0) {
        if (state.flowMode === 'auto' && state.activeSource !== 'google') {
            applyAutoRanking(state.pendingLeads);
            state.pendingLeads = state.pendingLeads.slice(0, 50);
        }
        setProgress(95, `${state.pendingLeads.length} leads prontos para revisar`);
        openLeadPreviewModal();
    } else {
        finishCapture('Captura interrompida', 'warning');
    }
}

// ============================================
// Preview Modal — Aprovação de leads
// ============================================
function openLeadPreviewModal() {
    const pending = state.pendingLeads;
    const total   = pending.length;
    const dupCnt  = state.duplicatesSkipped;
    const avail   = getCreditsIG();
    const cost    = Math.min(total, avail);

    const costEl = document.getElementById('previewCreditCost');
    if (costEl) costEl.textContent = cost;

    let meta = `<strong>${total}</strong> lead${total !== 1 ? 's' : ''} novo${total !== 1 ? 's' : ''} encontrado${total !== 1 ? 's' : ''}`;
    if (state.flowMode === 'auto' && state.autoSegment) {
        meta += ` &nbsp;&bull;&nbsp; <span style="color:var(--primary);font-size:.8rem"><i class="fas fa-magic"></i> Rankeados por: <strong>${state.autoSegment}</strong></span>`;
    }
    if (dupCnt > 0) {
        meta += ` &nbsp;&bull;&nbsp; <span class="dup-info">${dupCnt} duplicado${dupCnt > 1 ? 's' : ''} de capturas anteriores foram ignorados automaticamente</span>`;
    }

    const isRecentFollowers = pending.length > 0 && pending[0].recentFollowerOrder != null;
    const sorted = isRecentFollowers
        ? [...pending].sort((a, b) => (a.recentFollowerOrder || 0) - (b.recentFollowerOrder || 0))
        : [...pending].sort((a, b) => (b.score || 0) - (a.score || 0));
    let rows = '';
    sorted.forEach(lead => {
        const wa = lead.whatsapp ? '<i class="fab fa-whatsapp" title="Tem WhatsApp" style="color:#25D366;font-size:1rem"></i>' : '';
        const em = lead.email    ? '<i class="fas fa-envelope" title="Tem email" style="color:var(--primary);font-size:.85rem"></i>' : '';
        const contacts = (wa || em) ? wa + em : '<small style="color:var(--gray)">—</small>';
        const prevTop = lead.isTop10 ? `<span class="top10-badge" style="font-size:.55rem">🏆 TOP ${lead.rank}</span> ` : '';
        const scoreBadge = isRecentFollowers
            ? `<span style="font-size:.7rem;color:var(--gray)">#${lead.recentFollowerOrder || '—'}</span>`
            : (() => { const score = lead.score || 0; const { label: slabel, cls } = scoreLabel(score); return `<span class="score-badge ${cls}" style="font-size:.7rem;padding:.18rem .45rem">${slabel} ${score}pts</span>`; })();
        rows += `<tr${lead.isTop10 ? ' style="background:rgba(243,156,18,.08)"' : ''}>
            <td class="prev-user">${prevTop}${maskUsername(lead.username)}</td>
            <td>${scoreBadge}</td>
            <td class="prev-contacts">${contacts}</td>
        </tr>`;
    });

    const body = document.getElementById('previewModalBody');
    if (body) body.innerHTML = `
        <p class="preview-meta">${meta}</p>
        <div class="preview-table-wrap">
            <table class="preview-table">
                <thead><tr><th>Usuário (oculto)</th><th>Score</th><th>Contatos</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <p class="preview-note"><i class="fas fa-lock" style="font-size:.75rem"></i> Usernames completos aparecem somente após aprovação</p>
    `;

    document.getElementById('previewModal').classList.add('active');
}

function closeLeadPreviewModal() {
    document.getElementById('previewModal').classList.remove('active');
}

function approveLeadPreview() {
    const avail    = getCreditsIG();
    const newLeads = state.pendingLeads.filter(l => !l.isDuplicate);
    const dupLeads = state.pendingLeads.filter(l =>  l.isDuplicate);

    // Limita leads novos pelos créditos disponíveis
    const toAddNew = newLeads.slice(0, avail);
    const leftOver = newLeads.length - toAddNew.length;

    // Leads novos: desconta crédito e registra no histórico
    toAddNew.forEach(lead => {
        deductCredit();
        addLeadToHistory(lead);
        state.leads.push(lead);
    });

    // Duplicatas: aparecem na lista sem custo, sem re-registrar no histórico
    dupLeads.forEach(lead => state.leads.push(lead));

    state.pendingLeads      = [];
    state.duplicatesSkipped = 0;

    closeLeadPreviewModal();
    updateDupBadge();
    renderAllLeads();
    updateCounts();
    updateHistoryInfo();

    const total = toAddNew.length + dupLeads.length;
    let msg = `${total} lead${total !== 1 ? 's' : ''} adicionado${total !== 1 ? 's' : ''} com sucesso`;
    if (dupLeads.length > 0) msg += ` (${dupLeads.length} já capturado${dupLeads.length !== 1 ? 's' : ''}, sem custo)`;
    if (leftOver > 0) msg += ` (${leftOver} descartado${leftOver !== 1 ? 's' : ''} por falta de créditos)`;
    finishCapture(msg, 'success');
    updateCreditsUI();
    if (getCreditsIG() <= 0) setTimeout(() => openBuyModal(), 800);
}

function rejectLeadPreview() {
    const cnt = state.pendingLeads.length;
    state.pendingLeads      = [];
    state.duplicatesSkipped = 0;

    closeLeadPreviewModal();
    updateDupBadge();
    finishCapture(
        `Captura cancelada — ${cnt} lead${cnt !== 1 ? 's' : ''} descartado${cnt !== 1 ? 's' : ''} sem cobrança`,
        'warning'
    );
}

// ============================================
// Captura Google Maps
// ============================================
function startCaptureGoogle() {
    hideFreeTrialBanner();

    // Modo automático: lê campos do sidebar auto
    let kw, city, onlyPhone, onlyWhatsapp, onlyNoWebsite, minRating, maxRating;

    if (state.flowMode === 'auto') {
        kw   = document.getElementById('autoGmapsTerm')?.value?.trim() || '';
        city = document.getElementById('autoGmapsCity')?.value?.trim() || '';
        const seg = document.getElementById('autoSegmentGmaps')?.value?.trim() || '';

        if (!kw)  { showToast('Informe a palavra-chave de busca', 'error'); return; }
        if (!seg) { showToast('Informe seu segmento/serviço — é obrigatório para o ranking', 'error'); return; }

        state.autoSegment    = seg;
        state.segmentProfile = analyzeSegment(seg);
        onlyPhone = onlyWhatsapp = onlyNoWebsite = false;
        minRating = maxRating = '';
    } else {
        kw           = document.getElementById('gmapsKeyword')?.value?.trim() || '';
        city         = document.getElementById('gmapsCity')?.value?.trim()    || '';
        if (!kw) { showToast('Informe a palavra-chave de busca', 'error'); return; }
        onlyPhone     = document.getElementById('gmapsOnlyPhone')?.checked     || false;
        onlyWhatsapp  = document.getElementById('gmapsOnlyWhatsapp')?.checked  || false;
        onlyNoWebsite = document.getElementById('gmapsOnlyNoWebsite')?.checked || false;
        minRating     = document.getElementById('gmapsMinRating')?.value        || '';
        maxRating     = document.getElementById('gmapsMaxRating')?.value        || '';
    }

    const keyword  = city ? `${kw} em ${city}` : kw;
    const quantity = 50;

    state.isCapturing = true;
    state.startTime   = new Date();
    if (state.flowMode === 'auto') state.leads = [];
    updateCaptureUI(true);
    document.getElementById('progressContainer').style.display = 'block';
    setCaptureStatus(state.flowMode === 'auto' ? 'Buscando leads para ranking...' : 'Buscando no Google Maps...', true);
    startTimer();

    const params = new URLSearchParams({ keyword, quantity });
    if (onlyPhone)     params.set('onlyPhone',     'true');
    if (onlyWhatsapp)  params.set('onlyWhatsapp',  'true');
    if (onlyNoWebsite) params.set('onlyNoWebsite', 'true');
    if (minRating)     params.set('minRating', minRating);
    if (maxRating)     params.set('maxRating', maxRating);
    const es = new EventSource(`/api/gmaps/search?${params}`);
    state.eventSource = es;

    // buffer para modo auto (rank depois do done)
    const gmapsBuffer = [];

    es.onmessage = e => {
        const data = JSON.parse(e.data);
        if (data.type === 'lead') {
            const lead = data.lead;
            if (state.leads.some(l => l.id === lead.id)) return;
            if (isLeadInHistory(lead.id)) { state.duplicatesSkipped++; updateDupBadge(); return; }

            const trialGoogle = isFreeTrial();

            if (state.flowMode === 'auto') {
                gmapsBuffer.push(lead);
                updateProgress(gmapsBuffer.length, quantity);
                document.getElementById('progressText').textContent = `Coletando empresa ${gmapsBuffer.length}...`;
                if (trialGoogle && gmapsBuffer.length >= FREE_TRIAL_LEADS) {
                    es.close(); state.eventSource = null;
                    gmapsBuffer.slice(0, FREE_TRIAL_LEADS).forEach(l => { addLeadToHistory(l); state.leads.push(l); });
                    renderAllLeads(); updateCounts();
                    finishCapture(`${FREE_TRIAL_LEADS} leads gratuitos — compre créditos para ver os 50 melhores`, 'success', true);
                    showFreeTrialBanner();
                }
            } else {
                if (trialGoogle) {
                    addLeadToHistory(lead);
                    state.leads.push(lead);
                    updateProgress(state.leads.length, quantity);
                    try { renderRowGoogle(lead); } catch(err) { console.error(err); }
                    updateCounts();
                    if (state.leads.length >= FREE_TRIAL_LEADS) {
                        es.close(); state.eventSource = null;
                        finishCapture(`${FREE_TRIAL_LEADS} leads gratuitos — compre créditos para ver os 50 melhores`, 'success', true);
                        showFreeTrialBanner();
                    }
                } else {
                    const remaining = getCreditsGoogle() - 1;
                    setCreditsGoogle(remaining);
                    addLeadToHistory(lead);
                    state.leads.push(lead);
                    updateProgress(state.leads.length, quantity);
                    try { renderRowGoogle(lead); } catch(err) { console.error(err); }
                    updateCounts();
                    if (remaining <= 0) {
                        es.close(); state.eventSource = null;
                        finishCapture(`${state.leads.length} leads capturados — créditos esgotados`, 'warning');
                        setTimeout(() => openBuyModal(), 800);
                    }
                }
            }
        } else if (data.type === 'log') {
            document.getElementById('progressText').textContent = data.message;
        } else if (data.type === 'done') {
            es.close(); state.eventSource = null;
            if (state.flowMode === 'auto') {
                setProgress(95, 'Aplicando ranking por segmento...');
                applyAutoRanking(gmapsBuffer);
                const creds = getCreditsGoogle();
                const maxTake = isFreeTrial() ? FREE_TRIAL_LEADS : Math.min(50, creds);
                const top = gmapsBuffer.slice(0, maxTake);
                const toAdd = isFreeTrial() ? top : top.slice(0, creds);
                toAdd.forEach(lead => {
                    if (!isFreeTrial()) setCreditsGoogle(getCreditsGoogle() - 1);
                    addLeadToHistory(lead);
                    state.leads.push(lead);
                });
                setProgress(100, `${state.leads.length} leads selecionados`);
                renderAllLeads();
                updateCounts();
                if (isFreeTrial()) {
                    finishCapture(`${state.leads.length} leads gratuitos — compre créditos para ver os 50 melhores`, 'success', true);
                    showFreeTrialBanner();
                } else {
                    finishCapture(`${state.leads.length} leads Google Maps rankeados por segmento`, 'success');
                    updateCreditsUI();
                    if (getCreditsGoogle() <= 0) setTimeout(() => openBuyModal(), 800);
                }
            } else {
                setProgress(100, `${state.leads.length} empresas encontradas`);
                if (isFreeTrial()) {
                    finishCapture(`${state.leads.length} leads gratuitos — compre créditos para ver os 50 melhores`, 'success', true);
                    showFreeTrialBanner();
                } else {
                    finishCapture(`Concluído — ${state.leads.length} leads Google Maps encontrados`, 'success');
                    updateCreditsUI();
                }
            }
        } else if (data.type === 'error') {
            es.close(); state.eventSource = null;
            finishCapture(data.message, 'error');
        }
    };

    es.onerror = () => {
        es.close();
        const wasCapturing = state.isCapturing;
        state.eventSource = null;
        if (wasCapturing) {
            if (state.flowMode === 'auto' && gmapsBuffer.length > 0) {
                applyAutoRanking(gmapsBuffer);
                const top = gmapsBuffer.slice(0, Math.min(50, getCreditsGoogle()));
                top.forEach(lead => { setCreditsGoogle(getCreditsGoogle() - 1); addLeadToHistory(lead); state.leads.push(lead); });
                renderAllLeads(); updateCounts();
                finishCapture(`${state.leads.length} leads capturados`, 'warning');
            } else {
                finishCapture('Conexão interrompida', 'error');
            }
        }
    };
}

function renderRowGoogle(lead) {
    const tbody = document.getElementById('resultsBody');
    document.getElementById('emptyRow')?.remove();

    const row = document.createElement('tr');
    if (lead.isTop10) row.classList.add('top10-row');
    row.dataset.id          = lead.id;
    row.dataset.has_email   = '0';
    row.dataset.has_whatsapp = lead.whatsapp ? '1' : '0';

    // WhatsApp / Telefone combinados
    let contactHtml = '-';
    if (lead.whatsapp) {
        const waNum = lead.whatsapp.replace(/\D/g, '');
        contactHtml = `<a href="https://wa.me/${waNum}" target="_blank" rel="noopener" class="contact-link wa-link"><i class="fab fa-whatsapp"></i> ${formatPhone(lead.whatsapp)}</a>`;
        if (lead.phone && lead.phone !== lead.whatsapp) {
            contactHtml += `<br><small style="color:var(--gray);font-size:.72rem"><i class="fas fa-phone"></i> ${lead.phone}</small>`;
        }
    } else if (lead.phone) {
        contactHtml = `<a href="tel:${lead.phone.replace(/\D/g,'')}" class="contact-link"><i class="fas fa-phone"></i> ${lead.phone}</a>`;
    }

    let websiteHtml = '-';
    if (lead.website) {
        try {
            const host = new URL(lead.website).hostname.replace(/^www\./, '');
            websiteHtml = `<a href="${lead.website}" target="_blank" rel="noopener" class="contact-link" title="${lead.website}"><i class="fas fa-globe"></i> ${host}</a>`;
        } catch { websiteHtml = `<a href="${lead.website}" target="_blank" rel="noopener" class="contact-link"><i class="fas fa-globe"></i> site</a>`; }
    }

    const ratingHtml = lead.rating != null
        ? `⭐ ${lead.rating.toFixed(1)}${lead.reviewCount ? ` <small style="color:var(--gray)">(${lead.reviewCount.toLocaleString('pt-BR')})</small>` : ''}`
        : '-';

    const segReasonHtml = buildSegmentReasons(lead);
    const top10Html     = buildTop10Badge(lead);
    const aiHtml        = (lead.isTop10 && state.flowMode === 'auto' && isAutoAIEnabled())
        ? `<button class="action-btn ai-btn" title="Analisar com IA" onclick="openAIModal(state.leads.find(l=>l.id==='${lead.id}'))" style="margin-right:.25rem"><i class="fas fa-robot"></i></button>` : '';

    row.innerHTML = `
        <td><input type="checkbox" class="row-checkbox" data-id="${lead.id}"></td>
        <td style="max-width:160px">
            ${top10Html}
            <strong style="font-size:.85rem">${lead.name}</strong>
            ${lead.category ? `<br><small style="color:var(--gray);font-size:.72rem">${lead.category}</small>` : ''}
            ${segReasonHtml ? `<div style="margin-top:3px">${segReasonHtml}</div>` : ''}
        </td>
        <td style="font-size:.82rem">${contactHtml}</td>
        <td style="font-size:.78rem">${websiteHtml}</td>
        <td style="font-size:.82rem;white-space:nowrap">${ratingHtml}</td>
        <td style="font-size:.78rem;max-width:150px;color:rgba(255,255,255,.75)">${lead.address || '-'}</td>
        <td>${aiHtml}<button class="action-btn delete" onclick="deleteLead('${lead.id}')" title="Excluir"><i class="fas fa-trash"></i></button></td>
    `;
    tbody.appendChild(row);
}

function formatPhone(raw) {
    if (!raw) return '';
    const d = raw.replace(/\D/g, '');
    // 55 + DDD(2) + número(8-9) = 12-13 dígitos
    const num = d.startsWith('55') ? d.slice(2) : d;
    if (num.length === 11) return `(${num.slice(0,2)}) ${num.slice(2,7)}-${num.slice(7)}`;
    if (num.length === 10) return `(${num.slice(0,2)}) ${num.slice(2,6)}-${num.slice(6)}`;
    return raw;
}

function finishCapture(msg, type, noAutoExport = false) {
    state.isCapturing = false;
    stopTimer();
    updateCaptureUI(false);
    setCaptureStatus(msg, false);
    const _exp = document.getElementById('btnExportar'); if (_exp) _exp.disabled = state.leads.length === 0;
    document.getElementById('btnExportarPDF').disabled = state.leads.length === 0;
    showToast(msg, type);
    // Auto-download do PDF — não gera no free trial
    if (state.leads.length > 0 && type !== 'error' && !noAutoExport && !isFreeTrial()) {
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
// Rendering helpers
// ============================================
function buildTop10Badge(lead) {
    if (!lead.isTop10) return '';
    return `<span class="top10-badge" title="Top ${lead.rank || '?'} no ranking do segmento">🏆 TOP ${lead.rank || '?'}</span>`;
}

function buildSegmentReasons(lead) {
    if (!lead.segmentReasons?.length) return '';
    return lead.segmentReasons.map(r =>
        `<span class="why-pill why-segment">${r}</span>`
    ).join('');
}

function buildAutoActionsHtml(lead) {
    if (state.flowMode !== 'auto' || !lead.isTop10 || !isAutoAIEnabled()) return '';
    const safeId = JSON.stringify(lead.id);
    return `<button class="action-btn ai-btn" title="Analisar com IA" onclick="openAIModal(state.leads.find(l=>l.id===${safeId}))" style="margin-right:.25rem"><i class="fas fa-robot"></i></button>`;
}

// ============================================
// Rendering
// ============================================
function renderRow(lead, prepend = false) {
    if (!passesFilter(lead)) return;

    const tbody = document.getElementById('resultsBody');
    document.getElementById('emptyRow')?.remove();

    const isRecent = lead.recentFollowerOrder != null;
    const score = isRecent ? 0 : (lead.score ?? calculateScore(lead));
    const { label: slabel, cls } = isRecent ? { label: `#${lead.recentFollowerOrder}`, cls: 'score-neutral' } : scoreLabel(score);

    const photoHtml = lead.photoUrl
        ? `<img src="${lead.photoUrl}" class="user-photo" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
           <div class="user-photo-placeholder" style="display:none">${(lead.fullName || lead.username).charAt(0).toUpperCase()}</div>`
        : `<div class="user-photo-placeholder">${(lead.fullName || lead.username).charAt(0).toUpperCase()}</div>`;

    const row = document.createElement('tr');
    if (lead.isTop10) row.classList.add('top10-row');
    row.dataset.id           = lead.id;
    row.dataset.scoreVal     = isRecent ? lead.recentFollowerOrder : score;
    row.dataset.score        = cls;
    row.dataset.has_whatsapp = lead.whatsapp ? '1' : '0';
    row.dataset.has_email    = lead.email    ? '1' : '0';
    row.dataset.is_public    = lead.isPrivate ? '0' : '1';
    row.dataset.username     = (lead.username || '').toLowerCase();
    row.dataset.fullname     = (lead.fullName  || '').toLowerCase();

    const whyExtra = buildTop10Badge(lead) + buildSegmentReasons(lead);
    row.innerHTML = `
        <td><input type="checkbox" class="row-checkbox" data-id="${lead.id}"></td>
        <td>${photoHtml}</td>
        <td><a href="https://instagram.com/${lead.username}" target="_blank" class="ig-link">@${lead.username}</a>${lead.isPrivate ? ' <i class="fas fa-lock" style="color:var(--gray);font-size:.7rem"></i>' : ''}<br><small style="color:var(--gray)">${lead.fullName || ''}</small></td>
        <td>${isRecent ? `<span style="color:var(--gray);font-size:.85rem">${slabel}</span>` : `<span class="score-badge ${cls}">${slabel}<br><small>${score}pts</small></span>`}</td>
        <td class="why-cell">${isRecent ? '' : whyExtra + buildWhyHtml(lead)}</td>
        <td class="whatsapp-value">${lead.whatsapp ? `<a href="https://wa.me/${lead.whatsapp.replace(/\D/g,'')}" target="_blank" class="contact-link wa-link"><i class="fab fa-whatsapp"></i> ${lead.whatsapp}</a>` : '-'}</td>
        <td class="email-value">${lead.email ? `<a href="mailto:${lead.email}" class="contact-link mail-link"><i class="fas fa-envelope"></i> ${lead.email}</a>` : '-'}</td>
        <td class="bio-text" title="${lead.bio || ''}">${lead.bio ? lead.bio.slice(0, 60) + (lead.bio.length > 60 ? '...' : '') : '-'}</td>
        <td>${buildAutoActionsHtml(lead)}<button class="action-btn delete" onclick="deleteLead('${lead.id}')" title="Excluir"><i class="fas fa-trash"></i></button></td>
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

    // Ordenar: recentes por posição, demais por score
    state.filteredLeads = state.leads
        .filter(passesFilter)
        .sort((a, b) => {
            if (a.recentFollowerOrder != null && b.recentFollowerOrder != null)
                return (a.recentFollowerOrder || 0) - (b.recentFollowerOrder || 0);
            return (b.score ?? 0) - (a.score ?? 0);
        });

    if (state.filteredLeads.length === 0) {
        tbody.innerHTML = `<tr class="empty-row" id="emptyRow"><td colspan="10"><div class="empty-state">
            <i class="fas fa-filter"></i><p>Nenhum lead com esses filtros</p></div></td></tr>`;
    } else if (state.activeSource === 'google') {
        // Google Maps — usar renderRowGoogle (sem score, sem fotos)
        state.filteredLeads.forEach(lead => renderRowGoogle(lead));
    } else {
        // Instagram — renderização com score/fotos inline
        state.filteredLeads.forEach(lead => {
            const isRecent2 = lead.recentFollowerOrder != null;
            const score = isRecent2 ? 0 : (lead.score ?? 0);
            const { label: slabel, cls } = isRecent2
                ? { label: `#${lead.recentFollowerOrder}`, cls: 'score-neutral' }
                : scoreLabel(score);
            const initial = ((lead.fullName || lead.username || '?').charAt(0)).toUpperCase();
            const photoHtml = lead.photoUrl
                ? `<img src="${lead.photoUrl}" class="user-photo" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                   <div class="user-photo-placeholder" style="display:none">${initial}</div>`
                : `<div class="user-photo-placeholder">${initial}</div>`;

            const row = document.createElement('tr');
            if (lead.isTop10) row.classList.add('top10-row');
            row.dataset.id       = lead.id;
            row.dataset.scoreVal = isRecent2 ? lead.recentFollowerOrder : score;
            row.dataset.score    = cls;

            const whyExtra2 = isRecent2 ? '' : buildTop10Badge(lead) + buildSegmentReasons(lead);
            row.innerHTML = `
                <td><input type="checkbox" class="row-checkbox" data-id="${lead.id}"></td>
                <td>${photoHtml}</td>
                <td><a href="https://instagram.com/${lead.username}" target="_blank" class="ig-link">@${lead.username}</a>${lead.isPrivate?' <i class="fas fa-lock" style="color:var(--gray);font-size:.7rem"></i>':''}<br><small style="color:var(--gray)">${lead.fullName||''}</small></td>
                <td>${isRecent2 ? `<span style="color:var(--gray);font-size:.85rem">${slabel}</span>` : `<span class="score-badge ${cls}">${slabel}<br><small>${score}pts</small></span>`}</td>
                <td class="why-cell">${isRecent2 ? '' : whyExtra2 + buildWhyHtml(lead)}</td>
                <td class="whatsapp-value">${lead.whatsapp?`<a href="https://wa.me/${lead.whatsapp.replace(/\D/g,'')}" target="_blank" class="contact-link wa-link"><i class="fab fa-whatsapp"></i> ${lead.whatsapp}</a>`:'-'}</td>
                <td class="email-value">${lead.email?`<a href="mailto:${lead.email}" class="contact-link mail-link"><i class="fas fa-envelope"></i> ${lead.email}</a>`:'-'}</td>
                <td class="bio-text" title="${lead.bio||''}">${lead.bio?lead.bio.slice(0,60)+(lead.bio.length>60?'...':''):'-'}</td>
                <td>${buildAutoActionsHtml(lead)}<button class="action-btn delete" onclick="deleteLead('${lead.id}')" title="Excluir"><i class="fas fa-trash"></i></button></td>
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

    // Busca (Instagram: username/fullName | Google: name/address)
    if (state.filterSearch) {
        const q = state.filterSearch.toLowerCase();
        if (!(lead.username || '').toLowerCase().includes(q) &&
            !(lead.fullName  || '').toLowerCase().includes(q) &&
            !(lead.name      || '').toLowerCase().includes(q) &&
            !(lead.address   || '').toLowerCase().includes(q)) return false;
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
    const _exp = document.getElementById('btnExportar'); if (_exp) _exp.disabled = state.leads.length === 0;
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
    const _exp = document.getElementById('btnExportar'); if (_exp) _exp.disabled = state.leads.length === 0;
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

    // Google Maps PDF export — modo auto tem relatório aprimorado
    if (state.activeSource === 'google') {
        const date      = new Date().toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' });
        const total     = state.leads.length;
        const withPhone = state.leads.filter(l => l.phone).length;
        const withSite  = state.leads.filter(l => l.website).length;
        const segment   = state.autoSegment || '';
        const keyword   = state.leads[0]?.keyword || '';
        const isAuto    = state.flowMode === 'auto' && segment;
        const top10     = state.leads.filter(l => l.isTop10);

        const headerBg  = isAuto
            ? 'linear-gradient(135deg,#1e3c72,#2a5298)'
            : 'linear-gradient(135deg,#1a73e8,#0d47a1)';

        const cards = state.leads.map((l, i) => {
            const isTop = l.isTop10;
            const segPills = (l.segmentReasons || []).map(r =>
                `<span style="display:inline-block;background:#e8f5e9;color:#2e7d32;border-radius:4px;padding:1px 6px;font-size:9px;margin:1px">${r}</span>`
            ).join('');
            return `
            <div style="page-break-inside:avoid;border:${isTop ? '2px solid #F39C12' : '1px solid #e8e8e8'};border-radius:10px;padding:14px 16px;margin-bottom:10px;background:${isTop ? '#fffde7' : '#fff'}">
                <div style="display:flex;justify-content:space-between;align-items:flex-start">
                    <div style="flex:1">
                        ${isTop ? `<span style="background:#F39C12;color:#fff;font-size:9px;font-weight:700;border-radius:4px;padding:1px 5px;margin-right:4px">🏆 TOP ${l.rank}</span>` : ''}
                        <span style="font-size:14px;font-weight:700;color:#1A1A2E">${i+1}. ${l.name}</span>
                        ${l.category ? `<div style="font-size:11px;color:#888;margin-top:2px">${l.category}</div>` : ''}
                        ${segPills ? `<div style="margin-top:4px">${segPills}</div>` : ''}
                    </div>
                    <div style="text-align:right;flex-shrink:0;margin-left:8px">
                        ${l.rating ? `<div style="font-size:12px;color:#F39C12;font-weight:700">⭐ ${l.rating.toFixed(1)}${l.reviewCount ? ` (${l.reviewCount.toLocaleString('pt-BR')})` : ''}</div>` : ''}
                        ${isAuto && l.score != null ? `<div style="font-size:10px;color:#555;margin-top:2px">Score: ${l.score}pts</div>` : ''}
                    </div>
                </div>
                <div style="margin-top:8px;display:flex;flex-direction:column;gap:4px;font-size:12px">
                    ${l.phone   ? `<div>📞 <a href="tel:${l.phone.replace(/\D/g,'')}" style="color:#00C853">${l.phone}</a></div>` : ''}
                    ${l.address ? `<div style="color:#555">📍 ${l.address}</div>` : ''}
                    ${l.website ? `<div>🌐 <a href="${l.website}" target="_blank" style="color:#0088cc">${l.website}</a></div>` : ''}
                </div>
            </div>`;
        }).join('');
        const html = `<div style="font-family:Inter,Arial,sans-serif;background:#f8fafc;padding:0">
            <div style="background:${headerBg};color:#fff;padding:28px 36px">
                <div style="font-size:22px;font-weight:900">UltraProspec — Google Maps${isAuto ? ' · Ranking Inteligente' : ''}</div>
                ${isAuto
                    ? `<div style="font-size:13px;opacity:.85;margin-top:6px">Segmento: "${segment}" · ${date}</div>`
                    : `<div style="font-size:13px;opacity:.85;margin-top:6px">Busca: "${keyword}" · ${date}</div>`}
                <div style="display:flex;gap:20px;margin-top:14px;font-size:13px;flex-wrap:wrap">
                    <span>📍 ${total} empresas</span><span>📞 ${withPhone} com telefone</span><span>🌐 ${withSite} com site</span>
                    ${isAuto ? `<span>🏆 ${top10.length} leads destaque</span>` : ''}
                </div>
                ${isAuto ? `<div style="margin-top:10px;font-size:11px;opacity:.7">Leads rankeados automaticamente com base no segmento informado · Score máx. 100pts</div>` : ''}
            </div>
            <div style="padding:20px 36px 36px">${cards}</div>
        </div>`;
        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.appendChild(container);
        html2pdf().set({
            margin: 0, filename: `ultraprospec_gmaps_${getTs()}.pdf`,
            image: { type: 'jpeg', quality: 0.95 },
            html2canvas: { scale: 1.5, useCORS: true, logging: false },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
            enableLinks: true, pagebreak: { mode: ['avoid-all','css'] }
        }).from(container).save().then(() => {
            document.body.removeChild(container);
            showToast(`PDF gerado com ${total} leads Google Maps!`, 'success');
        }).catch(() => { document.body.removeChild(container); showToast('Erro ao gerar PDF', 'error'); });
        return;
    }

    // Sempre inclui todos os leads: quentes no topo, frios no final
    const igIsAuto  = state.flowMode === 'auto' && !!state.autoSegment;
    const igSegment = state.autoSegment || '';
    const igTop10   = state.leads.filter(l => l.isTop10);

    // Detectar método de captura pelo source dos leads
    const sources    = [...new Set(state.leads.map(l => l.source).filter(Boolean))];
    const isHashtag  = !igIsAuto && sources.some(s => s.startsWith('busca:') || s.startsWith('#'));
    const isFollower = sources.some(s => s.includes('seguidor') || s.includes('@'));
    const isLikes    = sources.some(s => s.includes('curtidor'));
    const keywords   = sources.filter(s => s.startsWith('busca:')).map(s => s.replace('busca:', '').trim());

    const captureMethod = igIsAuto
        ? `Ranking Automático por Segmento — "${igSegment}"`
        : isHashtag
            ? `Busca por Profissional — palavras-chave: ${keywords.join(', ') || sources.join(', ')}`
            : isLikes
                ? `Curtidores de Posts Recentes — ${sources.join(', ')}`
                : `Análise de Perfil — ${sources.join(', ')}`;

    const sorted = [...state.leads].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

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
        const segPillsIg = (lead.segmentReasons || []).map(r =>
            actionPill(r, '#1565C0')).join('');
        const top10Mark = lead.isTop10
            ? `<span style="background:#F39C12;color:#fff;font-size:9px;font-weight:700;border-radius:4px;padding:1px 5px;margin-right:5px">🏆 TOP ${lead.rank}</span>`
            : '';
        return `
        <div style="page-break-inside:avoid;border:${lead.isTop10?'2px solid #F39C12':'1px solid #e8e8e8'};border-radius:12px;padding:16px;margin-bottom:12px;background:${lead.isTop10?'#fffde7':'#fff'};box-shadow:0 2px 8px rgba(0,0,0,0.06)">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
                <div>
                    <div style="display:flex;align-items:center;gap:8px">
                        <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#00C853,#00962E);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:14px;flex-shrink:0">
                            ${(lead.fullName || lead.username).charAt(0).toUpperCase()}
                        </div>
                        <div>
                            ${top10Mark}<a href="${igUrl}" target="_blank" style="color:#00C853;font-weight:700;font-size:14px;text-decoration:none">@${lead.username}</a>
                            ${lead.fullName ? `<div style="color:#666;font-size:12px">${lead.fullName}</div>` : ''}
                        </div>
                    </div>
                </div>
                <div style="text-align:right">
                    <div style="background:${sc}15;color:${sc};border:1px solid ${sc}40;border-radius:8px;padding:4px 10px;font-weight:700;font-size:13px">${scoreName(score)}</div>
                    <div style="color:#999;font-size:11px;margin-top:2px">${score} pontos</div>
                </div>
            </div>
            ${segPillsIg ? `<div style="margin-bottom:6px">${segPillsIg}</div>` : ''}
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
            <div style="font-size:11px;font-weight:700;letter-spacing:3px;opacity:.6;text-transform:uppercase;margin-bottom:20px">Inteligência Comercial · Instagram${igIsAuto ? ' · Ranking por Segmento' : ''}</div>
            <div style="font-size:36px;font-weight:900;letter-spacing:-1.5px;line-height:1.1;margin-bottom:14px">Relatório de<br>${igIsAuto ? 'Leads Rankeados' : 'Leads Qualificados'}</div>
            ${igIsAuto ? `<div style="font-size:13px;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);border-radius:8px;padding:8px 16px;margin-bottom:16px;display:inline-block">🎯 Segmento: <strong>"${igSegment}"</strong> · ${igTop10.length} leads destaque identificados</div>` : ''}
            <div style="font-size:15px;opacity:.85;max-width:480px;line-height:1.7;margin-bottom:32px">
                ${igIsAuto
                    ? `Leads selecionados e rankeados automaticamente com base no segmento "${igSegment}" — priorizando quem tem maior potencial de conversão.`
                    : 'Pessoas reais do seu nicho que já demonstraram interesse ativo em produtos ou serviços como o seu — identificadas por comportamento, não por achismo.'}
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
    const isGoogle = state.activeSource === 'google';
    let headers, rows;
    if (isGoogle) {
        headers = ['Nome','Telefone','Categoria','Site','Avaliação','Nº Avaliações','Endereço','Busca','Capturado em'];
        rows = state.leads.map(l => [
            l.name || '', l.phone || '', l.category || '', l.website || '',
            l.rating != null ? l.rating.toFixed(1) : '',
            l.reviewCount != null ? l.reviewCount : '',
            l.address || '', l.keyword || '',
            new Date(l.capturedAt).toLocaleString('pt-BR')
        ]);
    } else {
        headers = ['Usuário','Nome','Score','Temperatura','WhatsApp','Email','Bio','Fonte','Privado','Capturado em'];
        rows = state.leads.map(l => {
            const s = l.score ?? calculateScore(l);
            const { label } = scoreLabel(s);
            return [
                `@${l.username}`, l.fullName || '', s, label,
                l.whatsapp || '', l.email || '', l.bio || '',
                l.source || '', l.isPrivate ? 'Sim' : 'Não',
                new Date(l.capturedAt).toLocaleString('pt-BR')
            ];
        });
    }
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
    const _expC = document.getElementById('btnExportar'); if (_expC) _expC.disabled = false;
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

    // 2. Verifica status do Instagram
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

    updateHistoryInfo();
    window.approveLeadPreview = approveLeadPreview;
    window.rejectLeadPreview  = rejectLeadPreview;
    window.clearLeadHistory   = clearLeadHistory;

    // Aviso de créditos pendentes — exibe uma vez por dia
    setTimeout(() => {
        const ig     = getCreditsIG();
        const google = getCreditsGoogle();
        const total  = ig + google;
        const today    = new Date().toISOString().slice(0, 10);
        const lastWarn = localStorage.getItem('up_credit_warn_date');
        if (total > 0 && lastWarn !== today) {
            localStorage.setItem('up_credit_warn_date', today);
            const partes = [];
            if (ig     > 0) partes.push(`${ig} Instagram`);
            if (google > 0) partes.push(`${google} Google Maps`);
            showToast(
                `Você ainda tem ${partes.join(' e ')} crédito${total > 1 ? 's' : ''} disponível${total > 1 ? 'is' : ''}. Use-os em breve — créditos ficam salvos no navegador e podem ser perdidos se você limpar os dados do site.`,
                'warning', 10000
            );
        }
    }, 1500);
});

window.deleteLead = deleteLead;


// ═══════════════════════════════════════════════════════════════
// MOBILE WIZARD — fluxo step-by-step (≤768px)
// Fluxo IG:     source→ig_type→ig_config→ig_credits→ig_login→ig_ready→captura
// Fluxo Google: source→google_config→google_credits→google_ready→captura
// ═══════════════════════════════════════════════════════════════

const mwState = {
    source: null,
    currentStep: 'source',
    igType: 'profile_analysis',
    flowMode: 'auto',   // 'auto' | 'advanced'
};

let mwPendingLogin   = false;
let mwCaptureTimer   = null;   // interval para monitor da captura
let mwLastPdfExport  = null;   // referência ao PDF gerado

// Fluxos avançados (originais)
const MW_FLOW_IG_ADV      = ['source','mode_select','ig_type','ig_config','ig_credits','ig_login','ig_ready'];
const MW_FLOW_GOOGLE_ADV  = ['source','mode_select','google_config','google_credits','google_ready'];
// Fluxos automáticos (novos)
const MW_FLOW_IG_AUTO     = ['source','mode_select','auto_ig_config','ig_credits','ig_login','ig_ready'];
const MW_FLOW_GOOGLE_AUTO = ['source','mode_select','auto_google_config','google_credits','google_ready'];
// Legado — mantido para compatibilidade interna
const MW_FLOW_IG     = MW_FLOW_IG_ADV;
const MW_FLOW_GOOGLE = MW_FLOW_GOOGLE_ADV;

function getMwFlow() {
    if (mwState.source === 'google') {
        return mwState.flowMode === 'auto' ? MW_FLOW_GOOGLE_AUTO : MW_FLOW_GOOGLE_ADV;
    }
    return mwState.flowMode === 'auto' ? MW_FLOW_IG_AUTO : MW_FLOW_IG_ADV;
}

const MW_STEP_EL = {
    source:             'mwStepSource',
    mode_select:        'mwStepModeSelect',
    monitor:            'mwStepMonitor',
    auto_ig_config:     'mwStepAutoIGConfig',
    auto_google_config: 'mwStepAutoGoogleConfig',
    ig_type:            'mwStepIGType',
    ig_config:          'mwStepIGConfig',
    ig_credits:         'mwStepIGCredits',
    ig_login:           'mwStepIGLogin',
    ig_ready:           'mwStepIGReady',
    google_config:      'mwStepGoogleConfig',
    google_credits:     'mwStepGoogleCredits',
    google_ready:       'mwStepGoogleReady',
};

function mwIsMobile() {
    return window.matchMedia('(max-width: 768px)').matches;
}

// ─── Inicialização ────────────────────────────────────────────
function mwInit() {
    if (!mwIsMobile()) return;
    mwGoToStep('source');

    document.querySelectorAll('input[name="mwIGType"]').forEach(r => {
        r.addEventListener('change', () => { mwState.igType = r.value; });
    });

    // Monkey-patch closeLoginModal para detectar login bem-sucedido
    const _orig = closeLoginModal;
    closeLoginModal = function() {
        _orig();
        if (!mwIsMobile()) return;
        setTimeout(() => {
            if (mwState.currentStep === 'ig_login') mwRefreshLoginStep();
            if (mwPendingLogin) {
                mwPendingLogin = false;
                if (loadIgSession()?.loggedIn) mwGoToStep('ig_ready');
            }
        }, 150);
    };

    // Atualizar créditos quando buy modal fechar
    ['closeLoginModal','btnCancelLogin'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', () => {
            if (mwState.currentStep === 'ig_credits')     mwSetupCreditsStep('ig');
            if (mwState.currentStep === 'google_credits') mwSetupCreditsStep('google');
        });
    });
}

// ─── Seleção de origem ────────────────────────────────────────
function mwChooseSource(source) {
    mwState.source = source;
    setSource(source);
    document.querySelectorAll('.mw-source-card').forEach(c => c.classList.remove('selected'));
    document.getElementById(source === 'instagram' ? 'mwCardIG' : 'mwCardGoogle')?.classList.add('selected');
    setTimeout(() => mwGoToStep('mode_select'), 220);
}

// ─── Seleção de modo (Auto / Avançado) ───────────────────────
function mwChooseMode(mode) {
    if (mode === 'monitor') {
        // Vai para step de explicação do monitor
        setTimeout(() => mwGoToStep('monitor'), 180);
        return;
    }
    mwState.flowMode = mode;
    setFlowMode(mode);
    document.getElementById('mwModeAutoBtn')?.classList.toggle('mw-mode-card-active', mode === 'auto');
    document.getElementById('mwModeAdvBtn')?.classList.toggle('mw-mode-card-active', mode === 'advanced');
    const nextStep = mwState.source === 'google'
        ? (mode === 'auto' ? 'auto_google_config' : 'google_config')
        : (mode === 'auto' ? 'auto_ig_config'     : 'ig_type');
    setTimeout(() => mwGoToStep(nextStep), 180);
}

function mwGoToMonitor() {
    // Mostra tela do monitor mobile
    document.getElementById('mobileWizard').style.display    = 'none';
    document.getElementById('mwCaptureScreen').style.display = 'none';
    const ms = document.getElementById('mwMonitorScreen');
    if (ms) ms.style.display = 'flex';
    monitorUI.open  = true;
    monitorUI.unread = 0;
    updateMonitorBadge();
    monitorSyncMobileDesktop();
    if (Notification.permission === 'default')
        document.getElementById('btnNotifPermMobile')?.style.setProperty('display', 'block');
}

// ─── Navegação ────────────────────────────────────────────────
function mwGoToStep(step) {
    Object.values(MW_STEP_EL).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    const el = document.getElementById(MW_STEP_EL[step]);
    if (el) el.style.display = 'block';
    mwState.currentStep = step;

    const body = document.getElementById('mwBody');
    if (body) body.scrollTop = 0;

    mwUpdateTopbar(step);
    mwUpdateFooter(step);

    if (step === 'ig_config')      mwSetupIGConfig();
    if (step === 'ig_credits')     mwSetupCreditsStep('ig');
    if (step === 'ig_login')       mwRefreshLoginStep();
    if (step === 'ig_ready')       mwSetupReadyStep('ig');
    if (step === 'google_credits') mwSetupCreditsStep('google');
    if (step === 'google_ready')   mwSetupReadyStep('google');
}

function mwBack() {
    if (mwState.currentStep === 'monitor') {
        mwGoToStep('mode_select');
        return;
    }
    const flow = getMwFlow();
    const idx  = flow.indexOf(mwState.currentStep);
    if (idx <= 0) return;
    mwGoToStep(flow[idx - 1]);
}

function mwNext() {
    const flow   = getMwFlow();
    const idx    = flow.indexOf(mwState.currentStep);
    const isLast = idx === flow.length - 1;

    if (isLast) { mwExecute(); return; }
    if (!mwValidate(mwState.currentStep)) return;
    mwGoToStep(flow[idx + 1]);
}

// ─── Validação ────────────────────────────────────────────────
function mwValidate(step) {
    if (step === 'auto_ig_config') {
        if (!(document.getElementById('mwAutoIGTarget')?.value || '').trim()) {
            showToast('Informe o perfil do concorrente', 'error'); return false;
        }
        if (!(document.getElementById('mwAutoIGSegment')?.value || '').trim()) {
            showToast('Informe seu segmento — é obrigatório para o ranking', 'error'); return false;
        }
    }
    if (step === 'auto_google_config') {
        if (!(document.getElementById('mwAutoGmapsTerm')?.value || '').trim()) {
            showToast('Informe a palavra-chave de busca', 'error'); return false;
        }
        if (!(document.getElementById('mwAutoGmapsSegment')?.value || '').trim()) {
            showToast('Informe seu segmento — é obrigatório para o ranking', 'error'); return false;
        }
    }
    if (step === 'ig_config') {
        const type = mwState.igType;
        if (type === 'common_followers') {
            const v = (document.getElementById('mwIGMultiTarget')?.value || '').trim();
            if (v.split(',').filter(s => s.trim()).length < 2) {
                showToast('Informe pelo menos 2 perfis separados por vírgula', 'error'); return false;
            }
        } else if (type === 'comments' || type === 'likes') {
            if (!(document.getElementById('mwIGPostUrl')?.value || '').trim()) {
                showToast('Informe a URL do post', 'error'); return false;
            }
        } else {
            if (!(document.getElementById('mwIGTarget')?.value || '').trim()) {
                showToast('Informe o perfil alvo', 'error'); return false;
            }
        }
    }
    if (step === 'google_config') {
        const kw = (document.getElementById('mwGmapsKeyword')?.value || '').trim();
        if (!kw) { showToast('Informe a palavra-chave de busca', 'error'); return false; }
    }
    if (step === 'ig_credits') {
        if (getCreditsIG() <= 0) { showToast('Adquira créditos para continuar', 'warning'); return false; }
    }
    if (step === 'ig_login') {
        if (!loadIgSession()?.loggedIn) { showToast('Conecte sua conta do Instagram para continuar', 'warning'); return false; }
    }
    if (step === 'google_credits') {
        if (getCreditsGoogle() <= 0) { showToast('Adquira créditos para continuar', 'warning'); return false; }
    }
    return true;
}

// ─── Step: Créditos ──────────────────────────────────────────
function mwSetupCreditsStep(source) {
    const isIG = source === 'ig';
    const credits = isIG ? getCreditsIG() : getCreditsGoogle();
    const hasEl   = document.getElementById(isIG ? 'mwIGHasCredits'     : 'mwGoogleHasCredits');
    const noEl    = document.getElementById(isIG ? 'mwIGNoCredits'      : 'mwGoogleNoCredits');
    const countEl = document.getElementById(isIG ? 'mwIGCredCount'      : 'mwGoogleCredCount');
    const iconEl  = document.getElementById(isIG ? 'mwIGCredIcon'       : 'mwGoogleCredIcon');
    const titleEl = document.getElementById(isIG ? 'mwIGCredTitle'      : null);

    if (credits > 0) {
        if (hasEl)  hasEl.style.display  = 'block';
        if (noEl)   noEl.style.display   = 'none';
        if (countEl) countEl.textContent  = credits;
        if (iconEl)  iconEl.className     = 'mw-hero-icon mw-icon-success';
        if (iconEl)  iconEl.innerHTML     = '<i class="fas fa-check-circle"></i>';
        if (titleEl) titleEl.textContent  = 'Créditos OK!';
        // Esconder botão de compra quando tem créditos (regra de sessão)
        const buyBtnEl = isIG
            ? document.querySelector('#mwIGNoCredits .mw-btn-next')
            : document.querySelector('#mwGoogleNoCredits .mw-btn-next');
        if (buyBtnEl) buyBtnEl.style.display = 'none';

        // Auto-avança após breve exibição
        setTimeout(() => {
            if (mwState.currentStep === (isIG ? 'ig_credits' : 'google_credits')) {
                mwGoToStep(isIG ? 'ig_login' : 'google_ready');
            }
        }, 900);
    } else {
        if (hasEl) hasEl.style.display = 'none';
        if (noEl)  noEl.style.display  = 'block';
        if (iconEl) {
            iconEl.className = 'mw-hero-icon';
            iconEl.innerHTML = '<i class="fas fa-coins"></i>';
        }
        if (titleEl) titleEl.textContent = 'Sem créditos';
        // Garante que o botão de compra está visível (pode ter sido escondido numa visita anterior)
        const buyBtnEl = isIG
            ? document.querySelector('#mwIGNoCredits .mw-btn-next')
            : document.querySelector('#mwGoogleNoCredits .mw-btn-next');
        if (buyBtnEl) buyBtnEl.style.display = '';
    }
    mwUpdateFooter(mwState.currentStep);
}

function mwBuyCreditsIG() {
    selectPack('instagram');
    openBuyModal();
}
function mwBuyCreditsGoogle() {
    selectPack('google');
    openBuyModal();
}

// ─── Step: Login Instagram ────────────────────────────────────
function mwRefreshLoginStep() {
    const session  = loadIgSession();
    const loggedIn = !!session?.loggedIn;
    const notConn  = document.getElementById('mwIGNotConn');
    const conn     = document.getElementById('mwIGConn');
    const iconEl   = document.getElementById('mwIGLoginIcon');
    const titleEl  = document.getElementById('mwIGLoginTitle');
    const userEl   = document.getElementById('mwIGConnUser');

    if (notConn) notConn.style.display = loggedIn ? 'none'  : 'block';
    if (conn)    conn.style.display    = loggedIn ? 'block' : 'none';

    if (loggedIn) {
        if (iconEl)  { iconEl.className = 'mw-hero-icon mw-icon-success'; iconEl.innerHTML = '<i class="fab fa-instagram"></i>'; }
        if (titleEl) titleEl.textContent = 'Instagram conectado!';
        if (userEl)  userEl.textContent  = `@${session.username || 'usuario'}`;
    } else {
        if (iconEl)  { iconEl.className = 'mw-hero-icon mw-icon-warn'; iconEl.innerHTML = '<i class="fab fa-instagram"></i>'; }
        if (titleEl) titleEl.textContent = 'Conectar Instagram';
    }
    mwUpdateFooter(mwState.currentStep);
}

let mwBrowserPollTimer = null;

async function mwOpenIGBrowser() {
    const waitEl  = document.getElementById('mwBrowserWaiting');
    const msgEl   = document.getElementById('mwBrowserWaitMsg');
    const iconEl  = document.getElementById('mwBrowserWaitIcon');
    if (waitEl) waitEl.style.display = 'block';

    try {
        const res  = await fetch('/api/ig-auth/browser-login', { method: 'POST' });
        const data = await res.json();

        if (!data.success) {
            if (waitEl) waitEl.style.display = 'none';
            showToast(data.error || 'Erro ao abrir o navegador', 'error');
            return;
        }
        if (msgEl) msgEl.textContent = 'Instagram aberto! Entre com sua conta e aguarde...';

        mwBrowserPollTimer = setInterval(async () => {
            try {
                const r    = await fetch('/api/ig-auth/browser-status');
                const info = await r.json();

                if (info.status === 'done' && info.data) {
                    clearInterval(mwBrowserPollTimer); mwBrowserPollTimer = null;
                    if (waitEl) waitEl.style.display = 'none';
                    const d = info.data;

                    // Validar e salvar sessão via endpoint existente
                    try {
                        const lr = await fetch('/api/login-cookie', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sessionid: d.sessionid, csrftoken: d.csrftoken, dsUserId: d.dsUserId, username: d.username }),
                        });
                        const ld = await lr.json();
                        const user = ld.success ? ld.user : { username: d.username };
                        saveIgSession({ username: user.username || d.username, sessionid: d.sessionid, csrftoken: d.csrftoken, dsUserId: d.dsUserId });
                        updateLoginUI(true, user);
                        showToast(`Conectado como @${user.username || d.username}!`, 'success');
                    } catch {
                        saveIgSession({ username: d.username, sessionid: d.sessionid, csrftoken: d.csrftoken, dsUserId: d.dsUserId });
                        updateLoginUI(true, { username: d.username });
                        showToast('Instagram conectado!', 'success');
                    }

                    mwRefreshLoginStep();
                    setTimeout(() => { if (mwState.currentStep === 'ig_login') mwGoToStep('ig_ready'); }, 700);

                } else if (['timeout','error','cancelled'].includes(info.status)) {
                    clearInterval(mwBrowserPollTimer); mwBrowserPollTimer = null;
                    if (waitEl) waitEl.style.display = 'none';
                    if (info.status !== 'cancelled') showToast('Login encerrado. Tente novamente.', 'warning');
                }
            } catch {}
        }, 1500);

    } catch {
        if (waitEl) waitEl.style.display = 'none';
        showToast('Servidor indisponível. Tente "Colar Session ID".', 'error');
    }
}

async function mwCancelBrowserLogin() {
    if (mwBrowserPollTimer) { clearInterval(mwBrowserPollTimer); mwBrowserPollTimer = null; }
    const waitEl = document.getElementById('mwBrowserWaiting');
    if (waitEl) waitEl.style.display = 'none';
    try { await fetch('/api/ig-auth/browser-cancel', { method: 'POST' }); } catch {}
}

// ─── Step: Pronto (summary) ───────────────────────────────────
function mwSetupReadyStep(source) {
    const isIG   = source === 'ig';
    const summEl = document.getElementById(isIG ? 'mwIGSummary' : 'mwGoogleSummary');
    if (!summEl) return;

    if (isIG) {
        const session  = loadIgSession();
        const typeNames = {
            profile_analysis: 'Análise Completa ⭐',
            recent_likes:     'Curtidores Recentes',
            comments:         'Comentaristas',
            common_followers: 'Seguidores em Comum',
            followers:        'Seguidores',
            hashtag:          'Busca por Profissional',
            likes:            'Curtidores de Post',
        };
        const type   = mwState.igType;
        let   target = '';
        if (type === 'common_followers') {
            target = (document.getElementById('mwIGMultiTarget')?.value || '').split(',')[0]?.trim() + '…';
        } else if (type === 'comments' || type === 'likes') {
            target = document.getElementById('mwIGPostUrl')?.value?.trim() || '—';
        } else {
            target = document.getElementById('mwIGTarget')?.value?.trim() || '—';
        }
        const qty    = document.getElementById('mwIGQty')?.value || '200';
        const cred   = getCreditsIG();
        const user   = session?.username ? `@${session.username}` : 'Conectado';

        summEl.innerHTML = `
            <div class="mw-summary-row"><span>Conta</span><strong>${user}</strong></div>
            <div class="mw-summary-row"><span>Tipo</span><strong>${typeNames[type] || type}</strong></div>
            <div class="mw-summary-row"><span>Alvo</span><strong>${target}</strong></div>
            <div class="mw-summary-row"><span>Quantidade</span><strong>${qty} leads</strong></div>
            <div class="mw-summary-row"><span>Créditos IG</span><strong>${cred} disponíveis</strong></div>
        `;
    } else {
        const kw        = document.getElementById('mwGmapsKeyword')?.value?.trim() || '—';
        const city      = document.getElementById('mwGmapsCity')?.value?.trim()    || '';
        const qty       = document.getElementById('mwGmapsQty')?.value             || '50';
        const cred      = getCreditsGoogle();
        const query     = city ? `${kw} em ${city}` : kw;
        const onlyPhone = document.getElementById('mwGmapsOnlyPhone')?.checked  ? '✅ Só com telefone' : '';
        const onlyWA    = document.getElementById('mwGmapsOnlyWA')?.checked     ? '✅ Só com WhatsApp' : '';
        const onlyNoSite= document.getElementById('mwGmapsOnlyNoSite')?.checked ? '✅ Sem site' : '';
        const minRat    = document.getElementById('mwGmapsMinRating')?.value;
        const maxRat    = document.getElementById('mwGmapsMaxRating')?.value;
        const filtros   = [onlyPhone, onlyWA, onlyNoSite, minRat ? `Nota ≥ ${minRat}` : '', maxRat ? `Nota ≤ ${maxRat}` : ''].filter(Boolean).join(' · ');

        summEl.innerHTML = `
            <div class="mw-summary-row"><span>Busca</span><strong>${query}</strong></div>
            <div class="mw-summary-row"><span>Quantidade</span><strong>${qty} leads</strong></div>
            ${filtros ? `<div class="mw-summary-row"><span>Filtros</span><strong style="font-size:.78rem">${filtros}</strong></div>` : ''}
            <div class="mw-summary-row"><span>Créditos Google</span><strong>${cred} disponíveis</strong></div>
        `;
    }
    mwUpdateFooter(mwState.currentStep);
}

// ─── Execução + tela de captura ──────────────────────────────
async function mwExecute() {
    if (mwState.source === 'instagram') {
        if (!loadIgSession()?.loggedIn) {
            showToast('Conecte o Instagram antes de capturar', 'error'); return;
        }
        // Validar tamanho do perfil alvo (só no modo avançado)
        const igType = mwState.igType;
        const needsProfileCheck = mwState.flowMode === 'advanced' &&
            ['profile_analysis','recent_likes','followers','hashtag'].includes(igType);
        if (needsProfileCheck) {
            const rawTarget = igType === 'hashtag'
                ? (document.getElementById('mwIGTarget')?.value || '').trim()
                : (document.getElementById('mwIGTarget')?.value || '').trim();
            const cleanTarget = rawTarget.replace('@','').split('/').filter(Boolean).pop() || '';
            if (cleanTarget) {
                try {
                    const chk = await fetch('/api/ig/profile-check?username=' + encodeURIComponent(cleanTarget));
                    const chkData = await chk.json();
                    if (chkData.ok) {
                        const f = chkData.followers;
                        if (f < 50) {
                            showToast('O perfil @' + cleanTarget + ' tem ' + f + ' seguidores — muito pequeno. O perfil deve ter entre 50 e 10.000 seguidores.', 'error');
                            mwGoToStep('ig_config'); return;
                        }
                        if (f > 10000) {
                            showToast('O perfil @' + cleanTarget + ' tem ' + f.toLocaleString('pt-BR') + ' seguidores — acima do limite. Escolha um perfil com ate 10.000 seguidores.', 'error');
                            mwGoToStep('ig_config'); return;
                        }
                    }
                    // Se o check falhar (erro de rede etc.), deixa prosseguir
                } catch {}
            }
        }

        // Garantir sessão server-side ativa (pode ter expirado por restart do servidor)
        try {
            const statusRes  = await fetch('/api/status');
            const statusData = await statusRes.json();
            if (!statusData.loggedIn) {
                const saved = loadIgSession();
                if (saved?.sessionid) {
                    const r = await fetch('/api/login-cookie', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(saved),
                    });
                    const d = await r.json();
                    if (!d.success) {
                        showToast('Sessão expirada. Reconecte o Instagram.', 'error');
                        mwGoToStep('ig_login'); return;
                    }
                } else {
                    showToast('Conecte o Instagram antes de capturar', 'error');
                    mwGoToStep('ig_login'); return;
                }
            }
        } catch { /* servidor indisponível — tenta mesmo assim */ }
    }
    mwSyncToSidebar();

    // Mostrar tela de captura
    document.getElementById('mobileWizard').style.display  = 'none';
    document.getElementById('mwCaptureScreen').style.display = 'flex';
    document.getElementById('mwCaptureScreen').style.flexDirection = 'column';

    // Reset dos contadores da tela
    ['mwcsBigCount','mwcsHot','mwcsWA','mwcsEm'].forEach(id => {
        const el = document.getElementById(id); if (el) el.textContent = '0';
    });
    const progFill = document.getElementById('mwcsProgFill');
    const progPct  = document.getElementById('mwcsProgPct');
    if (progFill) progFill.style.width = '0%';
    if (progPct)  progPct.textContent  = '0%';
    const topTitle = document.getElementById('mwcsTopTitle');
    if (topTitle) topTitle.textContent = mwState.source === 'google' ? 'Buscando no Google Maps...' : 'Capturando leads...';

    // Iniciar captura
    if (mwState.source === 'instagram') startCapture();
    else startCaptureGoogle();

    // Iniciar monitor
    mwStartCaptureMonitor();
}

function mwSyncToSidebar() {
    // Sincroniza modo (auto/avançado) com o desktop
    setFlowMode(mwState.flowMode);

    if (mwState.source === 'instagram' && mwState.flowMode === 'auto') {
        // Modo auto IG: preenche campos do sidebar auto
        const target  = document.getElementById('mwAutoIGTarget')?.value  || '';
        const segment = document.getElementById('mwAutoIGSegment')?.value || '';
        const posts   = document.getElementById('mwAutoIGPosts')?.value   || '10';
        const useAI   = document.getElementById('mwAutoIGUseAI')?.checked || false;
        const aiModel = document.getElementById('mwAutoIGAIModel')?.value || 'llama3';
        const elTarget  = document.getElementById('autoIGTarget');
        const elSeg     = document.getElementById('autoSegmentIG');
        const elPosts   = document.getElementById('autoIGPosts');
        const elUseAI   = document.getElementById('autoUseAIIG');
        const elModel   = document.getElementById('autoAIModelIG');
        if (elTarget) elTarget.value   = target;
        if (elSeg)    elSeg.value      = segment;
        if (elPosts)  elPosts.value    = posts;
        if (elUseAI)  elUseAI.checked  = useAI;
        if (elModel)  elModel.value    = aiModel;
        // Trigger config de IA
        toggleAIConfig('ig');
        return;
    }

    if (mwState.source === 'google' && mwState.flowMode === 'auto') {
        // Modo auto Google: preenche campos do sidebar auto
        const term    = document.getElementById('mwAutoGmapsTerm')?.value    || '';
        const city    = document.getElementById('mwAutoGmapsCity')?.value    || '';
        const segment = document.getElementById('mwAutoGmapsSegment')?.value || '';
        const useAI   = document.getElementById('mwAutoGmapsUseAI')?.checked || false;
        const aiModel = document.getElementById('mwAutoGmapsAIModel')?.value || 'llama3';
        const elTerm  = document.getElementById('autoGmapsTerm');
        const elCity  = document.getElementById('autoGmapsCity');
        const elSeg   = document.getElementById('autoSegmentGmaps');
        const elUseAI = document.getElementById('autoUseAIGmaps');
        const elModel = document.getElementById('autoAIModelGmaps');
        if (elTerm)  elTerm.value    = term;
        if (elCity)  elCity.value    = city;
        if (elSeg)   elSeg.value     = segment;
        if (elUseAI) elUseAI.checked = useAI;
        if (elModel) elModel.value   = aiModel;
        toggleAIConfig('gmaps');
        return;
    }

    if (mwState.source === 'instagram') {
        const radio = document.querySelector(`input[name="captureType"][value="${mwState.igType}"]`);
        if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change')); }

        const cfg = document.getElementById(`config-${mwState.igType}`);
        if (cfg) {
            if (mwState.igType === 'common_followers') {
                const ta = cfg.querySelector('.target-input');
                if (ta) ta.value = document.getElementById('mwIGMultiTarget')?.value || '';
            } else if (mwState.igType === 'hashtag') {
                const hp = document.getElementById('hashtagProfile');
                if (hp) hp.value = document.getElementById('mwIGTarget')?.value || '';
                const ta = cfg.querySelector('.target-input');
                if (ta) ta.value = document.getElementById('mwIGKeywords')?.value || '';
            } else if (mwState.igType === 'comments' || mwState.igType === 'likes') {
                const ta = cfg.querySelector('.target-input');
                if (ta) ta.value = document.getElementById('mwIGPostUrl')?.value || '';
            } else {
                const ta = cfg.querySelector('.target-input');
                if (ta) ta.value = document.getElementById('mwIGTarget')?.value || '';
            }
            const postsEl = cfg.querySelector('.posts-input');
            if (postsEl) postsEl.value = document.getElementById('mwIGPosts')?.value || '10';
        }

        const qEl = document.getElementById('quantity');
        if (qEl) qEl.value = document.getElementById('mwIGQty')?.value || '200';
        const waEl = document.getElementById('extractWhatsApp');
        const emEl = document.getElementById('extractEmail');
        if (waEl) waEl.checked = document.getElementById('mwExtractWA')?.checked ?? true;
        if (emEl) emEl.checked = document.getElementById('mwExtractEmail')?.checked ?? true;

        const segType  = document.getElementById('mwSegType')?.value       || 'all';
        const segCity  = document.getElementById('mwSegCity')?.value        || '';
        const segAct   = document.getElementById('mwSegActive')?.checked    || false;
        const segReach = document.getElementById('mwSegReachable')?.checked || false;
        const stEl = document.getElementById('segmentType');
        const scEl = document.getElementById('segmentCity');
        const saEl = document.getElementById('segmentActive');
        const srEl = document.getElementById('segmentReachable');
        if (stEl) stEl.value   = segType;
        if (scEl) scEl.value   = segCity;
        if (saEl) saEl.checked = segAct;
        if (srEl) srEl.checked = segReach;
        state.segmentType      = segType;
        state.segmentCity      = segCity;
        state.segmentActive    = segAct;
        state.segmentReachable = segReach;
    } else {
        // Sync Google Maps wizard → sidebar
        const pairs = [
            ['gmapsKeyword',      'mwGmapsKeyword',   'value'],
            ['gmapsCity',         'mwGmapsCity',       'value'],
            ['gmapsQuantity',     'mwGmapsQty',        'value'],
            ['gmapsOnlyPhone',    'mwGmapsOnlyPhone',  'checked'],
            ['gmapsOnlyWhatsapp', 'mwGmapsOnlyWA',     'checked'],
            ['gmapsOnlyNoWebsite','mwGmapsOnlyNoSite', 'checked'],
            ['gmapsMinRating',    'mwGmapsMinRating',  'value'],
            ['gmapsMaxRating',    'mwGmapsMaxRating',  'value'],
        ];
        pairs.forEach(([sid, wid, prop]) => {
            const sEl = document.getElementById(sid);
            const wEl = document.getElementById(wid);
            if (sEl && wEl) sEl[prop] = wEl[prop];
        });
    }
}

// ─── Monitor em tempo real ────────────────────────────────────
function mwStartCaptureMonitor() {
    let mwWasCapturing = false;

    mwCaptureTimer = setInterval(() => {
        const total = state.leads.length;
        const hot   = state.leads.filter(l => (l.score || 0) >= 65).length;
        const wa    = state.leads.filter(l => l.whatsapp).length;
        const em    = state.leads.filter(l => l.email).length;

        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('mwcsBigCount', total);
        set('mwcsHot', hot);
        set('mwcsWA', wa);
        set('mwcsEm', em);

        // Status text
        const statusTxt = document.getElementById('progressText');
        const statusEl  = document.getElementById('mwcsStatusMsg');
        const rawStatus = statusTxt?.textContent || '';
        if (statusEl) statusEl.textContent = rawStatus || (state.isCapturing ? 'Conectando ao Instagram...' : 'Finalizando...');

        // Contador de perfis escaneados (extrai X/Y do log)
        const scanMatch = rawStatus.match(/(\d+)\s*\/\s*(\d+)/);
        const scanEl  = document.getElementById('mwcsScanCount');
        const scanRow = document.getElementById('mwcsScanRow');
        if (scanEl && scanRow) {
            if (scanMatch) {
                scanEl.textContent = scanMatch[1] + ' / ' + scanMatch[2];
                scanRow.style.display = 'flex';
            } else if (total > 0) {
                scanEl.textContent = total;
                scanRow.style.display = 'flex';
            }
        }

        // Sincronizar barra de progresso
        const fill  = document.getElementById('progressFill');
        const mfill = document.getElementById('mwcsProgFill');
        const mpct  = document.getElementById('mwcsProgPct');
        if (fill && mfill) {
            mfill.style.width = fill.style.width;
            const w = parseFloat(fill.style.width) || 0;
            if (mpct) mpct.textContent = Math.round(w) + '%';
        }

        // Último lead
        if (total > 0) mwRenderLatestLead(state.leads[total - 1]);

        // Detectar início e fim — funciona com 0 leads também
        if (state.isCapturing) mwWasCapturing = true;
        if (mwWasCapturing && !state.isCapturing) {
            clearInterval(mwCaptureTimer);
            mwCaptureTimer = null;
            mwCaptureComplete();
        }
    }, 600);
}

function mwStopCaptureMonitor() {
    if (mwCaptureTimer) { clearInterval(mwCaptureTimer); mwCaptureTimer = null; }
}

function mwRenderLatestLead(lead) {
    const wrap = document.getElementById('mwcsLatest');
    const card = document.getElementById('mwcsLatestCard');
    if (!wrap || !card) return;
    wrap.style.display = 'block';

    const score = lead.score || 0;
    const cls   = score >= 65 ? 'score-hot' : score >= 35 ? 'score-warm' : 'score-cold';
    const emoji = score >= 65 ? '🔥' : score >= 35 ? '🌡️' : '❄️';

    const name  = lead.fullname || lead.username || lead.name || '—';
    const sub   = lead.username ? `@${lead.username}` : (lead.address || '');
    const photo = lead.profilePicUrl || lead.profile_pic_url || '';

    const avatarHtml = photo
        ? `<img src="${photo}" class="mwcs-lead-avatar" onerror="this.style.display='none'">`
        : `<div class="mwcs-lead-avatar-ph">${name.charAt(0).toUpperCase()}</div>`;

    card.innerHTML = `
        ${avatarHtml}
        <div class="mwcs-lead-info">
            <strong>${name}</strong>
            <small>${sub}${lead.whatsapp ? ' · 📱' : ''}${lead.email ? ' · ✉️' : ''}</small>
        </div>
        <span class="mwcs-lead-score ${cls}">${emoji} ${score}</span>
    `;
}

function mwStopAndConfirm() {
    if (state.isCapturing) {
        if (!confirm('Parar a captura agora? Os leads já capturados serão mantidos.')) return;
        stopCapture();
    }
    mwStopCaptureMonitor();
    mwCaptureComplete();
}

function mwCaptureComplete() {
    mwStopCaptureMonitor();

    // Ocultar tela de captura, mostrar tela de conclusão
    document.getElementById('mwCaptureScreen').style.display = 'none';
    const doneEl = document.getElementById('mwDoneScreen');
    doneEl.style.display = 'flex';
    doneEl.style.flexDirection = 'column';

    const total = state.leads.length;
    const hot   = state.leads.filter(l => (l.score || 0) >= 65).length;
    const wa    = state.leads.filter(l => l.whatsapp).length;
    const em    = state.leads.filter(l => l.email).length;

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('mwdsTotalText', `${total} ${total === 1 ? 'lead capturado!' : 'leads capturados!'}`);
    set('mwdsHot', hot);
    set('mwdsWA', wa);
    set('mwdsEm', em);
}

// ─── Ver resultados (tabela desktop) ─────────────────────────
function mwViewResults() {
    document.getElementById('mwDoneScreen').style.display = 'none';
    document.body.classList.add('mw-results');
    const rb = document.getElementById('mwResultsBack');
    if (rb) rb.style.display = 'block';
}

function mwShowWizard() {
    document.getElementById('mwCaptureScreen').style.display = 'none';
    document.getElementById('mwDoneScreen').style.display    = 'none';
    document.getElementById('mobileWizard').style.display    = 'flex';
    document.getElementById('mobileWizard').style.flexDirection = 'column';
    document.body.classList.remove('mw-results');
    const rb = document.getElementById('mwResultsBack');
    if (rb) rb.style.display = 'none';
    mwGoToStep('source');
}

// ─── Topbar & Footer ──────────────────────────────────────────
function mwUpdateTopbar(step) {
    const backIcon = document.getElementById('mwBackIcon');
    if (backIcon) backIcon.style.visibility = step === 'source' ? 'hidden' : 'visible';

    const flow = mwState.source ? getMwFlow() : ['source'];
    const dotsEl = document.getElementById('mwDots');
    if (!dotsEl) return;
    const idx = flow.indexOf(step);
    dotsEl.innerHTML = flow.map((_,i) => {
        const cls = i < idx ? 'mw-dot done' : i === idx ? 'mw-dot active' : 'mw-dot';
        return `<span class="${cls}"></span>`;
    }).join('');
}

function mwUpdateFooter(step) {
    const btnBack  = document.getElementById('mwBtnBack');
    const btnNext  = document.getElementById('mwBtnNext');
    const footer   = document.querySelector('.mw-footer');
    if (!btnBack || !btnNext) return;

    const isSource     = step === 'source';
    const isModeSelect = step === 'mode_select';
    const isMonitor    = step === 'monitor';
    const flow         = getMwFlow();
    const isLast       = flow.indexOf(step) === flow.length - 1;

    // Na tela inicial não precisa de footer — esconde o container inteiro
    if (footer) footer.style.display = isSource ? 'none' : 'flex';

    btnBack.style.visibility = isSource ? 'hidden' : 'visible';

    // Ocultar botão "Continuar" nos steps de crédito com compra pendente
    const isCreditsWithoutFunds =
        (step === 'ig_credits'     && getCreditsIG()     <= 0) ||
        (step === 'google_credits' && getCreditsGoogle() <= 0);

    // Ocultar no step de login quando não conectado
    const isLoginNotConn = step === 'ig_login' && !loadIgSession()?.loggedIn;

    if (isSource || isModeSelect || isMonitor || isCreditsWithoutFunds || isLoginNotConn) {
        btnNext.style.display = 'none';
    } else {
        btnNext.style.display = 'flex';
        if (isLast) {
            btnNext.innerHTML = '<i class="fas fa-play"></i> Começar extrair leads';
            btnNext.classList.add('execute');
        } else {
            btnNext.innerHTML = 'Continuar <i class="fas fa-chevron-right"></i>';
            btnNext.classList.remove('execute');
        }
    }
}

// ─── IG: setup do step de configuração ───────────────────────
function mwSetupIGConfig() {
    const type = document.querySelector('input[name="mwIGType"]:checked')?.value || 'profile_analysis';
    mwState.igType = type;

    ['mwFgTarget','mwFgPosts','mwFgMulti','mwFgPostUrl','mwFgKeywords'].forEach(id => {
        const el = document.getElementById(id); if (el) el.style.display = 'none';
    });
    const show = id => { const el = document.getElementById(id); if (el) el.style.display = 'block'; };
    const lblEl  = document.getElementById('mwLblTarget');
    const tgtEl  = document.getElementById('mwIGTarget');
    const dscEl  = document.getElementById('mwConfigDesc');

    const desc = {
        profile_analysis: 'Análise completa: seguidores + curtidores + comentaristas',
        recent_followers: 'Os seguidores mais recentes do perfil — ordem do mais novo ao mais antigo',
        recent_likes:     'Quem curtiu os últimos posts do perfil',
        comments:         'Comentaristas de um post específico',
        common_followers: 'Quem segue 2 ou mais dos perfis informados',
        followers:        'Seguidores de um perfil',
        hashtag:          'Encontra por profissão, nicho ou palavras-chave',
        likes:            'Quem curtiu um post específico',
    };
    if (dscEl) dscEl.textContent = desc[type] || '';

    switch (type) {
        case 'profile_analysis':
            show('mwFgTarget'); show('mwFgPosts');
            if (lblEl) lblEl.textContent = 'Perfil do Concorrente';
            if (tgtEl) tgtEl.placeholder = '@usuario ou URL do perfil';
            break;
        case 'recent_followers':
            show('mwFgTarget');
            if (lblEl) lblEl.textContent = 'Perfil do Concorrente';
            if (tgtEl) tgtEl.placeholder = '@usuario ou URL do perfil';
            break;
        case 'recent_likes':
            show('mwFgTarget'); show('mwFgPosts');
            if (lblEl) lblEl.textContent = 'Perfil do Instagram';
            if (tgtEl) tgtEl.placeholder = '@usuario ou URL do perfil';
            break;
        case 'comments': case 'likes':
            show('mwFgPostUrl'); break;
        case 'common_followers':
            show('mwFgMulti'); break;
        case 'followers':
            show('mwFgTarget');
            if (lblEl) lblEl.textContent = 'Perfil do Instagram';
            if (tgtEl) tgtEl.placeholder = '@usuario ou URL do perfil';
            break;
        case 'hashtag':
            show('mwFgTarget'); show('mwFgKeywords');
            if (lblEl) lblEl.textContent = 'Perfil alvo para varrer';
            if (tgtEl) tgtEl.placeholder = '@perfil ou URL do Instagram';
            break;
    }
}

// ─── Menu Hambúrguer ──────────────────────────────────────────
function mwOpenMenu() {
    const panel   = document.getElementById('mwMenuPanel');
    const overlay = document.getElementById('mwMenuOverlay');
    if (!panel || !overlay) return;

    // Atualiza créditos
    const ig     = getCreditsIG();
    const google = getCreditsGoogle();
    const credIG     = document.getElementById('mwMenuCredIG');
    const credGoogle = document.getElementById('mwMenuCredGoogle');
    if (credIG)     credIG.textContent     = ig;
    if (credGoogle) credGoogle.textContent = google;

    // Seção de compra: só mostra se todos zerados
    const buySection = document.getElementById('mwMenuBuySection');
    if (buySection) buySection.style.display = (ig === 0 && google === 0) ? 'block' : 'none';

    // Status do Instagram
    const session = loadIgSession();
    const dot  = document.getElementById('mwMenuIGDot');
    const text = document.getElementById('mwMenuIGText');
    const btn  = document.getElementById('mwMenuIGBtn');
    if (dot && text && btn) {
        if (session?.loggedIn) {
            dot.className    = 'mw-menu-ig-dot online';
            text.textContent = '@' + (session.username || 'conectado');
            btn.textContent  = 'Desconectar';
            btn.onclick = () => { mwCloseMenu(); logout(); };
        } else {
            dot.className    = 'mw-menu-ig-dot offline';
            text.textContent = 'Não conectado';
            btn.textContent  = 'Conectar';
            btn.onclick = () => { mwCloseMenu(); openLoginModal(); };
        }
    }

    overlay.style.display = 'block';
    requestAnimationFrame(() => panel.classList.add('open'));
}

function mwCloseMenu() {
    const panel   = document.getElementById('mwMenuPanel');
    const overlay = document.getElementById('mwMenuOverlay');
    if (!panel || !overlay) return;
    panel.classList.remove('open');
    setTimeout(() => { overlay.style.display = 'none'; }, 280);
}

// ─── Bootstrap ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => { mwInit(); monitorInit(); });

// ============================================
// MONITOR DE CONCORRENTES
// ============================================
const monitorUI = {
    es:          null,   // EventSource
    unread:      0,
    open:        false,
};

function isMobileView() {
    return window.innerWidth <= 768 || !!document.getElementById('mobileWizard')?.offsetParent;
}

function openMonitorPanel() {
    monitorUI.open = true;
    monitorUI.unread = 0;
    updateMonitorBadge();

    if (isMobileView()) {
        // Mobile: mostra tela fullscreen
        document.getElementById('mobileWizard').style.display       = 'none';
        document.getElementById('mwCaptureScreen').style.display    = 'none';
        const ms = document.getElementById('mwMonitorScreen');
        if (ms) { ms.style.display = 'flex'; }
        if (Notification.permission === 'default')
            document.getElementById('btnNotifPermMobile')?.style.setProperty('display', 'block');
    } else {
        // Desktop: mostra no sidebar
        ['flowToggle','sidebarAutoIG','sidebarAutoGoogle','sidebarIG','sidebarGoogle'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        const p = document.getElementById('monitorPanel');
        if (p) p.style.display = 'block';
        if (Notification.permission === 'default')
            document.getElementById('btnNotifPerm')?.style.setProperty('display', 'block');
        document.getElementById('monitorInput')?.focus();
    }
    monitorSyncMobileDesktop();
}

function closeMobileMonitor() {
    monitorUI.open = false;
    document.getElementById('mwMonitorScreen').style.display = 'none';
    document.getElementById('mobileWizard').style.display    = 'flex';
}

function closeMonitorPanel() {
    monitorUI.open = false;
    document.getElementById('monitorPanel').style.display = 'none';
    setFlowMode(state.flowMode);
}

function monitorSyncMobileDesktop() {
    // Sincroniza lista de perfis e feed entre desktop e mobile
    const listD = document.getElementById('monitorProfileList');
    const listM = document.getElementById('monitorProfileListMobile');
    if (listD && listM) listM.innerHTML = listD.innerHTML;
    const feedD = document.getElementById('monitorFeed');
    const feedM = document.getElementById('monitorFeedMobile');
    if (feedD && feedM) {
        feedM.innerHTML = feedD.innerHTML;
        const sec = document.getElementById('monitorFeedSectionMobile');
        if (sec) sec.style.display = feedD.children.length > 0 ? 'block' : 'none';
    }
}

async function monitorAddProfileMobile() {
    const input = document.getElementById('monitorInputMobile');
    if (input) {
        document.getElementById('monitorInput').value = input.value;
        input.value = '';
    }
    await monitorAddProfile();
    monitorSyncMobileDesktop();
}

function updateMonitorBadge() {
    const n = monitorUI.unread;
    // Badges com número (sidebar desktop + menu hambúrguer)
    ['monitorUnreadBadge', 'mwMenuMonitorBadge'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent  = n > 0 ? String(n) : '';
        el.style.display = n > 0 ? 'inline-flex' : 'none';
    });
    // Badge ponto (topbar do wizard)
    const dot = document.getElementById('monitorTopbarBadge');
    if (dot) dot.style.display = n > 0 ? 'block' : 'none';
}

async function monitorInit() {
    await monitorLoadProfiles();
    await monitorLoadEvents();
    monitorSyncMobileDesktop();
    monitorConnectSSE();

    // Pede permissão de notificação se ainda não decidiu
    if (Notification.permission === 'default') {
        document.getElementById('btnNotifPerm')?.style.setProperty('display', 'block');
    }
}

function monitorConnectSSE() {
    if (monitorUI.es) monitorUI.es.close();
    const es = new EventSource('/api/monitor/stream');
    monitorUI.es = es;

    es.onmessage = e => {
        try { monitorHandleEvent(JSON.parse(e.data)); } catch {}
    };
    es.onerror = () => {
        setTimeout(monitorConnectSSE, 15000); // reconecta após 15s
    };
}

function monitorHandleEvent(ev) {
    if (ev.type === 'new_follower') {
        monitorAddFeedItem(ev.profile, ev.follower);
        if (!monitorUI.open) {
            monitorUI.unread++;
            updateMonitorBadge();
        }
        // Notificação do browser
        if (Notification.permission === 'granted') {
            new Notification(`Novo seguidor em @${ev.profile}`, {
                body: `@${ev.follower.username}${ev.follower.fullName ? ' — ' + ev.follower.fullName : ''}`,
                icon: ev.follower.photoUrl || '/favicon.ico',
                tag:  `monitor-${ev.follower.id}`,
            });
        }
        showToast(`Novo seguidor em @${ev.profile}: @${ev.follower.username}`, 'success', 6000);
    }
    if (ev.type === 'sync_start')    monitorUpdateProfileStatus(ev.profile, 'syncing', 'Sincronizando...');
    if (ev.type === 'sync_progress') monitorUpdateProfileStatus(ev.profile, 'syncing', `Sincronizando... ${ev.count}`);
    if (ev.type === 'sync_done')     monitorUpdateProfileStatus(ev.profile, 'active',  `${ev.count} seguidores`);
    if (ev.type === 'profile_updated') monitorUpdateProfileStatus(ev.profile, 'active', `Atualizado agora`);
    if (ev.type === 'profile_error')   monitorUpdateProfileStatus(ev.profile, 'error',  ev.error);
    monitorSyncMobileDesktop();
}

async function monitorLoadProfiles() {
    try {
        const r = await fetch('/api/monitor/profiles');
        const { profiles } = await r.json();
        const list = document.getElementById('monitorProfileList');
        if (!list) return;
        list.innerHTML = '';
        profiles.forEach(p => monitorRenderProfile(p));
    } catch {}
}

async function monitorLoadEvents() {
    try {
        const r = await fetch('/api/monitor/events');
        const { events } = await r.json();
        const feed = document.getElementById('monitorFeed');
        if (!feed) return;
        feed.innerHTML = '';
        events.forEach(ev => monitorAddFeedItem(ev.profile_username, {
            id: ev.follower_id, username: ev.follower_username,
            fullName: ev.follower_fullname, photoUrl: ev.follower_photo
        }, new Date(ev.detected_at), ev.seen === 0));
        const unseen = events.filter(e => e.seen === 0).length;
        if (unseen > 0 && !monitorUI.open) { monitorUI.unread = unseen; updateMonitorBadge(); }
        if (events.length > 0) document.getElementById('monitorFeedSection')?.style.setProperty('display', 'block');
    } catch {}
}

function monitorRenderProfile(p) {
    const list = document.getElementById('monitorProfileList');
    if (!list) return;
    const existing = list.querySelector(`[data-profile="${p.username}"]`);
    if (existing) { monitorUpdateProfileStatus(p.username, p.status, monitorStatusText(p)); return; }

    const div = document.createElement('div');
    div.className = 'monitor-profile-item';
    div.dataset.profile = p.username;
    div.innerHTML = `
        <div style="flex:1;min-width:0">
            <span class="monitor-profile-name">@${p.username}</span>
            <span class="monitor-profile-status" id="mps-${p.username}">${monitorStatusText(p)}</span>
        </div>
        <a href="https://instagram.com/${p.username}" target="_blank" style="color:var(--gray);font-size:.8rem;padding:.2rem .4rem"><i class="fab fa-instagram"></i></a>
        <button onclick="monitorRemoveProfile('${p.username}')" style="background:none;border:none;color:var(--gray);cursor:pointer;font-size:.8rem;padding:.2rem .4rem"><i class="fas fa-trash"></i></button>
    `;
    list.appendChild(div);
}

function monitorStatusText(p) {
    if (p.status === 'syncing') return 'Sincronizando...';
    if (p.status === 'error')   return 'Erro — verifique o perfil';
    if (p.status === 'active' && p.last_checked) {
        const min = Math.round((Date.now() - new Date(p.last_checked)) / 60000);
        return min < 2 ? 'Verificado agora' : `Verificado há ${min}min`;
    }
    return 'Aguardando...';
}

function monitorUpdateProfileStatus(username, status, text) {
    const el = document.getElementById(`mps-${username}`);
    if (el) el.textContent = text;
    const item = document.querySelector(`[data-profile="${username}"]`);
    if (item) {
        item.classList.toggle('monitor-status-error',   status === 'error');
        item.classList.toggle('monitor-status-syncing', status === 'syncing');
        item.classList.toggle('monitor-status-active',  status === 'active');
    }
}

function monitorAddFeedItem(profile, follower, date, isNew) {
    const feed = document.getElementById('monitorFeed');
    if (!feed) return;
    document.getElementById('monitorFeedSection')?.style.setProperty('display', 'block');

    const div = document.createElement('div');
    div.className = 'monitor-feed-item' + (isNew !== false ? ' monitor-feed-new' : '');
    const timeStr = date ? new Date(date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'agora';
    div.innerHTML = `
        ${follower.photoUrl ? `<img src="${follower.photoUrl}" class="monitor-feed-photo" onerror="this.style.display='none'">` : '<div class="monitor-feed-photo-placeholder"></div>'}
        <div style="flex:1;min-width:0">
            <a href="https://instagram.com/${follower.username}" target="_blank" class="monitor-feed-username">@${follower.username}</a>
            <span class="monitor-feed-profile">seguiu @${profile}</span>
        </div>
        <span class="monitor-feed-time">${timeStr}</span>
    `;
    feed.insertBefore(div, feed.firstChild);
}

async function monitorAddProfile() {
    const input = document.getElementById('monitorInput');
    const raw   = (input?.value || '').trim();
    if (!raw) return;
    input.value = '';
    input.disabled = true;

    try {
        const r = await fetch('/api/monitor/add', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: raw })
        });
        const d = await r.json();
        if (!d.ok) { showToast(d.error || 'Erro ao adicionar perfil', 'error'); return; }
        monitorRenderProfile({ username: d.username, status: 'pending', follower_count: 0, last_checked: null });
        showToast(`@${d.username} adicionado — sincronizando seguidores...`, 'success');
    } catch (err) {
        showToast('Erro ao adicionar perfil', 'error');
    } finally {
        input.disabled = false;
        input.focus();
    }
}

async function monitorRemoveProfile(username) {
    if (!confirm(`Remover @${username} do monitoramento?`)) return;
    await fetch('/api/monitor/remove', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
    });
    document.querySelector(`[data-profile="${username}"]`)?.remove();
    showToast(`@${username} removido`, 'info');
}

async function monitorMarkSeen() {
    await fetch('/api/monitor/events/seen', { method: 'POST' });
    document.querySelectorAll('.monitor-feed-new').forEach(el => el.classList.remove('monitor-feed-new'));
    monitorUI.unread = 0;
    updateMonitorBadge();
}

function monitorRequestNotifications() {
    Notification.requestPermission().then(p => {
        if (p === 'granted') {
            document.getElementById('btnNotifPerm').style.display = 'none';
            showToast('Notificações ativadas!', 'success');
        }
    });
}

// Dev helper — adiciona créditos de teste via console do browser:
//   addTestCredits(50)        → 50 créditos Instagram
//   addTestCredits(50,'google') → 50 créditos Google
window.addTestCredits = function(n, type) {
    addCredits(n || 50, type || 'instagram');
    console.log(`✅ +${n||50} créditos ${type||'instagram'} adicionados. Total IG: ${getCreditsIG()} | Google: ${getCreditsGoogle()}`);
};
