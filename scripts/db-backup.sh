#!/usr/bin/env bash
# Respaldo de la base antes de una instalación o una importación.
#   DATABASE_URL=postgres://... bash scripts/db-backup.sh
# Genera backups/db-<fecha>.dump (formato custom de pg_dump, restaurable con scripts/db-restore.sh).
# Requiere pg_dump de una versión >= la del servidor (en la base local: 16).
# El archivo tiene datos de pacientes: permisos 600, fuera de git (backups/ está en .gitignore); guardarlo cifrado.
# En Render, además de esto, activar los respaldos propios del plan de Postgres.
set -euo pipefail
: "${DATABASE_URL:?Falta DATABASE_URL}"
mkdir -p backups
out="backups/db-$(date -u +%Y%m%dT%H%M%SZ).dump"
umask 077
pg_dump --format=custom --no-owner --no-privileges --file="$out" "$DATABASE_URL"
chmod 600 "$out"
echo "Respaldo guardado en $out ($(du -h "$out" | cut -f1))"
echo "Comprobá que se puede leer: pg_restore --list $out | head"
