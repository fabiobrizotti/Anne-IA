// Anne-IA Dashboard — Lógica de Interface Vanilla
(() => {
  'use strict';

  // Estado da aplicação
  let instances = [];
  let currentConnectInstanceId = null;
  let currentSettingsInstanceId = null;
  let currentFichaInstanceId = null;
  let pollStatusTimer = null;
  let currentFinancePeriod = 30;
  let financeData = null;
  let financeDailyTableView = false;
  let activePageTab = 'tab-instancias';

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
    lastSyncTime: document.getElementById('last-sync-time'),

    // Modal Nova Instância
    modalNew: document.getElementById('modal-new'),
    formNewInstance: document.getElementById('form-new-instance'),
    btnSubmitNew: document.getElementById('btn-submit-new'),
    newNome: document.getElementById('new-nome'),
    newId: document.getElementById('new-id'),
    newTelefone: document.getElementById('new-telefone'),
    newEmail: document.getElementById('new-email'),

    // Modal Ficha do Cliente / Instância
    modalFicha: document.getElementById('modal-ficha'),
    formFicha: document.getElementById('form-ficha'),
    fichaTitle: document.getElementById('ficha-title'),
    fichaStatusBadge: document.getElementById('ficha-status-badge'),
    fichaId: document.getElementById('ficha-id'),
    btnCopyFichaId: document.getElementById('btn-copy-ficha-id'),
    fichaCriadoEm: document.getElementById('ficha-criado-em'),
    fichaAtualizadoEm: document.getElementById('ficha-atualizado-em'),
    fichaNome: document.getElementById('ficha-nome'),
    fichaEmail: document.getElementById('ficha-email'),
    fichaAtivo: document.getElementById('ficha-ativo'),
    fichaTelefone: document.getElementById('ficha-telefone'),
    fichaMotivo: document.getElementById('ficha-motivo'),
    btnFichaConnect: document.getElementById('btn-ficha-connect'),
    fichaHistoryList: document.getElementById('ficha-history-list'),
    btnSaveFicha: document.getElementById('btn-save-ficha'),
    promptIdentity: document.getElementById('prompt-identity'),
    promptRole: document.getElementById('prompt-role'),
    promptPersonality: document.getElementById('prompt-personality'),
    promptPlaybook: document.getElementById('prompt-playbook'),
    promptTools: document.getElementById('prompt-tools'),
    promptLocale: document.getElementById('prompt-locale'),
    promptEscalationChannel: document.getElementById('prompt-escalation-channel'),
    promptEscalationTarget: document.getElementById('prompt-escalation-target'),
    promptEscalationPolicy: document.getElementById('prompt-escalation-policy'),
    promptSystem: document.getElementById('prompt-system'),
    promptFatiamento: document.getElementById('prompt-fatiamento'),

    // Modal Conexão
    modalConnect: document.getElementById('modal-connect'),
    connectSubtitle: document.getElementById('connect-instance-subtitle'),
    tabPairing: document.getElementById('tab-pairing'),
    tabQrcode: document.getElementById('tab-qrcode'),
    tabButtons: document.querySelectorAll('#modal-connect .tab-btn'),
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
    settingSyncFullHistory: document.getElementById('setting-syncFullHistory'),

    // Elementos da Aba Financeiro
    pageTabs: document.querySelectorAll('.page-tab'),
    pageContents: document.querySelectorAll('.page-content'),
    pillBtns: document.querySelectorAll('.pill-btn'),
    kpiCusto: document.getElementById('kpi-custo'),
    kpiCustoDelta: document.getElementById('kpi-custo-delta'),
    kpiRequisicoes: document.getElementById('kpi-requisicoes'),
    kpiReqsDelta: document.getElementById('kpi-reqs-delta'),
    kpiTokens: document.getElementById('kpi-tokens'),
    kpiTokensDelta: document.getElementById('kpi-tokens-delta'),
    kpiTokensSplit: document.getElementById('kpi-tokens-split'),
    kpiCacheRate: document.getElementById('kpi-cache-rate'),
    kpiCustoMedio: document.getElementById('kpi-custo-medio'),
    dailyChartContainer: document.getElementById('finance-daily-chart-container'),
    dailyTableContainer: document.getElementById('finance-daily-table-container'),
    dailyTbody: document.getElementById('finance-daily-tbody'),
    btnToggleDailyView: document.getElementById('btn-toggle-daily-view'),
    clientChartContainer: document.getElementById('finance-client-chart-container'),
    modelChartContainer: document.getElementById('finance-model-chart-container'),
    financeClientsTbody: document.getElementById('finance-clients-tbody'),
    financeSearchInput: document.getElementById('finance-search-input')
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
    if (!modalEl) return;
    modalEl.classList.remove('hidden');
  }

  function closeModal(modalEl) {
    if (!modalEl) return;
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
      if (isNaN(d.getTime())) return isoString;
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

      if (elements.lastSyncTime) {
        elements.lastSyncTime.textContent = `Atualizado em: ${new Date().toLocaleTimeString('pt-BR')}`;
      }
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
                ${inst.email ? `<div class="text-muted text-xs">${escapeHtml(inst.email)}</div>` : ''}
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
          <td class="text-muted text-xs">${formatDateTime(inst.atualizado_em || inst.criado_em)}</td>
          <td>
            <div class="cell-actions">
              <button class="btn btn-sm btn-secondary" onclick="window.AnneUI.openFichaModal('${escapeHtml(inst.id)}')">
                Ficha
              </button>
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
      openConnectModal(payload.id);
    } catch (err) {
      showToast(`Erro ao criar: ${err.message}`, 'error');
    } finally {
      elements.btnSubmitNew.disabled = false;
      elements.btnSubmitNew.textContent = 'Criar e Salvar';
    }
  });

  // ---------------------------------------------------------------------------
  // FICHA DO CLIENTE / INSTÂNCIA
  // ---------------------------------------------------------------------------

  function openFichaModal(instanceId) {
    const inst = instances.find(i => i.id === instanceId);
    if (!inst) {
      showToast('Instância não encontrada.', 'error');
      return;
    }

    currentFichaInstanceId = inst.id;
    elements.fichaTitle.textContent = `Ficha: ${inst.nome || inst.id}`;
    elements.fichaId.textContent = inst.id;
    elements.fichaNome.value = inst.nome || '';
    elements.fichaEmail.value = inst.email || '';
    elements.fichaAtivo.checked = inst.ativo !== false;
    elements.fichaTelefone.value = inst.telefone || '';
    elements.fichaMotivo.value = '';

    elements.fichaCriadoEm.textContent = formatDateTime(inst.criado_em);
    elements.fichaAtualizadoEm.textContent = formatDateTime(inst.atualizado_em);

    const statusClass = inst.status === 'open' ? 'badge-open' : (inst.status === 'connecting' ? 'badge-connecting' : 'badge-close');
    const statusLabel = inst.status === 'open' ? 'Conectado' : (inst.status === 'connecting' ? 'Conectando' : 'Desconectado');
    elements.fichaStatusBadge.className = `badge ${statusClass}`;
    elements.fichaStatusBadge.innerHTML = `<span class="badge-dot"></span>${statusLabel}`;

    renderFichaHistory(inst.historico_telefones || []);
    resetPromptFields();
    loadPromptConfig(inst.id);
    openModal(elements.modalFicha);
  }

  function resetPromptFields() {
    elements.promptIdentity.value = '';
    elements.promptRole.value = '';
    elements.promptPersonality.value = '';
    elements.promptPlaybook.value = '';
    elements.promptTools.value = '';
    elements.promptLocale.value = 'pt-BR';
    elements.promptEscalationChannel.value = '';
    elements.promptEscalationTarget.value = '';
    elements.promptEscalationPolicy.value = '';
    elements.promptSystem.value = '';
    elements.promptFatiamento.value = '';
  }

  async function loadPromptConfig(instanceId) {
    try {
      const data = await api(`/api/v1/instances/${encodeURIComponent(instanceId)}/prompt`);
      const p = data.prompt || {};
      elements.promptIdentity.value = p.identity || '';
      elements.promptRole.value = p.role || '';
      elements.promptPersonality.value = p.personality || '';
      elements.promptPlaybook.value = p.playbook || '';
      elements.promptTools.value = p.tools || '';
      elements.promptLocale.value = p.locale || 'pt-BR';
      elements.promptEscalationChannel.value = p.escalation_channel || '';
      elements.promptEscalationTarget.value = p.escalation_target || '';
      elements.promptEscalationPolicy.value = p.escalation_policy || '';
      elements.promptSystem.value = p.system_prompt || '';
      elements.promptFatiamento.value = p.fatiamento_override || '';
    } catch (err) {
      // Sem linha de prompt ainda — mantém defaults do formulário.
      console.warn('[prompt] Configuração de prompt indisponível:', err.message);
    }
  }

  function renderFichaHistory(history) {
    if (!history || history.length === 0) {
      elements.fichaHistoryList.innerHTML = '<p class="text-muted text-xs">Nenhum histórico de número registrado ainda.</p>';
      return;
    }

    const sorted = [...history].reverse();
    elements.fichaHistoryList.innerHTML = sorted.map(item => `
      <div class="history-item">
        <div>
          <span class="history-phone">${escapeHtml(item.telefone || '-')}</span>
          <span class="text-muted text-xs"> — ${escapeHtml(item.motivo || 'Cadastro')}</span>
        </div>
        <span class="history-date">${formatDateTime(item.data)}</span>
      </div>
    `).join('');
  }

  elements.btnCopyFichaId.addEventListener('click', () => {
    if (elements.fichaId.textContent) {
      navigator.clipboard.writeText(elements.fichaId.textContent).then(() => {
        showToast('ID da instância copiado!');
      });
    }
  });

  elements.btnFichaConnect.addEventListener('click', () => {
    if (!currentFichaInstanceId) return;
    const phone = elements.fichaTelefone.value.trim();
    closeModal(elements.modalFicha);
    openConnectModal(currentFichaInstanceId, phone);
  });

  elements.formFicha.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentFichaInstanceId) return;

    elements.btnSaveFicha.disabled = true;
    elements.btnSaveFicha.textContent = 'Salvando...';

    const payload = {
      nome: elements.fichaNome.value.trim(),
      email: elements.fichaEmail.value.trim(),
      ativo: elements.fichaAtivo.checked,
      telefone: elements.fichaTelefone.value.trim(),
      motivoTroca: elements.fichaMotivo.value.trim()
    };

    try {
      await api(`/api/v1/instances/${encodeURIComponent(currentFichaInstanceId)}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });

      await api(`/api/v1/instances/${encodeURIComponent(currentFichaInstanceId)}/prompt`, {
        method: 'PUT',
        body: JSON.stringify({
          identity: elements.promptIdentity.value,
          role: elements.promptRole.value,
          personality: elements.promptPersonality.value,
          playbook: elements.promptPlaybook.value,
          tools: elements.promptTools.value,
          locale: elements.promptLocale.value,
          escalation_channel: elements.promptEscalationChannel.value,
          escalation_target: elements.promptEscalationTarget.value,
          escalation_policy: elements.promptEscalationPolicy.value,
          system_prompt: elements.promptSystem.value,
          fatiamento_override: elements.promptFatiamento.value
        })
      });

      showToast('Ficha do cliente salva com sucesso!');
      closeModal(elements.modalFicha);
      await loadInstances();
    } catch (err) {
      showToast(`Erro ao salvar ficha: ${err.message}`, 'error');
    } finally {
      elements.btnSaveFicha.disabled = false;
      elements.btnSaveFicha.textContent = 'Salvar Ficha';
    }
  });

  // ---------------------------------------------------------------------------
  // CONEXÃO WHATSAPP (PAIRING CODE & QR CODE)
  // ---------------------------------------------------------------------------

  function openConnectModal(instanceId, phoneOverride) {
    const inst = instances.find(i => i.id === instanceId);
    currentConnectInstanceId = instanceId;

    elements.connectSubtitle.textContent = inst ? `${inst.nome} (${inst.id})` : instanceId;
    const phoneToUse = phoneOverride !== undefined ? phoneOverride : (inst && inst.telefone ? inst.telefone : '');
    elements.pairingNumber.value = phoneToUse ? phoneToUse.replace(/\D/g, '') : '';
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

  // Carregar QR Code com prioridade em base64
  async function loadQrCode(instanceId) {
    elements.qrcodeContainer.innerHTML = '<span>Carregando QR Code...</span>';
    try {
      const res = await api(`/api/v1/instances/${encodeURIComponent(instanceId)}/connect`);
      const base64 = res.data?.base64;
      const code = res.data?.code;

      if (base64) {
        const src = base64.startsWith('data:image') ? base64 : `data:image/png;base64,${base64}`;
        elements.qrcodeContainer.innerHTML = `<img src="${src}" alt="QR Code WhatsApp">`;
      } else if (code) {
        elements.qrcodeContainer.innerHTML = `
          <div style="padding: 12px; text-align: center;">
            <p class="text-xs text-muted mb-2">Código Baileys recebido:</p>
            <code style="word-break: break-all; font-size: 11px;">${escapeHtml(code)}</code>
          </div>
        `;
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

  // ---------------------------------------------------------------------------
  // NAVEGAÇÃO DE PÁGINAS / ABAS PRINCIPAIS
  // ---------------------------------------------------------------------------

  function switchPageTab(targetTabId) {
    activePageTab = targetTabId;
    elements.pageTabs.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.pageTab === targetTabId);
    });

    elements.pageContents.forEach(content => {
      content.classList.toggle('active', content.id === targetTabId);
    });

    if (targetTabId === 'tab-financeiro') {
      loadFinanceData();
    }
  }

  elements.pageTabs.forEach(btn => {
    btn.addEventListener('click', () => switchPageTab(btn.dataset.pageTab));
  });

  // Filtro de período (7d / 30d / 90d)
  elements.pillBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const period = parseInt(btn.dataset.period, 10);
      if (period === currentFinancePeriod) return;
      currentFinancePeriod = period;
      elements.pillBtns.forEach(b => b.classList.toggle('active', b === btn));
      loadFinanceData();
    });
  });

  // Alternador de visão diária: Gráfico vs Tabela
  if (elements.btnToggleDailyView) {
    elements.btnToggleDailyView.addEventListener('click', () => {
      financeDailyTableView = !financeDailyTableView;
      elements.dailyChartContainer.classList.toggle('hidden', financeDailyTableView);
      elements.dailyTableContainer.classList.toggle('hidden', !financeDailyTableView);
      elements.btnToggleDailyView.textContent = financeDailyTableView ? 'Ver em Gráfico' : 'Ver em Tabela';
    });
  }

  // ---------------------------------------------------------------------------
  // DASHBOARD FINANCEIRO: CARREGAMENTO E RENDERIZAÇÃO
  // ---------------------------------------------------------------------------

  async function loadFinanceData() {
    try {
      const res = await api(`/api/v1/financeiro?dias=${currentFinancePeriod}`);
      financeData = res.data || {};
      renderFinanceDashboard();
    } catch (err) {
      console.error('[finance] Erro ao carregar dados:', err);
      showToast(`Falha ao carregar dados financeiros: ${err.message}`, 'error');
    }
  }

  function renderFinanceDashboard() {
    if (!financeData) return;
    const { kpis = {}, kpis_anteriores = {}, serie_diaria = [], por_cliente = [], por_modelo = [] } = financeData;

    renderKPIs(kpis, kpis_anteriores);
    renderDailyAreaChart(serie_diaria);
    renderDailyTable(serie_diaria);
    renderClientRanking(por_cliente);
    renderModelRanking(por_modelo);
    renderFinanceClientsTable(por_cliente);
  }

  function formatDelta(current, prev, isCurrency = false) {
    if (!prev || prev === 0) {
      return { text: current > 0 ? '+100%' : '0%', class: 'neutral' };
    }
    const diff = current - prev;
    const pct = ((diff / prev) * 100).toFixed(1);
    if (diff > 0) {
      return { text: `+${pct}%`, class: 'up' };
    } else if (diff < 0) {
      return { text: `${pct}%`, class: 'down' };
    }
    return { text: '0%', class: 'neutral' };
  }

  function renderKPIs(kpis, kpisPrev) {
    const custo = Number(kpis.custo_usd || 0);
    const prevCusto = Number(kpisPrev.custo_usd || 0);
    const reqs = Number(kpis.requisicoes || 0);
    const prevReqs = Number(kpisPrev.requisicoes || 0);
    const tokens = Number(kpis.tokens_total || 0);
    const prevTokens = Number(kpisPrev.tokens_total || 0);

    const deltaCusto = formatDelta(custo, prevCusto);
    const deltaReqs = formatDelta(reqs, prevReqs);
    const deltaTokens = formatDelta(tokens, prevTokens);

    elements.kpiCusto.textContent = `$${custo.toFixed(4)}`;
    elements.kpiCustoDelta.textContent = deltaCusto.text;
    elements.kpiCustoDelta.className = `delta-badge ${deltaCusto.class}`;

    elements.kpiRequisicoes.textContent = reqs.toLocaleString('pt-BR');
    elements.kpiReqsDelta.textContent = deltaReqs.text;
    elements.kpiReqsDelta.className = `delta-badge ${deltaReqs.class}`;

    elements.kpiTokens.textContent = tokens.toLocaleString('pt-BR');
    elements.kpiTokensDelta.textContent = deltaTokens.text;
    elements.kpiTokensDelta.className = `delta-badge ${deltaTokens.class}`;

    const promptT = Number(kpis.tokens_prompt || 0);
    const compT = Number(kpis.tokens_completion || 0);
    elements.kpiTokensSplit.textContent = `${promptT.toLocaleString('pt-BR')} prompt / ${compT.toLocaleString('pt-BR')} completion`;

    elements.kpiCacheRate.textContent = `${Number(kpis.cache_rate || 0).toFixed(1)}%`;
    elements.kpiCustoMedio.textContent = `Custo médio: $${Number(kpis.custo_medio_requisicao || 0).toFixed(6)} / req`;
  }

  // Gráfico Diário de Área em SVG Puro
  function renderDailyAreaChart(series) {
    const container = elements.dailyChartContainer;
    if (!container) return;

    if (!series || series.length === 0 || series.every(s => s.custo_usd === 0)) {
      container.innerHTML = `
        <div class="empty-state">
          <svg class="empty-state-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
          <p class="text-xs">Nenhum custo registrado nos últimos ${currentFinancePeriod} dias.</p>
        </div>
      `;
      return;
    }

    const width = container.clientWidth || 800;
    const height = 240;
    const padding = { top: 20, right: 20, bottom: 30, left: 60 };
    const innerW = width - padding.left - padding.right;
    const innerH = height - padding.top - padding.bottom;

    const maxVal = Math.max(...series.map(s => s.custo_usd), 0.001);
    const points = series.map((s, idx) => {
      const x = padding.left + (idx / (series.length - 1 || 1)) * innerW;
      const y = padding.top + innerH - (s.custo_usd / maxVal) * innerH;
      return { x, y, ...s };
    });

    const pathLine = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const pathArea = `${pathLine} L ${padding.left + innerW} ${padding.top + innerH} L ${padding.left} ${padding.top + innerH} Z`;

    // Linhas de grade e ticks do eixo Y (4 linhas)
    const yTicks = [0, 0.33, 0.66, 1].map(frac => {
      const y = padding.top + innerH - frac * innerH;
      const val = (frac * maxVal).toFixed(4);
      return `
        <line class="chart-gridline" x1="${padding.left}" y1="${y}" x2="${padding.left + innerW}" y2="${y}" />
        <text class="chart-axis-text" x="${padding.left - 8}" y="${y + 3}" text-anchor="end">$${val}</text>
      `;
    }).join('');

    // Rótulos do eixo X (amostras com espaçamento)
    const step = Math.ceil(series.length / 7);
    const xLabels = points.filter((_, idx) => idx % step === 0 || idx === points.length - 1).map(p => {
      const parts = p.dia.split('-');
      const label = `${parts[2]}/${parts[1]}`;
      return `
        <text class="chart-axis-text" x="${p.x}" y="${height - 10}" text-anchor="middle">${label}</text>
      `;
    }).join('');

    container.innerHTML = `
      <svg class="svg-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        ${yTicks}
        <path class="chart-area" d="${pathArea}" />
        <path class="chart-line" d="${pathLine}" />
        ${points.map(p => `
          <circle class="chart-point" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" data-dia="${p.dia}" data-custo="${p.custo_usd}">
            <title>${p.dia}: $${p.custo_usd.toFixed(6)} (${p.tokens.toLocaleString('pt-BR')} tokens, ${p.requisicoes} reqs)</title>
          </circle>
        `).join('')}
        ${xLabels}
      </svg>
    `;
  }

  function renderDailyTable(series) {
    if (!elements.dailyTbody) return;
    if (!series || series.length === 0) {
      elements.dailyTbody.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-muted">Sem dados.</td></tr>';
      return;
    }

    elements.dailyTbody.innerHTML = [...series].reverse().map(s => `
      <tr>
        <td><code>${s.dia}</code></td>
        <td>$${s.custo_usd.toFixed(6)}</td>
        <td>${s.tokens.toLocaleString('pt-BR')}</td>
        <td class="text-right">${s.requisicoes.toLocaleString('pt-BR')}</td>
      </tr>
    `).join('');
  }

  // Gráfico de Barras Horizontais: Custo por Cliente
  function renderClientRanking(clients) {
    const container = elements.clientChartContainer;
    if (!container) return;

    const top = (clients || []).slice(0, 5);
    if (top.length === 0 || top.every(c => c.custo_usd === 0)) {
      container.innerHTML = `
        <div class="empty-state">
          <p class="text-xs">Nenhum custo por cliente registrado no período.</p>
        </div>
      `;
      return;
    }

    const maxVal = Math.max(...top.map(c => c.custo_usd), 0.0001);
    const barHeight = 20;
    const gap = 14;
    const height = top.length * (barHeight + gap) + 10;

    container.innerHTML = `
      <svg class="svg-chart" viewBox="0 0 400 ${height}" style="height: ${height}px;">
        ${top.map((c, i) => {
          const y = i * (barHeight + gap) + 5;
          const w = Math.max(4, Math.min(260, (c.custo_usd / maxVal) * 260));
          const nomeTrunc = (c.nome || c.cliente_id).slice(0, 16);
          return `
            <text class="chart-bar-label" x="0" y="${y + 14}">${escapeHtml(nomeTrunc)}</text>
            <rect class="chart-bar-bg" x="110" y="${y}" width="260" height="${barHeight}" />
            <rect class="chart-bar-rect" x="110" y="${y}" width="${w}" height="${barHeight}">
              <title>${escapeHtml(c.nome)}: $${c.custo_usd.toFixed(6)}</title>
            </rect>
            <text class="chart-bar-val" x="380" y="${y + 14}" text-anchor="end">$${c.custo_usd.toFixed(4)}</text>
          `;
        }).join('')}
      </svg>
    `;
  }

  // Gráfico de Barras Horizontais: Tokens por Modelo
  function renderModelRanking(models) {
    const container = elements.modelChartContainer;
    if (!container) return;

    const top = (models || []).slice(0, 5);
    if (top.length === 0 || top.every(m => m.tokens === 0)) {
      container.innerHTML = `
        <div class="empty-state">
          <p class="text-xs">Nenhum consumo por modelo registrado no período.</p>
        </div>
      `;
      return;
    }

    const maxVal = Math.max(...top.map(m => m.tokens), 1);
    const barHeight = 20;
    const gap = 14;
    const height = top.length * (barHeight + gap) + 10;

    container.innerHTML = `
      <svg class="svg-chart" viewBox="0 0 400 ${height}" style="height: ${height}px;">
        ${top.map((m, i) => {
          const y = i * (barHeight + gap) + 5;
          const w = Math.max(4, Math.min(250, (m.tokens / maxVal) * 250));
          const label = m.modelo.slice(0, 15);
          return `
            <text class="chart-bar-label" x="0" y="${y + 14}">${escapeHtml(label)}</text>
            <rect class="chart-bar-bg" x="110" y="${y}" width="250" height="${barHeight}" />
            <rect class="chart-bar-rect" x="110" y="${y}" width="${w}" height="${barHeight}">
              <title>${escapeHtml(m.provedor)} / ${escapeHtml(m.modelo)}: ${m.tokens.toLocaleString('pt-BR')} tokens</title>
            </rect>
            <text class="chart-bar-val" x="390" y="${y + 14}" text-anchor="end">${m.tokens.toLocaleString('pt-BR')}</text>
          `;
        }).join('')}
      </svg>
    `;
  }

  // Tabela Detalhada por Cliente (Data Table)
  function renderFinanceClientsTable(clients) {
    if (!elements.financeClientsTbody) return;

    const term = (elements.financeSearchInput?.value || '').trim().toLowerCase();
    const filtered = (clients || []).filter(c => {
      const nome = (c.nome || '').toLowerCase();
      const id = (c.cliente_id || '').toLowerCase();
      return nome.includes(term) || id.includes(term);
    });

    if (filtered.length === 0) {
      elements.financeClientsTbody.innerHTML = `
        <tr>
          <td colspan="5" class="text-center py-8 text-muted">
            ${term ? 'Nenhum cliente encontrado para o filtro.' : 'Nenhum registro de uso de tokens encontrado.'}
          </td>
        </tr>
      `;
      return;
    }

    elements.financeClientsTbody.innerHTML = filtered.map(c => `
      <tr>
        <td>
          <strong>${escapeHtml(c.nome)}</strong>
          <div class="text-muted text-xs"><code>${escapeHtml(c.cliente_id)}</code></div>
        </td>
        <td>${c.requisicoes.toLocaleString('pt-BR')}</td>
        <td>${c.tokens.toLocaleString('pt-BR')}</td>
        <td>${c.cache_rate.toFixed(1)}%</td>
        <td class="text-right font-bold">$${c.custo_usd.toFixed(6)}</td>
      </tr>
    `).join('');
  }

  if (elements.financeSearchInput) {
    elements.financeSearchInput.addEventListener('input', () => {
      if (financeData?.por_cliente) {
        renderFinanceClientsTable(financeData.por_cliente);
      }
    });
  }

  // Redimensionamento responsivo do gráfico diário
  window.addEventListener('resize', () => {
    if (activePageTab === 'tab-financeiro' && financeData?.serie_diaria) {
      renderDailyAreaChart(financeData.serie_diaria);
    }
  });

  // Fechar no Esc
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach(closeModal);
    }
  });

  elements.searchInput.addEventListener('input', renderInstances);
  elements.btnRefresh.addEventListener('click', () => {
    loadInstances();
    if (activePageTab === 'tab-financeiro') {
      loadFinanceData();
    }
  });

  // Expõe métodos para chamadas inline nos botões da tabela
  window.AnneUI = {
    openFichaModal,
    openConnectModal,
    openSettingsModal,
    restartInstance,
    deleteInstance
  };

  // Inicialização
  loadInstances();
})();
