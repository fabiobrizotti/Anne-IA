#!/usr/bin/env bash
# ==============================================================================
# ANNE-IA — VALIDAÇÃO DO BACKUP ANTES DO CUTVERTER n8n SQLite -> Postgres
# ==============================================================================
# Teste real (sem mocks): confere que o dump lógico, os exports CLI do n8n e a
# cópia do SQLite estão completos e íntegros. As contagens esperadas vêm do
# próprio SQLite copiado, não dos exports, para detectar export parcial.
#
# Uso:  ./tests/test_backup_integrity.sh [diretório_de_backup]
# Exit: 0 = backup íntegro | 1 = falta algo (bloqueia o cutover)
# ==============================================================================
set -uo pipefail

BACKUP_DIR="${1:-backups/n8n-pg17-cutover}"
FAILS=0

say() { printf '%s\n' "$*"; }
ok()  { printf '  \033[32m[OK]\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m[FALHA]\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }

assert_file() { # descrição arquivo tamanho_mínimo
  if [[ ! -f "$2" ]]; then bad "$1 — arquivo ausente: $2"; return; fi
  local size
  size="$(stat -c %s "$2")"
  if [[ "$size" -ge "$3" ]]; then ok "$1 (${size} bytes)"; else bad "$1 — arquivo muito pequeno (${size} bytes)"; fi
}

say "=== Backup: ${BACKUP_DIR} ==="

assert_file "dump lógico do cluster PG15" "${BACKUP_DIR}/pg15-cluster.dumpall.sql" 1024
assert_file "cópia do SQLite" "${BACKUP_DIR}/sqlite/database.sqlite" 1024
assert_file "config do n8n (chave de criptografia)" "${BACKUP_DIR}/n8n-config" 1
assert_file "manifesto de checksums" "${BACKUP_DIR}/manifest.sha256" 1

if [[ -f "${BACKUP_DIR}/pg15-cluster.dumpall.sql" ]]; then
  for db in anneia evolution; do
    if grep -q "CREATE DATABASE ${db}" "${BACKUP_DIR}/pg15-cluster.dumpall.sql"; then
      ok "dump contém o banco ${db}"
    else
      bad "dump NÃO contém CREATE DATABASE ${db}"
    fi
  done
fi

if [[ -f "${BACKUP_DIR}/manifest.sha256" ]]; then
  if (cd "${BACKUP_DIR}" && sha256sum -c manifest.sha256) >/dev/null 2>&1; then
    ok "checksums SHA-256 conferem"
  else
    bad "checksums SHA-256 divergentes"
    (cd "${BACKUP_DIR}" && sha256sum -c manifest.sha256) 2>&1 | grep -v ': OK' | head -10
  fi
fi

for kind in workflows credentials; do
  if [[ -d "${BACKUP_DIR}/${kind}" ]]; then
    n="$(find "${BACKUP_DIR}/${kind}" -maxdepth 1 -type f -name '*.json' | wc -l)"
    ok "export de ${kind}: ${n} arquivo(s) JSON"
  else
    bad "diretório de export ausente: ${BACKUP_DIR}/${kind}"
    continue
  fi
  if ! find "${BACKUP_DIR}/${kind}" -maxdepth 1 -type f -name '*.json' -print0 \
       | xargs -0 -r -n1 jq empty >/dev/null 2>&1; then
    bad "export de ${kind} contém JSON inválido"
  else
    ok "export de ${kind}: JSON válido"
  fi
done

if [[ -f "${BACKUP_DIR}/sqlite/database.sqlite" ]]; then
  read -r want_wf want_cred < <(python3 - "${BACKUP_DIR}/sqlite/database.sqlite" <<'PY'
import sqlite3, sys
con = sqlite3.connect(f'file:{sys.argv[1]}?mode=ro', uri=True, timeout=5)
print(con.execute('SELECT count(*) FROM workflow_entity').fetchone()[0],
      con.execute('SELECT count(*) FROM credentials_entity').fetchone()[0])
con.close()
PY
)
  got_wf="$(find "${BACKUP_DIR}/workflows" -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l)"
  got_cred="$(find "${BACKUP_DIR}/credentials" -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l)"
  [[ "${got_wf}" == "${want_wf}" ]] \
    && ok "workflows exportados (${got_wf}) == workflows no SQLite (${want_wf})" \
    || bad "export parcial de workflows: ${got_wf} != ${want_wf}"
  [[ "${got_cred}" == "${want_cred}" ]] \
    && ok "credenciais exportadas (${got_cred}) == credenciais no SQLite (${want_cred})" \
    || bad "export parcial de credenciais: ${got_cred} != ${want_cred}"
fi

if [[ ${FAILS} -eq 0 ]]; then
  say "SUCESSO — backup íntegro; cutover pode prosseguir."
  exit 0
fi
say "FALHOU — ${FAILS} verificação(ões) com problema."
exit 1
