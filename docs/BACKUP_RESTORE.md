# Backup and restore

## Orbit Desktop (Mac)

Database: `~/Library/Application Support/Orbit/orbit.db` (WAL mode). You can take a consistent backup even while Orbit is running (SQLite online backup API):

```bash
D=~/Library/Application\ Support/Orbit; mkdir -p "$D/backups"; /usr/bin/sqlite3 "$D/orbit.db" ".backup '$D/backups/orbit-$(date +%Y%m%d-%H%M%S).db'"
```

Check it:

```bash
/usr/bin/sqlite3 ~/Library/Application\ Support/Orbit/backups/<file>.db "PRAGMA integrity_check;"
```

The expected output is `ok`.

To restore, quit Orbit, then run:

```bash
D=~/Library/Application\ Support/Orbit; mv "$D/orbit.db" "$D/orbit.db.before-restore"; rm -f "$D/orbit.db-wal" "$D/orbit.db-shm"; cp "$D/backups/<file>.db" "$D/orbit.db"; chmod 600 "$D/orbit.db"
```

Migrations are **additive** (no column or table is ever dropped): an older backup opens with a newer version of Orbit, which applies the missing migrations at startup.

### Before upgrading

Take a backup before installing a version that adds migrations (see `drizzle/`). After the upgrade, or before relying on a backup, check the database with `sqlite3`:

- `PRAGMA integrity_check;` returns `ok`;
- `PRAGMA foreign_key_check;` returns nothing;
- row counts (companions, missions, approvals) match the original database.

Keep a SHA-256 checksum next to the backup file if you want to verify it later.

## Orbit Runtime (server)

All state lives in `/var/lib/orbit/runtime`: `state/runtime.db` (missions, event log, automations, clients), `identity/` (runtime key, secrets encryption key), `artifacts/`, `projects/`.

```bash
sudo -u orbit sqlite3 /var/lib/orbit/runtime/state/runtime.db ".backup '/var/lib/orbit/backup-$(date +%F).db'"
```

(Without `sqlite3`: stop the service, copy `state/`, start it again.)

Also back up `identity/` **separately and encrypted**. Without `runtime.key`, Orbit sees a new identity (and refuses to connect until you have verified it). Without `secrets.key`, the API keys stored on the server cannot be read.

To restore: stop the service, put `state/runtime.db` back (delete the `-wal`/`-shm` files), start the service. After restoring an earlier state, the runtime event log goes back in time: Orbit detects that its cursor is past the end of the log and reloads a snapshot if needed. Missions that were running at the time of the backup are marked as interrupted at startup and are never restarted.
