#!/bin/sh
# Fix only the writable hotspots instead of recursively traversing the whole volume.
set -eu

DB_PATH="${DB_PATH:-/app/data/enote.db}"
STORAGE_PATH="${STORAGE_PATH:-/app/data/storage}"
DB_DIR=$(dirname "$DB_PATH")
DB_FILE=$(basename "$DB_PATH")

mkdir -p "$DB_DIR" "$STORAGE_PATH" "$STORAGE_PATH/tmp"

# Only chown if running as root (not when already as enote user)
if [ "$(id -u)" -eq 0 ]; then
    chown enote:enote "$DB_DIR" "$STORAGE_PATH" "$STORAGE_PATH/tmp"
    
    if [ -d "$STORAGE_PATH/backups" ]; then
        chown enote:enote "$STORAGE_PATH/backups"
    fi
    
    find "$DB_DIR" -maxdepth 1 -type f \( -name "$DB_FILE" -o -name "$DB_FILE-*" \) -exec chown enote:enote {} +
    find "$STORAGE_PATH" -maxdepth 1 -mindepth 1 -type d -exec chown enote:enote {} +
    
    exec su-exec enote node server/server.js
else
    exec node server/server.js
fi
