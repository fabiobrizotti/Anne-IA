// =============================================================================
// N8N - LIMPEZA IDEMPOTENTE DE WORKFLOWS (executado pelo serviço n8n-import)
// =============================================================================
// Remove do database.sqlite do n8n APENAS as entidades de workflow e seus
// relacionamentos, preservando credenciais, usuários, execuções, webhooks e
// configurações. Isso permite que o n8n-import rode repetidamente (bootstrap /
// reimportação) sem falhar com SQLITE_CONSTRAINT (FOREIGN KEY constraint failed)
// ao recriar workflows que já existem.
//
// A heurística é conservadora: só são apagadas tabelas cujo nome contenha
// "workflow" (filhas primeiro, workflow_entity por último). Tabelas de dados
// legítimos do usuário (execution_entity, webhook_entity, etc.) são mantidas.
// =============================================================================

const path = process.argv[2] || '/home/node/.n8n/database.sqlite';

const { Database } = require('/usr/local/lib/node_modules/n8n/node_modules/.pnpm/sqlite3@5.1.7/node_modules/sqlite3');
const db = new Database(path);

function q(t) {
  return '"' + t.replace(/"/g, '""') + '"';
}

function cleanup() {
  db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
    if (err) {
      console.error('[clean-workflows] ERRO ao listar tabelas:', err.message);
      db.close();
      process.exit(1);
    }

    // Apenas tabelas com "workflow" no nome (conservador).
    const targets = tables
      .map((t) => t.name)
      .filter((t) => t.toLowerCase().includes('workflow'));

    // Filhas primeiro; workflow_entity por último (raiz das relações).
    const ordered = targets.filter((t) => t !== 'workflow_entity');
    let j = 0;

    const delNext = () => {
      if (j < ordered.length) {
        const t = ordered[j++];
        db.run('DELETE FROM ' + q(t), (dErr) => {
          if (dErr) {
            console.error('[clean-workflows] WARNING ao limpar ' + t + ':', dErr.message);
          }
          delNext();
        });
      } else {
        db.run('DELETE FROM "workflow_entity"', () => {
          console.log('[clean-workflows] OK. Workflows removidos. (tabelas: ' + targets.join(', ') + ')');
          db.close();
        });
      }
    };

    delNext();
  });
}

// Se o banco não existe, não há o que limpar.
try {
  cleanup();
} catch (e) {
  console.error('[clean-workflows] ERRO fatal:', e.message);
  process.exit(1);
}