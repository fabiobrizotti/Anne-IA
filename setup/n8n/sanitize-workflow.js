// =============================================================================
// N8N - SANITIZAÇÃO DE WORKFLOW ANTES DO IMPORT
// =============================================================================
// Uso: node /setup-n8n/sanitize-workflow.js <origem.json> <destino.json>
//
// Remove campos de uma instância n8n especifica que quebram o import em uma
// instancia nova (SQLITE_CONSTRAINT: FOREIGN KEY constraint failed) e forcam o
// workflow a ficar inativo (nao executar sozinho no bootstrap):
//   - activeVersion / activeVersionId : snapshot da versao publicada
//   - versionId                       : versao vinculada a instancia de origem
//   - shared                          : ownership/projetos da instancia de origem
//   - active                          : forcado para false
//   - triggerCount / isArchived / staticData : estado nao reutilizavel
// =============================================================================

const fs = require('fs');

const src = process.argv[2];
const dst = process.argv[3];

if (!src || !dst) {
  console.error('[sanitize-workflow] uso: node sanitize-workflow.js <origem.json> <destino.json>');
  process.exit(1);
}

const DROP = new Set(['activeVersion', 'activeVersionId', 'versionId', 'shared', 'triggerCount', 'isArchived', 'staticData']);

try {
  const wf = JSON.parse(fs.readFileSync(src, 'utf8'));
  for (const k of DROP) delete wf[k];
  wf.active = false;
  fs.writeFileSync(dst, JSON.stringify(wf, null, 2));
  console.log('[sanitize-workflow] limpo: ' + dst + ' (active=false)');
} catch (e) {
  console.error('[sanitize-workflow] ERRO: ' + src + ' -> ' + e.message);
  process.exit(1);
}