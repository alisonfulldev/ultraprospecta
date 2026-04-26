// UltraProspec - Main Application JavaScript

// ============================================
// State
// ============================================
const state = {
    leads: [],
    isCapturing: false,
    startTime: null,
    timerInterval: null,
    selectedIds: new Set(),
    eventSource: null,
    totalLeads: 100
};

// ============================================
// Login / Auth
// ============================================

async function checkLoginStatus() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        updateLoginUI(data.loggedIn, data.user);
    } catch (_) {
        updateLoginUI(false, null);
    }
}

function updateLoginUI(loggedIn, user) {
    const dot = document.querySelector('.status-dot');
    const statusText = document.getElementById('loginStatusText');
    const btnAbrirLogin = document.getElementById('btnAbrirLogin');
    const sidebar = document.querySelector('.sidebar');

    if (loggedIn && user) {
        dot.className = 'status-dot online';
        statusText.textContent = `@${user.username}`;
        btnAbrirLogin.innerHTML = '<i class="fas fa-sign-out-alt"></i> Sair';
        btnAbrirLogin.onclick = logout;
        sidebar.classList.remove('sidebar-locked');
    } else {
        dot.className = 'status-dot offline';
        statusText.textContent = 'Não conectado';
        btnAbrirLogin.innerHTML = '<i class="fas fa-sign-in-alt"></i> Login';
        btnAbrirLogin.onclick = openLoginModal;
        sidebar.classList.add('sidebar-locked');
    }
}

let loginStep = 1;
let activeLoginTab = 'password';

function openLoginModal() {
    loginStep = 1;
    document.getElementById('loginModal').classList.add('active');
    document.getElementById('loginStep1').style.display = 'block';
    document.getElementById('loginStep2').style.display = 'none';
    document.getElementById('igUsername').focus();
}

function closeLoginModal() {
    document.getElementById('loginModal').classList.remove('active');
    document.getElementById('loginError').style.display = 'none';
    document.getElementById('igUsername').value = '';
    document.getElementById('igPassword').value = '';
    document.getElementById('igCode').value = '';
    document.getElementById('igSessionId').value = '';
    document.getElementById('loginStep1').style.display = 'block';
    document.getElementById('loginStep2').style.display = 'none';
    loginStep = 1;
}

function switchLoginTab(tab) {
    activeLoginTab = tab;
    document.querySelectorAll('.login-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.getElementById('tabPassword').style.display = tab === 'password' ? 'block' : 'none';
    document.getElementById('tabCookie').style.display = tab === 'cookie' ? 'block' : 'none';
    document.getElementById('loginError').style.display = 'none';

    const btn = document.getElementById('btnConfirmLogin');
    btn.innerHTML = tab === 'cookie'
        ? '<i class="fas fa-sign-in-alt"></i> Entrar com Session ID'
        : '<i class="fas fa-sign-in-alt"></i> Entrar';
}

async function login() {
    if (activeLoginTab === 'cookie') {
        await loginWithCookie();
        return;
    }
    if (loginStep === 2) {
        await submitChallenge();
        return;
    }

    const username = document.getElementById('igUsername').value.trim();
    const password = document.getElementById('igPassword').value;
    const errorEl = document.getElementById('loginError');
    const btn = document.getElementById('btnConfirmLogin');

    if (!username || !password) {
        errorEl.textContent = 'Preencha usuário e senha.';
        errorEl.style.display = 'block';
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Entrando...';
    errorEl.style.display = 'none';

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await res.json();

        if (data.success) {
            closeLoginModal();
            updateLoginUI(true, data.user);
            showToast(`Conectado como @${data.user.username}`, 'success');
        } else if (data.checkpointRequired) {
            loginStep = 2;
            document.getElementById('loginStep1').style.display = 'none';
            document.getElementById('loginStep2').style.display = 'block';
            btn.innerHTML = '<i class="fas fa-check"></i> Verificar';
            document.getElementById('igCode').focus();
            showToast('Código enviado! Verifique seu email ou SMS.', 'info');
        } else {
            errorEl.textContent = data.error || 'Falha no login.';
            errorEl.style.display = 'block';
        }
    } catch (_) {
        errorEl.textContent = 'Erro de conexão com o servidor.';
        errorEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        if (loginStep === 1) btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Entrar';
    }
}

async function loginWithCookie() {
    const sessionid = document.getElementById('igSessionId').value.trim();
    const username = document.getElementById('igCookieUsername').value.trim();
    const errorEl = document.getElementById('loginError');
    const btn = document.getElementById('btnConfirmLogin');

    if (!username) {
        errorEl.textContent = 'Informe seu usuário do Instagram.';
        errorEl.style.display = 'block';
        return;
    }
    if (!sessionid) {
        errorEl.textContent = 'Cole o valor do sessionid.';
        errorEl.style.display = 'block';
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verificando...';
    errorEl.style.display = 'none';

    const csrftoken = document.getElementById('igCsrfToken').value.trim();
    const dsUserId  = document.getElementById('igDsUserId').value.trim();

    try {
        const res = await fetch('/api/login-cookie', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionid, username, csrftoken, dsUserId })
        });
        const data = await res.json();

        if (data.success) {
            closeLoginModal();
            updateLoginUI(true, data.user);
            showToast(`Conectado como @${data.user.username}`, 'success');
        } else {
            errorEl.textContent = data.error || 'Session ID inválido.';
            errorEl.style.display = 'block';
        }
    } catch (_) {
        errorEl.textContent = 'Erro de conexão com o servidor.';
        errorEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Entrar com Session ID';
    }
}

async function submitChallenge() {
    const code = document.getElementById('igCode').value.trim();
    const errorEl = document.getElementById('loginError');
    const btn = document.getElementById('btnConfirmLogin');

    if (!code) {
        errorEl.textContent = 'Digite o código recebido.';
        errorEl.style.display = 'block';
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verificando...';
    errorEl.style.display = 'none';

    try {
        const res = await fetch('/api/challenge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });

        const data = await res.json();

        if (data.success) {
            closeLoginModal();
            updateLoginUI(true, data.user);
            showToast(`Conectado como @${data.user.username}`, 'success');
        } else {
            errorEl.textContent = data.error || 'Código inválido.';
            errorEl.style.display = 'block';
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-check"></i> Verificar';
        }
    } catch (_) {
        errorEl.textContent = 'Erro de conexão com o servidor.';
        errorEl.style.display = 'block';
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-check"></i> Verificar';
    }
}

async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    updateLoginUI(false, null);
    showToast('Sessão encerrada', 'info');
}

// ============================================
// Capture Process
// ============================================

async function startCapture() {
    const sidebar = document.querySelector('.sidebar');
    if (sidebar.classList.contains('sidebar-locked')) {
        showToast('Faça login no Instagram primeiro', 'warning');
        openLoginModal();
        return;
    }

    const targetUrl = document.getElementById('targetUrl').value.trim();
    const quantity = parseInt(document.getElementById('quantity').value) || 100;
    const delay = parseInt(document.getElementById('delay').value) || 800;
    const captureType = document.querySelector('input[name="captureType"]:checked').value;
    const fetchBio = document.getElementById('extractWhatsApp').checked || document.getElementById('extractEmail').checked;

    if (!targetUrl) {
        showToast('Insira a URL do perfil ou post do Instagram', 'error');
        return;
    }

    if (!targetUrl.includes('instagram.com') && !targetUrl.startsWith('@') && !targetUrl.match(/^[\w.]+$/)) {
        showToast('Use uma URL do Instagram ou um @ de usuário', 'error');
        return;
    }

    state.isCapturing = true;
    state.startTime = new Date();
    state.totalLeads = quantity;

    updateCaptureUI(true);
    document.getElementById('progressContainer').style.display = 'block';
    document.getElementById('captureStatus').textContent = 'Capturando...';
    document.getElementById('captureStatus').className = 'status-running';
    startTimer();

    const params = new URLSearchParams({
        type: captureType,
        target: targetUrl,
        quantity,
        delay,
        fetchBio: fetchBio ? 'true' : 'false'
    });

    const eventSource = new EventSource(`/api/capture?${params}`);
    state.eventSource = eventSource;

    eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'lead') {
            state.leads.push(data.lead);
            addLeadToTable(data.lead);
            updateLeadCount();
            updateProgress(state.leads.length, state.totalLeads);

        } else if (data.type === 'log') {
            document.getElementById('progressText').textContent = data.message;

        } else if (data.type === 'done') {
            eventSource.close();
            state.eventSource = null;
            finishCapture(`Captura concluída! ${state.leads.length} leads capturados.`, 'success');

        } else if (data.type === 'error') {
            eventSource.close();
            state.eventSource = null;
            finishCapture(data.message, 'error');
        }
    };

    eventSource.onerror = () => {
        eventSource.close();
        state.eventSource = null;
        if (state.isCapturing) {
            finishCapture('Conexão interrompida com o servidor', 'error');
        }
    };
}

function stopCapture() {
    if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
    }
    finishCapture('Captura interrompida pelo usuário.', 'warning');
}

function finishCapture(message, toastType) {
    state.isCapturing = false;
    stopTimer();
    updateCaptureUI(false);

    document.getElementById('captureStatus').textContent =
        toastType === 'success' ? 'Concluído' : toastType === 'warning' ? 'Interrompido' : 'Erro';
    document.getElementById('captureStatus').className =
        toastType === 'success' ? 'status-completed' : 'status-idle';

    document.getElementById('btnExportar').disabled = state.leads.length === 0;
    showToast(message, toastType);
}

function updateCaptureUI(isCapturing) {
    const startBtn = document.getElementById('btnIniciarCaptura');
    const stopBtn = document.getElementById('btnPararCaptura');
    const inputs = document.querySelectorAll('.sidebar input');

    if (isCapturing) {
        startBtn.style.display = 'none';
        stopBtn.style.display = 'block';
        inputs.forEach(input => input.disabled = true);
    } else {
        startBtn.style.display = 'block';
        stopBtn.style.display = 'none';
        inputs.forEach(input => input.disabled = false);
    }
}

// ============================================
// Timer
// ============================================

function startTimer() {
    state.timerInterval = setInterval(() => {
        const elapsed = Math.floor((new Date() - state.startTime) / 1000);
        const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
        const seconds = (elapsed % 60).toString().padStart(2, '0');
        document.getElementById('elapsedTime').textContent = `${minutes}:${seconds}`;
    }, 1000);
}

function stopTimer() {
    if (state.timerInterval) {
        clearInterval(state.timerInterval);
        state.timerInterval = null;
    }
}

// ============================================
// UI
// ============================================

function updateLeadCount() {
    document.getElementById('leadCount').textContent = state.leads.length;
}

function updateProgress(current, total) {
    const percent = Math.min(Math.round((current / total) * 100), 100);
    document.getElementById('progressFill').style.width = `${percent}%`;
    document.getElementById('progressPercent').textContent = `${percent}%`;
    document.getElementById('progressText').textContent = `Capturando leads... ${current}/${total}`;
}

function addLeadToTable(lead) {
    const tbody = document.getElementById('resultsBody');

    const emptyRow = tbody.querySelector('.empty-row');
    if (emptyRow) emptyRow.remove();

    const row = document.createElement('tr');
    row.dataset.id = lead.id;

    const photoHtml = lead.photoUrl
        ? `<img src="${lead.photoUrl}" alt="${lead.username}" class="user-photo" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
           <div class="user-photo-placeholder" style="display:none">${(lead.fullName || lead.username).charAt(0).toUpperCase()}</div>`
        : `<div class="user-photo-placeholder">${(lead.fullName || lead.username).charAt(0).toUpperCase()}</div>`;

    row.innerHTML = `
        <td><input type="checkbox" class="row-checkbox" data-id="${lead.id}"></td>
        <td>${photoHtml}</td>
        <td><strong>@${lead.username}</strong>${lead.isPrivate ? ' <i class="fas fa-lock" title="Privado" style="color:var(--gray);font-size:0.7rem"></i>' : ''}</td>
        <td>${lead.fullName || '-'}</td>
        <td class="whatsapp-value">${lead.whatsapp || '-'}</td>
        <td class="email-value">${lead.email || '-'}</td>
        <td class="bio-text" title="${lead.bio || ''}">${lead.bio || '-'}</td>
        <td>
            <button class="action-btn delete" onclick="deleteLead('${lead.id}')" title="Excluir">
                <i class="fas fa-trash"></i>
            </button>
        </td>
    `;

    tbody.appendChild(row);
}

function showEmptyState() {
    const tbody = document.getElementById('resultsBody');
    tbody.innerHTML = `
        <tr class="empty-row">
            <td colspan="8">
                <div class="empty-state">
                    <i class="fas fa-user-plus"></i>
                    <p>Nenhum lead capturado ainda</p>
                    <small>Configure as opções ao lado e clique em "Iniciar Captura"</small>
                </div>
            </td>
        </tr>
    `;
}

function deleteLead(id) {
    state.leads = state.leads.filter(lead => lead.id != id);
    const row = document.querySelector(`tr[data-id="${id}"]`);
    if (row) row.remove();

    updateLeadCount();
    document.getElementById('btnExportar').disabled = state.leads.length === 0;
    if (state.leads.length === 0) showEmptyState();
}

// ============================================
// Selection
// ============================================

function selectAll() {
    document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = true);
    state.selectedIds = new Set(state.leads.map(l => l.id));
}

function clearSelection() {
    document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = false);
    state.selectedIds.clear();
}

function deleteSelected() {
    if (state.selectedIds.size === 0) {
        showToast('Nenhum lead selecionado', 'warning');
        return;
    }

    const count = state.selectedIds.size;
    state.leads = state.leads.filter(lead => !state.selectedIds.has(lead.id));
    state.selectedIds.forEach(id => {
        const row = document.querySelector(`tr[data-id="${id}"]`);
        if (row) row.remove();
    });

    state.selectedIds.clear();
    updateLeadCount();
    document.getElementById('btnExportar').disabled = state.leads.length === 0;
    if (state.leads.length === 0) showEmptyState();
    showToast(`${count} leads excluídos`, 'success');
}

// ============================================
// Export
// ============================================

function exportToExcel() {
    if (state.leads.length === 0) {
        showToast('Nenhum lead para exportar', 'warning');
        return;
    }

    const headers = ['Usuário', 'Nome Completo', 'WhatsApp', 'Email', 'Bio', 'Privado', 'Data da Captura'];
    const rows = state.leads.map(lead => [
        `@${lead.username}`,
        lead.fullName || '',
        lead.whatsapp || '',
        lead.email || '',
        lead.bio || '',
        lead.isPrivate ? 'Sim' : 'Não',
        new Date(lead.capturedAt).toLocaleString('pt-BR')
    ]);

    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const BOM = '﻿';
    const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `ultraprospec_${getTimestamp()}.csv`;
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToast(`${state.leads.length} leads exportados!`, 'success');
}

function getTimestamp() {
    const now = new Date();
    return `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;
}

// ============================================
// Import
// ============================================

function openImportModal() {
    document.getElementById('importModal').classList.add('active');
}

function closeImportModal() {
    document.getElementById('importModal').classList.remove('active');
    document.getElementById('importArea').style.display = 'block';
    document.getElementById('importPreview').style.display = 'none';
    document.getElementById('fileInput').value = '';
    document.getElementById('btnConfirmImport').disabled = true;
}

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) processFile(file);
}

function handleDragOver(event) {
    event.preventDefault();
    document.getElementById('importArea').classList.add('dragover');
}

function handleDragLeave(event) {
    event.preventDefault();
    document.getElementById('importArea').classList.remove('dragover');
}

function handleDrop(event) {
    event.preventDefault();
    document.getElementById('importArea').classList.remove('dragover');
    const file = event.dataTransfer.files[0];
    if (file) processFile(file);
}

function processFile(file) {
    const validExtensions = ['.csv', '.xlsx', '.xls'];
    const extension = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

    if (!validExtensions.includes(extension)) {
        showToast('Use CSV ou Excel (.xlsx/.xls)', 'error');
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        if (extension === '.csv') {
            parseCSV(e.target.result);
        } else {
            showToast('Excel importado (leitura completa requer backend)', 'info');
        }
    };
    reader.readAsText(file);
}

function parseCSV(content) {
    const lines = content.split('\n').filter(line => line.trim());
    if (lines.length < 2) { showToast('Arquivo vazio', 'error'); return; }

    const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const usernameIdx = header.findIndex(h => /usuário|username|user/i.test(h));
    const nameIdx = header.findIndex(h => /nome completo|nome|name/i.test(h));
    const whatsappIdx = header.findIndex(h => /whatsapp|phone|telefone/i.test(h));
    const emailIdx = header.findIndex(h => /email|mail/i.test(h));
    const bioIdx = header.findIndex(h => /bio|description|descrição/i.test(h));

    const importedLeads = [];

    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (!values.length) continue;

        const lead = {
            id: `import_${Date.now()}_${i}`,
            username: usernameIdx >= 0 ? cleanValue(values[usernameIdx]).replace('@', '') : `user_${i}`,
            fullName: nameIdx >= 0 ? cleanValue(values[nameIdx]) : '',
            whatsapp: whatsappIdx >= 0 ? cleanValue(values[whatsappIdx]) : null,
            email: emailIdx >= 0 ? cleanValue(values[emailIdx]) : null,
            bio: bioIdx >= 0 ? cleanValue(values[bioIdx]) : '',
            photoUrl: '',
            isPrivate: false,
            capturedAt: new Date().toISOString()
        };

        importedLeads.push(lead);
    }

    state.leads = [...state.leads, ...importedLeads];
    importedLeads.forEach(lead => addLeadToTable(lead));
    updateLeadCount();
    document.getElementById('btnExportar').disabled = false;
    showImportPreview(importedLeads, header);
    showToast(`${importedLeads.length} leads importados!`, 'success');
}

function parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (const char of line) {
        if (char === '"') { inQuotes = !inQuotes; }
        else if (char === ',' && !inQuotes) { values.push(current); current = ''; }
        else { current += char; }
    }
    values.push(current);
    return values;
}

function cleanValue(value) {
    return value ? value.trim().replace(/^"|"$/g, '') : '';
}

function showImportPreview(leads, headers) {
    document.getElementById('importArea').style.display = 'none';
    document.getElementById('importPreview').style.display = 'block';
    document.getElementById('btnConfirmImport').disabled = false;

    const thead = document.querySelector('#previewTable thead');
    const tbody = document.querySelector('#previewTable tbody');

    thead.innerHTML = '<tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr>';
    tbody.innerHTML = leads.slice(0, 5).map(lead => `
        <tr>
            <td>@${lead.username}</td>
            <td>${lead.fullName || '-'}</td>
            <td>${lead.whatsapp || '-'}</td>
            <td>${lead.email || '-'}</td>
            <td>${(lead.bio || '').substring(0, 30)}${lead.bio && lead.bio.length > 30 ? '...' : ''}</td>
        </tr>
    `).join('');

    document.getElementById('importSummary').textContent = `Total: ${leads.length} leads encontrados`;
}

function confirmImport() {
    closeImportModal();
}

// ============================================
// Toast
// ============================================

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
        success: 'fa-check-circle',
        error: 'fa-exclamation-circle',
        warning: 'fa-exclamation-triangle',
        info: 'fa-info-circle'
    };

    toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ============================================
// Event Listeners
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    checkLoginStatus();

    // Capture
    document.getElementById('btnIniciarCaptura').addEventListener('click', startCapture);
    document.getElementById('btnPararCaptura').addEventListener('click', stopCapture);

    // Export / Import
    document.getElementById('btnExportar').addEventListener('click', exportToExcel);
    document.getElementById('btnImportar').addEventListener('click', openImportModal);
    document.getElementById('closeImportModal').addEventListener('click', closeImportModal);
    document.getElementById('btnCancelImport').addEventListener('click', closeImportModal);
    document.getElementById('btnConfirmImport').addEventListener('click', confirmImport);

    // Login tabs
    document.querySelectorAll('.login-tab').forEach(btn => {
        btn.addEventListener('click', () => switchLoginTab(btn.dataset.tab));
    });

    // Login modal
    document.getElementById('closeLoginModal').addEventListener('click', closeLoginModal);
    document.getElementById('btnCancelLogin').addEventListener('click', closeLoginModal);
    document.getElementById('btnConfirmLogin').addEventListener('click', login);
    document.getElementById('igPassword').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') login();
    });
    document.getElementById('igCode').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') login();
    });
    document.getElementById('loginModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeLoginModal();
    });

    // File import
    const fileInput = document.getElementById('fileInput');
    const importArea = document.getElementById('importArea');
    importArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileSelect);
    importArea.addEventListener('dragover', handleDragOver);
    importArea.addEventListener('dragleave', handleDragLeave);
    importArea.addEventListener('drop', handleDrop);
    document.getElementById('importModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeImportModal();
    });

    // Selection
    document.getElementById('btnSelecionarTodos').addEventListener('click', selectAll);
    document.getElementById('btnLimparSelecao').addEventListener('click', clearSelection);
    document.getElementById('btnExcluirSelecionados').addEventListener('click', deleteSelected);
    document.getElementById('checkAll').addEventListener('change', (e) => {
        e.target.checked ? selectAll() : clearSelection();
    });

    document.getElementById('resultsBody').addEventListener('change', (e) => {
        if (e.target.classList.contains('row-checkbox')) {
            const id = e.target.dataset.id;
            e.target.checked ? state.selectedIds.add(id) : state.selectedIds.delete(id);
        }
    });

    // Quantity validation
    document.getElementById('quantity').addEventListener('input', (e) => {
        let v = parseInt(e.target.value);
        if (v > 1000) e.target.value = 1000;
        if (v < 1) e.target.value = 1;
    });
});

window.deleteLead = deleteLead;

// ============================================
// Monitor
// ============================================

const monitorState = {
    newFollowers: [],
    eventSource: null,
    profiles: new Map()
};

function switchMode(mode) {
    const isMonitor = mode === 'monitor';
    document.querySelector('.main-content').style.display  = isMonitor ? 'none' : '';
    document.getElementById('monitorPanel').style.display  = isMonitor ? 'flex' : 'none';
    document.getElementById('btnModoMonitor').style.display = isMonitor ? 'none' : '';
    document.getElementById('btnModoCaptura').style.display = isMonitor ? '' : 'none';
    document.getElementById('btnImportar').style.display    = isMonitor ? 'none' : '';
    document.getElementById('btnExportar').style.display    = isMonitor ? 'none' : '';

    if (isMonitor && !monitorState.eventSource) startMonitorStream();
}

function startMonitorStream() {
    if (!document.getElementById('monitorPanel').style.display !== 'none') return;
    const es = new EventSource('/api/monitor/stream');
    monitorState.eventSource = es;

    es.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'new_follower') {
            monitorState.newFollowers.push(data.follower);
            addMonitorRow(data.follower, data.username);
            document.getElementById('monitorNewCount').textContent = monitorState.newFollowers.length;
            document.getElementById('btnExportarMonitor').disabled = false;
            showToast(`Novo seguidor em @${data.username}: @${data.follower.username}`, 'success');

        } else if (data.type === 'polling') {
            updateMonitorStatus(data.username, 'Verificando...');

        } else if (data.type === 'snapshot') {
            updateMonitorStatus(data.username, `Snapshot salvo (${data.count.toLocaleString()} seg.)`);
            updateProfileCard(data.username, { count: data.count, lastCheck: data.lastCheck, hasSnapshot: true });
            showToast(`@${data.username}: snapshot inicial salvo com ${data.count.toLocaleString()} seguidores`, 'info');

        } else if (data.type === 'checked') {
            updateMonitorStatus(data.username, `OK — ${data.newCount} novos`);
            updateProfileCard(data.username, { count: data.count, lastCheck: data.lastCheck });

        } else if (data.type === 'profile_status') {
            updateProfileCard(data.username, { count: data.followerCount, lastCheck: data.lastCheck, hasSnapshot: data.hasSnapshot });

        } else if (data.type === 'error') {
            updateMonitorStatus(data.username, `Erro: ${data.message}`);
            showToast(`Erro em @${data.username}: ${data.message}`, 'error');
        }
    };

    es.onerror = () => {
        monitorState.eventSource = null;
        setTimeout(startMonitorStream, 5000);
    };
}

function updateMonitorStatus(username, text) {
    document.getElementById('monitorStatusText').textContent = `@${username}: ${text}`;
    document.getElementById('monitorStatusDot').className = 'fas fa-circle monitor-pulse';
}

function updateProfileCard(username, { count, lastCheck, hasSnapshot }) {
    const card = document.getElementById(`monitor-card-${username}`);
    if (!card) return;
    const countEl   = card.querySelector('.monitor-card-count');
    const checkEl   = card.querySelector('.monitor-card-check');
    const statusEl  = card.querySelector('.monitor-card-status');
    if (countEl)  countEl.textContent  = count ? `${count.toLocaleString()} seguidores` : '';
    if (checkEl && lastCheck)  checkEl.textContent = `Verificado: ${new Date(lastCheck).toLocaleTimeString('pt-BR')}`;
    if (statusEl) statusEl.textContent = hasSnapshot ? 'Monitorando' : 'Aguardando snapshot...';
}

function addMonitorRow(follower, monitoredUsername) {
    const tbody = document.getElementById('monitorBody');
    const emptyRow = tbody.querySelector('.empty-row');
    if (emptyRow) emptyRow.remove();

    const row = document.createElement('tr');
    row.classList.add('new-follower-row');

    const photoHtml = follower.photoUrl
        ? `<img src="${follower.photoUrl}" class="user-photo" onerror="this.style.display='none'">`
        : `<div class="user-photo-placeholder">${(follower.fullName || follower.username).charAt(0).toUpperCase()}</div>`;

    row.innerHTML = `
        <td>${photoHtml}</td>
        <td><strong>@${follower.username}</strong></td>
        <td>${follower.fullName || '-'}</td>
        <td><span class="badge-profile">@${monitoredUsername}</span></td>
        <td>${follower.whatsapp || '-'}</td>
        <td>${follower.email || '-'}</td>
        <td>${new Date(follower.detectedAt).toLocaleString('pt-BR')}</td>
    `;

    tbody.insertBefore(row, tbody.firstChild);
}

async function adicionarMonitor() {
    const target   = document.getElementById('monitorTarget').value.trim();
    const interval = document.getElementById('monitorInterval').value;

    if (!target) { showToast('Informe o usuário ou URL do perfil', 'warning'); return; }

    const btn = document.getElementById('btnAdicionarMonitor');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adicionando...';

    try {
        const res  = await fetch('/api/monitor/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: target, interval: parseInt(interval) })
        });
        const data = await res.json();

        if (data.success) {
            document.getElementById('monitorTarget').value = '';
            addProfileCard(data.username, data.hasSnapshot);
            updateMonitorCount();
            showToast(`Monitorando @${data.username}${data.hasSnapshot ? ' (snapshot existente)' : ' — criando snapshot...'}`, 'success');
        } else {
            showToast(data.error, 'error');
        }
    } catch (_) {
        showToast('Erro de conexão', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-plus"></i> Adicionar Monitor';
    }
}

function addProfileCard(username, hasSnapshot) {
    const list = document.getElementById('monitorList');
    const emptyEl = list.querySelector('.empty-monitor');
    if (emptyEl) emptyEl.remove();

    const card = document.createElement('div');
    card.className = 'monitor-card';
    card.id = `monitor-card-${username}`;
    card.innerHTML = `
        <div class="monitor-card-info">
            <strong>@${username}</strong>
            <span class="monitor-card-status">${hasSnapshot ? 'Monitorando' : 'Criando snapshot...'}</span>
            <small class="monitor-card-count"></small>
            <small class="monitor-card-check"></small>
        </div>
        <button class="action-btn delete" onclick="removerMonitor('${username}')" title="Remover">
            <i class="fas fa-times"></i>
        </button>
    `;
    list.appendChild(card);
    monitorState.profiles.set(username, true);
}

async function removerMonitor(username) {
    await fetch('/api/monitor/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
    });
    const card = document.getElementById(`monitor-card-${username}`);
    if (card) card.remove();
    monitorState.profiles.delete(username);
    updateMonitorCount();
    showToast(`Monitor de @${username} removido`, 'info');

    if (monitorState.profiles.size === 0) {
        document.getElementById('monitorList').innerHTML = '<p class="empty-monitor">Nenhum perfil monitorado ainda.</p>';
    }
}

function updateMonitorCount() {
    document.getElementById('monitorCount').textContent = `${monitorState.profiles.size}/4`;
}

function exportarMonitor() {
    if (monitorState.newFollowers.length === 0) { showToast('Nenhum dado para exportar', 'warning'); return; }
    const headers = ['Usuário', 'Nome', 'WhatsApp', 'Email', 'Bio', 'Detectado em'];
    const rows = monitorState.newFollowers.map(f => [
        `@${f.username}`, f.fullName || '', f.whatsapp || '', f.email || '', f.bio || '',
        new Date(f.detectedAt).toLocaleString('pt-BR')
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `monitor_novos_${getTimestamp()}.csv`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast(`${monitorState.newFollowers.length} seguidores exportados`, 'success');
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btnModoMonitor').addEventListener('click', () => switchMode('monitor'));
    document.getElementById('btnModoCaptura').addEventListener('click', () => switchMode('capture'));
    document.getElementById('btnAdicionarMonitor').addEventListener('click', adicionarMonitor);
    document.getElementById('btnExportarMonitor').addEventListener('click', exportarMonitor);
    document.getElementById('btnLimparMonitor').addEventListener('click', () => {
        monitorState.newFollowers = [];
        document.getElementById('monitorNewCount').textContent = '0';
        document.getElementById('monitorBody').innerHTML = `
            <tr class="empty-row"><td colspan="7">
                <div class="empty-state"><i class="fas fa-satellite-dish"></i>
                <p>Nenhum novo seguidor detectado ainda</p>
                <small>Adicione um perfil para monitorar e aguarde</small></div>
            </td></tr>`;
        document.getElementById('btnExportarMonitor').disabled = true;
    });
});

window.removerMonitor = removerMonitor;
