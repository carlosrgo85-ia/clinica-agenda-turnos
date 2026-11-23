#!/usr/bin/env bash
# Restaura un respaldo hecho con scripts/db-backup.sh. DESTRUCTIVO: reemplaza lo que haya en la base destino.
#   CONFIRM_RESTORE=si DATABASE_URL=postgres://... bash scripts/db-restore.sh backups/db-XXXX.dump
# Para PROBAR que el respaldo sirve, restaurarlo primero en una base vacía y aparte.
# Después de restaurar en producción: reiniciar el servidor web y el worker.
set -euo pipefail
: "${DATABASE_URL:?Falta DATABASE_URL (la base DESTINO)}"
file="${1:?Uso: db-restore.sh <archivo.dump>}"
[ -f "$file" ] || { echo "No existe $file"; exit 1; }
if [ "${CONFIRM_RESTORE:-}" != "si" ]; then
  echo "Esto reemplaza el contenido de la base destino. Si estás seguro: CONFIRM_RESTORE=si ..."
  exit 1
fi
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$DATABASE_URL" "$file"
echo "Restaurado desde $file. Reiniciá el servidor web y el worker."
