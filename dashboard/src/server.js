const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://evolution-api:8080';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

// Pool PostgreSQL
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL });
  pool.on('error', (err) => {
    console.error('[db] Erro inesperado no pool do Postgres:', err.message);
  });
} else {
  console.error('[db] DATABASE_URL não configurada. Schema deve ser provisionado por setup/postgres/init.sql.');
}

// Middlewares
app.use(express.json());

// Autenticação Basic Auth opcional
const authEnabled = process.env.DASHBOARD_AUTH_ENABLED === 'true';
const authUser = process.env.DASHBOARD_USERNAME || 'admin';
const authPass = process.env.DASHBOARD_PASSWORD || '';

if (authEnabled && authPass) {
  app.use((req, res, next) => {
    // Libera healthcheck sem autenticação
    if (req.path === '/api/health') return next();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Painel Anne-IA"');
      return res.status(401).send('Acesso não autorizado.');
    }

    const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('ascii');
    const [user, pass] = credentials.split(':');

    if (user === authUser && pass === authPass) {
      return next();
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="Painel Anne-IA"');
    return res.status(401).send('Credenciais inválidas.');
  });
}

// Arquivos estáticos da interface Vanilla
app.use(express.static(path.join(__dirname, '../public')));

// Helper de requisição para a Evolution API
async function evolutionFetch(endpoint, options = {}) {
  const url = `${EVOLUTION_API_URL}${endpoint}`;
  const headers = {
    'apikey': EVOLUTION_API_KEY,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  try {
    const res = await fetch(url, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    console.error(`[evolution-api] Falha ao chamar ${endpoint}:`, err.message);
    return { status: 502, ok: false, data: { error: 'Evolution API indisponível no momento' } };
  }
}

// -----------------------------------------------------------------------------
// ROTAS DA API REST (v1)
// -----------------------------------------------------------------------------

// Healthcheck
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 1. Listar Instâncias e Clientes
app.get('/api/v1/instances', async (req, res) => {
  try {
    let dbClients = [];
    if (pool) {
      const clientRes = await pool.query('SELECT * FROM clientes ORDER BY criado_em DESC');
      dbClients = clientRes.rows;
    }

    // Busca instâncias ativas na Evolution API
    const evoRes = await evolutionFetch('/instance/fetchInstances');
    const evoInstances = Array.isArray(evoRes.data) ? evoRes.data : [];

    // Mapeamento das instâncias por nome
    const evoMap = new Map();
    evoInstances.forEach((inst) => {
      const name = inst.name || inst.instance?.name || inst.instanceName;
      if (name) evoMap.set(name, inst);
    });

    // Mescla dados do banco com status em tempo real da Evolution
    const merged = dbClients.map((c) => {
      const evo = evoMap.get(c.id);
      let status = 'close';
      let profilePicUrl = null;
      let ownerJid = null;

      if (evo) {
        status = evo.connectionStatus || evo.instance?.status || evo.status || 'close';
        profilePicUrl = evo.profilePicUrl || evo.instance?.profilePicUrl || null;
        ownerJid = evo.ownerJid || evo.instance?.ownerJid || null;
        evoMap.delete(c.id);
      }

      return {
        id: c.id,
        nome: c.nome,
        telefone: c.telefone || (ownerJid ? ownerJid.split('@')[0] : ''),
        email: c.email,
        ativo: c.ativo,
        configuracoes: c.configuracoes || {},
        historico_telefones: Array.isArray(c.historico_telefones) ? c.historico_telefones : [],
        status,
        profilePicUrl,
        criado_em: c.criado_em,
        atualizado_em: c.atualizado_em
      };
    });

    // Adiciona instâncias que possam existir na Evolution API mas não no banco
    for (const [name, evo] of evoMap.entries()) {
      merged.push({
        id: name,
        nome: name,
        telefone: evo.ownerJid ? evo.ownerJid.split('@')[0] : '',
        email: '',
        ativo: true,
        configuracoes: {},
        historico_telefones: [],
        status: evo.connectionStatus || evo.instance?.status || evo.status || 'close',
        profilePicUrl: evo.profilePicUrl || evo.instance?.profilePicUrl || null,
        criado_em: evo.createdAt || new Date().toISOString(),
        atualizado_em: evo.updatedAt || new Date().toISOString(),
        aviso: 'Instância encontrada apenas na Evolution API'
      });
    }

    res.json({ success: true, data: merged });
  } catch (err) {
    console.error('[api] Erro ao listar instâncias:', err);
    res.status(500).json({ success: false, error: 'Falha ao carregar lista de instâncias' });
  }
});

// 2. Criar Nova Instância e Cliente
app.post('/api/v1/instances', async (req, res) => {
  try {
    const { id, nome, telefone, email, settings = {} } = req.body;

    if (!id || !nome) {
      return res.status(400).json({ success: false, error: 'ID da instância e Nome são obrigatórios' });
    }

    // Higieniza ID (apenas letras, números, traços e underscores)
    const cleanId = id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');

    // 1. Cria na Evolution API
    const createRes = await evolutionFetch('/instance/create', {
      method: 'POST',
      body: JSON.stringify({
        instanceName: cleanId,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        number: telefone ? telefone.replace(/\D/g, '') : undefined
      })
    });

    if (!createRes.ok && createRes.status !== 403) {
      const msg = createRes.data?.response?.message?.[0] || createRes.data?.error || 'Erro ao criar na Evolution API';
      return res.status(createRes.status).json({ success: false, error: msg });
    }

    // 2. Aplica configurações iniciais na Evolution API se fornecidas
    const defaultSettings = {
      rejectCall: settings.rejectCall ?? false,
      msgCall: settings.msgCall ?? '',
      groupsIgnore: settings.groupsIgnore ?? true,
      alwaysOnline: settings.alwaysOnline ?? false,
      readMessages: settings.readMessages ?? false,
      readStatus: settings.readStatus ?? false,
      syncFullHistory: settings.syncFullHistory ?? false
    };

    await evolutionFetch(`/settings/set/${cleanId}`, {
      method: 'POST',
      body: JSON.stringify(defaultSettings)
    });

    // 3. Salva no banco de dados
    if (pool) {
      const initialHistory = telefone ? [{
        telefone: telefone.trim(),
        data: new Date().toISOString(),
        motivo: 'Número inicial cadastrado'
      }] : [];

      await pool.query(
        `INSERT INTO clientes (id, nome, telefone, email, configuracoes, historico_telefones, atualizado_em)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (id) DO UPDATE
         SET nome = EXCLUDED.nome, telefone = EXCLUDED.telefone, email = EXCLUDED.email,
             configuracoes = EXCLUDED.configuracoes, atualizado_em = NOW()`,
        [cleanId, nome.trim(), telefone ? telefone.trim() : null, email ? email.trim() : null, JSON.stringify(defaultSettings), JSON.stringify(initialHistory)]
      );
    }

    res.status(201).json({
      success: true,
      data: {
        id: cleanId,
        nome: nome.trim(),
        telefone,
        email,
        settings: defaultSettings
      }
    });
  } catch (err) {
    console.error('[api] Erro ao criar instância:', err);
    res.status(500).json({ success: false, error: 'Falha interna ao criar instância' });
  }
});

// 3. Atualizar Dados do Cliente / Instância (Ficha)
app.put('/api/v1/instances/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, email, telefone, ativo, motivoTroca } = req.body;

    if (!nome || typeof nome !== 'string' || !nome.trim()) {
      return res.status(400).json({ success: false, error: 'Nome do cliente é obrigatório' });
    }

    if (!pool) {
      return res.status(503).json({ success: false, error: 'Banco de dados não conectado' });
    }

    const currentClientRes = await pool.query('SELECT * FROM clientes WHERE id = $1', [id]);
    if (currentClientRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Instância ou cliente não encontrado' });
    }

    const currentClient = currentClientRes.rows[0];
    const cleanNome = nome.trim();
    const cleanEmail = email ? email.trim() : null;
    const cleanTelefone = telefone ? String(telefone).trim() : null;
    const isAtivo = ativo !== undefined ? Boolean(ativo) : currentClient.ativo;

    let historico = Array.isArray(currentClient.historico_telefones) ? [...currentClient.historico_telefones] : [];

    // Se o telefone foi alterado ou novo telefone informado
    const currentTelDigits = (currentClient.telefone || '').replace(/\D/g, '');
    const newTelDigits = (cleanTelefone || '').replace(/\D/g, '');

    if (newTelDigits && newTelDigits !== currentTelDigits) {
      historico.push({
        telefone: cleanTelefone,
        telefone_anterior: currentClient.telefone || null,
        data: new Date().toISOString(),
        motivo: motivoTroca || 'Alteração cadastral de número'
      });
    }

    const updateRes = await pool.query(
      `UPDATE clientes
       SET nome = $1, email = $2, telefone = $3, ativo = $4, historico_telefones = $5, atualizado_em = NOW()
       WHERE id = $6
       RETURNING *`,
      [cleanNome, cleanEmail, cleanTelefone, isAtivo, JSON.stringify(historico), id]
    );

    res.json({
      success: true,
      data: updateRes.rows[0]
    });
  } catch (err) {
    console.error('[api] Erro ao atualizar cliente:', err);
    res.status(500).json({ success: false, error: 'Falha ao atualizar dados do cliente' });
  }
});

// 4. Conectar WhatsApp (Pairing Code ou QR Code)
app.get('/api/v1/instances/:id/connect', async (req, res) => {
  try {
    const { id } = req.params;
    const { number } = req.query;

    let endpoint = `/instance/connect/${encodeURIComponent(id)}`;
    if (number) {
      const cleanNumber = String(number).replace(/\D/g, '');
      endpoint += `?number=${cleanNumber}`;
    }

    const evoRes = await evolutionFetch(endpoint);

    if (!evoRes.ok) {
      const msg = evoRes.data?.response?.message?.[0] || evoRes.data?.error || 'Falha ao gerar código de conexão';
      return res.status(evoRes.status).json({ success: false, error: msg });
    }

    const base64 = evoRes.data?.base64 || evoRes.data?.qrcode?.base64 || null;
    const code = evoRes.data?.code || evoRes.data?.qrcode?.code || null;
    const pairingCode = evoRes.data?.pairingCode || null;

    res.json({
      success: true,
      data: {
        pairingCode,
        base64,
        code,
        count: evoRes.data?.count || 1
      }
    });
  } catch (err) {
    console.error('[api] Erro ao conectar instância:', err);
    res.status(500).json({ success: false, error: 'Falha ao solicitar conexão' });
  }
});

// 4. Status de Conexão em Tempo Real
app.get('/api/v1/instances/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const evoRes = await evolutionFetch(`/instance/connectionState/${encodeURIComponent(id)}`);

    const state = evoRes.data?.instance?.state || evoRes.data?.state || 'close';
    res.json({ success: true, state });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Falha ao verificar status' });
  }
});

// 5. Consultar Configurações (Settings)
app.get('/api/v1/instances/:id/settings', async (req, res) => {
  try {
    const { id } = req.params;
    const evoRes = await evolutionFetch(`/settings/find/${encodeURIComponent(id)}`);

    let settings = null;
    if (evoRes.ok && evoRes.data?.settings) {
      settings = evoRes.data.settings;
    } else if (pool) {
      // Fallback para o cache do banco
      const r = await pool.query('SELECT configuracoes FROM clientes WHERE id = $1', [id]);
      if (r.rows.length > 0) settings = r.rows[0].configuracoes;
    }

    res.json({
      success: true,
      settings: settings || {
        rejectCall: false,
        msgCall: '',
        groupsIgnore: true,
        alwaysOnline: false,
        readMessages: false,
        readStatus: false,
        syncFullHistory: false
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Falha ao buscar configurações' });
  }
});

// 6. Atualizar Configurações (Settings)
app.post('/api/v1/instances/:id/settings', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      rejectCall = false,
      msgCall = '',
      groupsIgnore = true,
      alwaysOnline = false,
      readMessages = false,
      readStatus = false,
      syncFullHistory = false
    } = req.body;

    const payload = {
      rejectCall: Boolean(rejectCall),
      msgCall: String(msgCall || ''),
      groupsIgnore: Boolean(groupsIgnore),
      alwaysOnline: Boolean(alwaysOnline),
      readMessages: Boolean(readMessages),
      readStatus: Boolean(readStatus),
      syncFullHistory: Boolean(syncFullHistory)
    };

    // Atualiza na Evolution API
    const evoRes = await evolutionFetch(`/settings/set/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    // Salva no banco de dados local
    if (pool) {
      await pool.query(
        'UPDATE clientes SET configuracoes = $1, atualizado_em = NOW() WHERE id = $2',
        [JSON.stringify(payload), id]
      );
    }

    if (!evoRes.ok) {
      console.warn('[settings] Evolution retornou aviso:', evoRes.data);
    }

    res.json({ success: true, settings: payload });
  } catch (err) {
    console.error('[api] Erro ao salvar configurações:', err);
    res.status(500).json({ success: false, error: 'Falha ao salvar configurações' });
  }
});

// 6b. Consultar Prompt do Agente (persona/role/playbook)
app.get('/api/v1/instances/:id/prompt', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Banco de dados indisponível' });
    }
    const { id } = req.params;
    const r = await pool.query('SELECT * FROM prompt_config WHERE id = $1', [id]);
    if (r.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Prompt não configurado para este cliente' });
    }
    res.json({ success: true, prompt: r.rows[0] });
  } catch (err) {
    console.error('[api] Erro ao buscar prompt:', err);
    res.status(500).json({ success: false, error: 'Falha ao buscar prompt' });
  }
});

// 6c. Salvar Prompt do Agente (upsert idempotente)
app.put('/api/v1/instances/:id/prompt', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Banco de dados indisponível' });
    }
    const { id } = req.params;
    const {
      identity = '',
      role = '',
      personality = '',
      playbook = '',
      tools = '',
      locale = 'pt-BR',
      escalation_channel = '',
      escalation_target = '',
      escalation_policy = '',
      system_prompt = '',
      fatiamento_override = ''
    } = req.body;

    const prompt = {
      identity: String(identity || ''),
      role: String(role || ''),
      personality: String(personality || ''),
      playbook: String(playbook || ''),
      tools: String(tools || ''),
      locale: String(locale || 'pt-BR'),
      escalation_channel: String(escalation_channel || ''),
      escalation_target: String(escalation_target || ''),
      escalation_policy: String(escalation_policy || ''),
      system_prompt: String(system_prompt || ''),
      fatiamento_override: String(fatiamento_override || '')
    };

    const r = await pool.query(
      `INSERT INTO prompt_config (
         id, identity, role, personality, playbook, tools, locale,
         escalation_channel, escalation_target, escalation_policy,
         system_prompt, fatiamento_override, atualizado_em
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
       ON CONFLICT (id) DO UPDATE SET
         identity = EXCLUDED.identity,
         role = EXCLUDED.role,
         personality = EXCLUDED.personality,
         playbook = EXCLUDED.playbook,
         tools = EXCLUDED.tools,
         locale = EXCLUDED.locale,
         escalation_channel = EXCLUDED.escalation_channel,
         escalation_target = EXCLUDED.escalation_target,
         escalation_policy = EXCLUDED.escalation_policy,
         system_prompt = EXCLUDED.system_prompt,
         fatiamento_override = EXCLUDED.fatiamento_override,
         atualizado_em = NOW()
       RETURNING *`,
      [
        id,
        prompt.identity,
        prompt.role,
        prompt.personality,
        prompt.playbook,
        prompt.tools,
        prompt.locale,
        prompt.escalation_channel,
        prompt.escalation_target,
        prompt.escalation_policy,
        prompt.system_prompt,
        prompt.fatiamento_override
      ]
    );

    res.json({ success: true, prompt: r.rows[0] });
  } catch (err) {
    // 23503 = foreign_key_violation: cliente não existe em `clientes`
    if (err.code === '23503') {
      return res.status(404).json({ success: false, error: 'Cliente não encontrado para este ID' });
    }
    console.error('[api] Erro ao salvar prompt:', err);
    res.status(500).json({ success: false, error: 'Falha ao salvar prompt' });
  }
});

// 7. Reiniciar Instância
app.post('/api/v1/instances/:id/restart', async (req, res) => {
  try {
    const { id } = req.params;
    const evoRes = await evolutionFetch(`/instance/restart/${encodeURIComponent(id)}`, {
      method: 'POST'
    });

    res.json({ success: evoRes.ok, data: evoRes.data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Falha ao reiniciar instância' });
  }
});

// 8. Excluir Instância e Cliente
app.delete('/api/v1/instances/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Remove na Evolution API
    await evolutionFetch(`/instance/delete/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });

    // Remove no banco de dados
    if (pool) {
      await pool.query('DELETE FROM clientes WHERE id = $1', [id]);
    }

    res.json({ success: true, message: `Instância ${id} removida com sucesso.` });
  } catch (err) {
    console.error('[api] Erro ao excluir instância:', err);
    res.status(500).json({ success: false, error: 'Falha ao excluir instância' });
  }
});

// Inicia servidor HTTP
app.listen(port, '0.0.0.0', () => {
  console.log(`[dashboard] Painel administrativo ativo na porta ${port}`);
});
