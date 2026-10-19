// Anne-IA Dashboard — Lógica de Interface Vanilla
(() => {
  'use strict';

  // Estado da aplicação
  let instances = [];
  let currentConnectInstanceId = null;
  let currentSettingsInstanceId = null;
  let pollStatusTimer = null;

  // Elementos do DOM
  const elements = {
    instancesTbody: document.getElementById('instances-tbody'),
    searchInput: document.getElementById('search-input'),
    btnRefresh: document.getElementById('btn-refresh'),
    btnNewInstance: document.getElementById('btn-new-instance'),
    metricTotal: document.getElementById('metric-total'),
    metricOpen: document.getElementById('metric-open'),
    metricClose: document.getElementById('metric-close'),
    toast: document.getElementById('toast'),

    // Modal Nova Instância
    modalNew: document.getElementById('modal-new'),
    formNewInstance: document.getElementById('form-new-instance'),
    btnSubmitNew: document.getElementById('btn-submit-new'),
    newNome: document.getElementById('new-nome'),
    newId: document.getElementById('new-id'),
    newTelefone: document.getElementById('new-telefone'),
    newEmail: document.getElementById('new-email'),

    // Modal Conexão
    modalConnect: document.getElementById('modal-connect'),
    connectSubtitle: document.getElementById('connect-instance-subtitle'),
    tabPairing: document.getElementById('tab-pairing'),
    tabQrcode: document.getElementById('tab-qrcode'),
    tabButtons: document.querySelectorAll('.tab-btn'),
    pairingNumber: document.getElementById('pairing-number'),
    btnRequestPairing: document.getElementById('btn-request-pairing'),
    pairingResultBox: document.getElementById('pairing-result-box'),
    pairingCodeDisplay: document.getElementById('pairing-code-display'),
    btnCopyPairing: document.getElementById('btn-copy-pairing'),
    qrcodeContainer: document.getElementById('qrcode-container'),
    btnRefreshQrcode: document.getElementById('btn-refresh-qrcode'),
    connectionStatusPill: document.getElementById('connection-status-pill'),
    connectionStatusText: document.getElementById('connection-status-text'),

    // Modal Configurações
    modalSettings: document.getElementById('modal-settings'),
    settingsSubtitle: document.getElementById('settings-instance-subtitle'),
    formSettings: document.getElementById('form-settings'),
    btnSaveSettings: document.getElementById('btn-save-settings'),
    settingRejectCall: document.getElementById('setting-rejectCall'),
    settingMsgCall: document.getElementById('setting-msgCall'),
    boxMsgCall: document.getElementById('box-msgCall'),
    settingGroupsIgnore: document.getElementById('setting-groupsIgnore'),
    settingAlwaysOnline: document.getElementById('setting-alwaysOnline'),
    settingReadMessages: document.getElementById('setting-readMessages'),
    settingReadStatus: document.getElementById('setting-readStatus'),
    settingSyncFullHistory: document.getElementById('setting-syncFullHistory')
  };

  // ---------------------------------------------------------------------------
  // UTILITÁRIOS
  // ---------------------------------------------------------------------------

  function showToast(message, type = 'success') {
    elements.toast.textContent = message;
    elements.toast.className = `toast toast-${type}`;
    elements.toast.classList.remove('hidden');

    setTimeout(() => {
      elements.toast.classList.add('hidden');
    }, 4000);
  }

  function openModal(modalEl) {
    modalEl.classList.remove('hidden');
  }

  function closeModal(modalEl) {
    modalEl.classList.add('hidden');
    if (modalEl === elements.modalConnect) {
      stopStatusPolling();
    }
  }

  function escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatDateTime(isoString) {
    if (!isoString) return '-';
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return isoString;
    }
  }

  function slugify(text) {
    return text
      .toString()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // ---------------------------------------------------------------------------
  // API CLIENT
  // ---------------------------------------------------------------------------

  async function api(path, options = {}) {
    const defaultHeaders = { 'Content-Type': 'application/json' };
    const res = await fetch(path, {
      ...options,
      headers: { ...defaultHeaders, ...(options.headers || {}) }
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Erro na requisição');
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // RENDERIZAÇÃO E DADOS
  // ---------------------------------------------------------------------------

  async function loadInstances() {
    elements.btnRefresh.disabled = true;
    try {
      const res = await api('/api/v1/instances');
      instances = res.data || [];
      renderMetrics();
      renderInstances();
    } catch (err) {
      showToast(`Falha ao carregar instâncias: ${err.message}`, 'error');
      elements.instancesTbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center py-8 text-danger">
            Não foi possível carregar as instâncias. Verifique a conexão com o servidor.
          </td>
        </tr>
      `;
    } finally {
      elements.btnRefresh.disabled = false;
    }
  }

  function renderMetrics() {
    const total = instances.length;
    const open = instances.filter(i => i.status === 'open').length;
    const close = total - open;

    elements.metricTotal.textContent = total;
    elements.metricOpen.textContent = open;
    elements.metricClose.textContent = close;
  }

  function renderInstances() {
    const term = (elements.searchInput.value || '').trim().toLowerCase();
    const filtered = instances.filter(i => {
      const name = (i.nome || '').toLowerCase();
      const id = (i.id || '').toLowerCase();
      const phone = (i.telefone || '').toLowerCase();
      return name.includes(term) || id.includes(term) || phone.includes(term);
    });

    if (filtered.length === 0) {
      elements.instancesTbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center py-8 text-muted">
            ${term ? 'Nenhuma instância encontrada para o filtro informado.' : 'Nenhuma instância cadastrada ainda. Clique em "Nova Instância" para começar.'}
          </td>
        </tr>
      `;
      return;
    }

    elements.instancesTbody.innerHTML = filtered.map(inst => {
      const statusClass = inst.status === 'open' ? 'badge-open' : (inst.status === 'connecting' ? 'badge-connecting' : 'badge-close');
      const statusLabel = inst.status === 'open' ? 'Conectado' : (inst.status === 'connecting' ? 'Conectando' : 'Desconectado');
      const avatarContent = inst.profilePicUrl
        ? `<img src="${escapeHtml(inst.profilePicUrl)}" alt="${escapeHtml(inst.nome)}">`
        : (inst.nome ? inst.nome.charAt(0).toUpperCase() : '?');

      return `
        <tr>
          <td>
            <div class="instance-name-wrapper">
              <div class="avatar">${avatarContent}</div>
              <div>
                <strong>${escapeHtml(inst.nome)}</strong>
                ${inst.email ? `<div class="text-muted text-sm">${escapeHtml(inst.email)}</div>` : ''}
              </div>
            </div>
          </td>
          <td><code>${escapeHtml(inst.id)}</code></td>
          <td>${inst.telefone ? escapeHtml(inst.telefone) : '<span class="text-muted">-</span>'}</td>
          <td>
            <span class="badge ${statusClass}">
              <span class="badge-dot"></span>
              ${statusLabel}
            </span>
          </td>
          <td class="text-muted text-sm">${formatDateTime(inst.criado_em)}</td>
          <td>
            <div class="cell-actions">
              ${inst.status !== 'open' ? `
                <button class="btn btn-sm btn-primary" onclick="window.AnneUI.openConnectModal('${escapeHtml(inst.id)}')">
                  Conectar
                </button>
              ` : `
                <button class="btn btn-sm btn-secondary" onclick="window.AnneUI.restartInstance('${escapeHtml(inst.id)}')">
                  Reiniciar
                </button>
              `}
              <button class="btn btn-sm btn-secondary" onclick="window.AnneUI.openSettingsModal('${escapeHtml(inst.id)}')">
                Opções
              </button>
              <button class="btn btn-sm btn-danger" onclick="window.AnneUI.deleteInstance('${escapeHtml(inst.id)}')">
                Excluir
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // NOVO CLIENTE / INSTÂNCIA
  // ---------------------------------------------------------------------------

  elements.btnNewInstance.addEventListener('click', () => {
    elements.formNewInstance.reset();
    openModal(elements.modalNew);
    elements.newNome.focus();
  });

  // Sugere ID automaticamente a partir do nome
  elements.newNome.addEventListener('input', () => {
    if (!elements.newId.dataset.edited) {
      elements.newId.value = slugify(elements.newNome.value);
    }
  });

  elements.newId.addEventListener('input', () => {
    elements.newId.dataset.edited = 'true';
  });

  elements.formNewInstance.addEventListener('submit', async (e) => {
    e.preventDefault();
    elements.btnSubmitNew.disabled = true;
    elements.btnSubmitNew.textContent = 'Salvando...';

    const payload = {
      nome: elements.newNome.value.trim(),
      id: elements.newId.value.trim(),
      telefone: elements.newTelefone.value.trim(),
      email: elements.newEmail.value.trim()
    };

    try {
      await api('/api/v1/instances', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      showToast(`Instância "${payload.nome}" criada com sucesso!`);
      closeModal(elements.modalNew);
      await loadInstances();

      // Abre automaticamente a tela de conexão
      window.AnneUI.openConnectModal(payload.id);
    } catch (err) {
      showToast(`Erro ao criar: ${err.message}`, 'error');
    } finally {
      elements.btnSubmitNew.disabled = false;
      elements.btnSubmitNew.textContent = 'Criar e Salvar';
    }
  });

  // ---------------------------------------------------------------------------
  // CONEXÃO WHATSAPP (PAIRING CODE & QR CODE)
  // ---------------------------------------------------------------------------

  function openConnectModal(instanceId) {
    const inst = instances.find(i => i.id === instanceId);
    currentConnectInstanceId = instanceId;

    elements.connectSubtitle.textContent = inst ? `${inst.nome} (${inst.id})` : instanceId;
    elements.pairingNumber.value = (inst && inst.telefone) ? inst.telefone.replace(/\D/g, '') : '';
    elements.pairingResultBox.classList.add('hidden');
    elements.pairingCodeDisplay.textContent = '--------';

    // Status inicial
    updateConnectionStatus(inst ? inst.status : 'close');

    // Abre primeira aba por padrão
    switchTab('tab-pairing');

    openModal(elements.modalConnect);
    startStatusPolling(instanceId);
  }

  function switchTab(tabId) {
    elements.tabButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });

    elements.tabPairing.classList.toggle('active', tabId === 'tab-pairing');
    elements.tabQrcode.classList.toggle('active', tabId === 'tab-qrcode');

    if (tabId === 'tab-qrcode' && currentConnectInstanceId) {
      loadQrCode(currentConnectInstanceId);
    }
  }

  elements.tabButtons.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Solicitar Pairing Code
  elements.btnRequestPairing.addEventListener('click', async () => {
    const rawNumber = elements.pairingNumber.value.trim();
    const cleanNumber = rawNumber.replace(/\D/g, '');

    if (!cleanNumber || cleanNumber.length < 10) {
      showToast('Digite um número de telefone válido com DDI e DDD.', 'error');
      elements.pairingNumber.focus();
      return;
    }

    elements.btnRequestPairing.disabled = true;
    elements.btnRequestPairing.textContent = 'Gerando...';

    try {
      const res = await api(`/api/v1/instances/${encodeURIComponent(currentConnectInstanceId)}/connect?number=${cleanNumber}`);
      if (res.data?.pairingCode) {
        elements.pairingCodeDisplay.textContent = res.data.pairingCode;
        elements.pairingResultBox.classList.remove('hidden');
        showToast('Código de pareamento gerado!');
      } else {
        throw new Error('Código de pareamento não retornado pelo WhatsApp.');
      }
    } catch (err) {
      showToast(`Falha ao gerar código: ${err.message}`, 'error');
    } finally {
      elements.btnRequestPairing.disabled = false;
      elements.btnRequestPairing.textContent = 'Gerar Código';
    }
  });

  // Copiar Pairing Code
  elements.btnCopyPairing.addEventListener('click', () => {
    const code = elements.pairingCodeDisplay.textContent;
    if (!code || code === '--------') return;

    navigator.clipboard.writeText(code).then(() => {
      elements.btnCopyPairing.textContent = 'Copiado!';
      setTimeout(() => { elements.btnCopyPairing.textContent = 'Copiar'; }, 2000);
    });
  });

  // Carregar QR Code
  async function loadQrCode(instanceId) {
    elements.qrcodeContainer.innerHTML = '<span>Carregando QR Code...</span>';
    try {
      const res = await api(`/api/v1/instances/${encodeURIComponent(instanceId)}/connect`);
      const qrData = res.data?.code;

      if (qrData) {
        const src = qrData.startsWith('data:image') ? qrData : `data:image/png;base64,${qrData}`;
        elements.qrcodeContainer.innerHTML = `<img src="${src}" alt="QR Code WhatsApp">`;
      } else {
        elements.qrcodeContainer.innerHTML = '<span class="text-muted">Aguardando geração do QR Code...</span>';
      }
    } catch (err) {
      elements.qrcodeContainer.innerHTML = `<span class="text-danger">Erro: ${escapeHtml(err.message)}</span>`;
    }
  }

  elements.btnRefreshQrcode.addEventListener('click', () => {
    if (currentConnectInstanceId) loadQrCode(currentConnectInstanceId);
  });

  // Polling de status durante a conexão
  function startStatusPolling(instanceId) {
    stopStatusPolling();
    pollStatusTimer = setInterval(async () => {
      try {
        const res = await api(`/api/v1/instances/${encodeURIComponent(instanceId)}/status`);
        updateConnectionStatus(res.state);

        if (res.state === 'open') {
          showToast('WhatsApp conectado com sucesso!');
          stopStatusPolling();
          await loadInstances();
          setTimeout(() => closeModal(elements.modalConnect), 1800);
        }
      } catch {
        // Ignora erros transitórios no polling
      }
    }, 3000);
  }

  function stopStatusPolling() {
    if (pollStatusTimer) {
      clearInterval(pollStatusTimer);
      pollStatusTimer = null;
    }
  }

  function updateConnectionStatus(state) {
    if (state === 'open') {
      elements.connectionStatusPill.className = 'status-pill status-pill-success';
      elements.connectionStatusText.textContent = 'Instância conectada e pronta para uso!';
    } else if (state === 'connecting') {
      elements.connectionStatusPill.className = 'status-pill status-pill-waiting';
      elements.connectionStatusText.textContent = 'Conectando ao WhatsApp...';
    } else {
      elements.connectionStatusPill.className = 'status-pill status-pill-waiting';
      elements.connectionStatusText.textContent = 'Aguardando validação no aplicativo do celular...';
    }
  }

  // ---------------------------------------------------------------------------
  // CONFIGURAÇÕES DA INSTÂNCIA (SETTINGS)
  // ---------------------------------------------------------------------------

  async function openSettingsModal(instanceId) {
    const inst = instances.find(i => i.id === instanceId);
    currentSettingsInstanceId = instanceId;

    elements.settingsSubtitle.textContent = inst ? `${inst.nome} (${inst.id})` : instanceId;
    elements.formSettings.reset();
    openModal(elements.modalSettings);

    try {
      const res = await api(`/api/v1/instances/${encodeURIComponent(instanceId)}/settings`);
      const s = res.settings || {};

      elements.settingRejectCall.checked = Boolean(s.rejectCall);
      elements.settingMsgCall.value = s.msgCall || '';
      elements.settingGroupsIgnore.checked = Boolean(s.groupsIgnore);
      elements.settingAlwaysOnline.checked = Boolean(s.alwaysOnline);
      elements.settingReadMessages.checked = Boolean(s.readMessages);
      elements.settingReadStatus.checked = Boolean(s.readStatus);
      elements.settingSyncFullHistory.checked = Boolean(s.syncFullHistory);

      toggleMsgCallVisibility();
    } catch (err) {
      showToast(`Falha ao ler opções: ${err.message}`, 'error');
    }
  }

  function toggleMsgCallVisibility() {
    if (elements.settingRejectCall.checked) {
      elements.boxMsgCall.classList.remove('hidden');
    } else {
      elements.boxMsgCall.classList.add('hidden');
    }
  }

  elements.settingRejectCall.addEventListener('change', toggleMsgCallVisibility);

  elements.formSettings.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentSettingsInstanceId) return;

    elements.btnSaveSettings.disabled = true;
    elements.btnSaveSettings.textContent = 'Salvando...';

    const payload = {
      rejectCall: elements.settingRejectCall.checked,
      msgCall: elements.settingMsgCall.value.trim(),
      groupsIgnore: elements.settingGroupsIgnore.checked,
      alwaysOnline: elements.settingAlwaysOnline.checked,
      readMessages: elements.settingReadMessages.checked,
      readStatus: elements.settingReadStatus.checked,
      syncFullHistory: elements.settingSyncFullHistory.checked
    };

    try {
      await api(`/api/v1/instances/${encodeURIComponent(currentSettingsInstanceId)}/settings`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      showToast('Configurações salvas com sucesso!');
      closeModal(elements.modalSettings);
      await loadInstances();
    } catch (err) {
      showToast(`Erro ao salvar opções: ${err.message}`, 'error');
    } finally {
      elements.btnSaveSettings.disabled = false;
      elements.btnSaveSettings.textContent = 'Salvar Alterações';
    }
  });

  // ---------------------------------------------------------------------------
  // AÇÕES RÁPIDAS (RESTART & DELETE)
  // ---------------------------------------------------------------------------

  async function restartInstance(instanceId) {
    try {
      showToast(`Reiniciando conexão da instância ${instanceId}...`);
      await api(`/api/v1/instances/${encodeURIComponent(instanceId)}/restart`, { method: 'POST' });
      showToast(`Instância ${instanceId} reiniciada com sucesso.`);
      await loadInstances();
    } catch (err) {
      showToast(`Falha ao reiniciar: ${err.message}`, 'error');
    }
  }

  async function deleteInstance(instanceId) {
    const inst = instances.find(i => i.id === instanceId);
    const name = inst ? inst.nome : instanceId;

    const confirmed = window.confirm(
      `Deseja realmente excluir a instância "${name}"?\nEsta ação desconectará o WhatsApp e removerá o cadastro no banco.`
    );
    if (!confirmed) return;

    try {
      await api(`/api/v1/instances/${encodeURIComponent(instanceId)}`, { method: 'DELETE' });
      showToast(`Instância "${name}" excluída.`);
      await loadInstances();
    } catch (err) {
      showToast(`Erro ao excluir: ${err.message}`, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // EVENT LISTENERS GERAIS
  // ---------------------------------------------------------------------------

  // Fechar modais pelos botões data-close
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-close');
      const targetEl = document.getElementById(targetId);
      if (targetEl) closeModal(targetEl);
    });
  });

  // Fechar modais ao clicar no backdrop escuro
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal(backdrop);
    });
  });

  // Fechar no Esc
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach(closeModal);
    }
  });

  elements.searchInput.addEventListener('input', renderInstances);
  elements.btnRefresh.addEventListener('click', loadInstances);

  // Expõe métodos para chamadas inline nos botões da tabela
  window.AnneUI = {
    openConnectModal,
    openSettingsModal,
    restartInstance,
    deleteInstance
  };

  // Inicialização
  loadInstances();
})();
