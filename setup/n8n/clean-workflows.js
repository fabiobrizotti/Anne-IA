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

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const dbPath = process.argv[2] || '/home/node/.n8n/database.sqlite';

if (!fs.existsSync(dbPath)) {
  console.log('[clean-workflows] Banco de dados ainda não existe (' + dbPath + '). Nada a limpar.');
  process.exit(0);
}

function loadSqlite3() {
  try {
    return require('sqlite3');
  } catch (_) {}

  try {
    const n8nRequire = createRequire('/usr/local/lib/node_modules/n8n/package.json');
    return n8nRequire('sqlite3');
  } catch (_) {}

  try {
    const pnpmDir = '/usr/local/lib/node_modules/n8n/node_modules/.pnpm';
    if (fs.existsSync(pnpmDir)) {
      const match = fs.readdirSync(pnpmDir).find((d) => d.startsWith('sqlite3@'));
      if (match) {
        return require(path.join(pnpmDir, match, 'node_modules', 'sqlite3'));
      }
    }
  } catch (_) {}

  throw new Error('Módulo sqlite3 não encontrado no container n8n');
}

const { Database } = loadSqlite3();
const db = new Database(dbPath);

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

    db.serialize(() => {
      db.run('PRAGMA foreign_keys = OFF;');
      db.run('BEGIN TRANSACTION;');

      for (const t of ordered) {
        db.run('DELETE FROM ' + q(t));
      }

      if (targets.includes('workflow_entity')) {
        db.run('DELETE FROM "workflow_entity"');
      }

      db.run('COMMIT;', (commitErr) => {
        db.run('PRAGMA foreign_keys = ON;', () => {
          if (commitErr) {
            console.error('[clean-workflows] ERRO no commit:', commitErr.message);
            db.close();
            process.exit(1);
          }
          console.log('[clean-workflows] OK. Workflows removidos. (tabelas: ' + targets.join(', ') + ')');
          db.close();
        });
      });
    });
  });
}

// Se o banco não existe, não há o que limpar.
try {
  cleanup();
} catch (e) {
  console.error('[clean-workflows] ERRO fatal:', e.message);
  process.exit(1);
}