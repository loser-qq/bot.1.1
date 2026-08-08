# Unified single bot runtime

This workspace runs all features as one bot (one process, one token) with a modular file layout.

Main entry:
- index.js

Main modules:
- lib/unifiedEnv.js
- lib/sharedClient.js
- lib/backupFeature.js

Feature modules:
- features/community
- features/economy
- features/security

## One app / one token mode (required for unified run)

Set these values in .env:

- ONE_TOKEN_MODE=true
- UNIFIED_DISCORD_TOKEN=<your single bot token>
- UNIFIED_CLIENT_ID=<your single application client id>
- UNIFIED_DEVELOPER_ID=<optional>
- UNIFIED_GUILD_ID=<optional>
- UNIFIED_DB_PATH=<optional, default: data/unified.db>

In this mode, all features run under the same Discord application/token and use one shared SQLite database file.
To prevent command collisions, overlapping command names are filtered where needed and commands are registered with upsert-style API calls.

## New backup command

Slash command:
- /backup channel:#channel scope:all|community|economy|security

Behavior:
- Sends configuration/database-related files to the specified channel.
- Administrator or configured developer only.
- Scope all sends files from all feature areas.

## 1) Configure env

1. Copy .env.example to .env.
2. Fill bot tokens and client IDs.

## 2) Start unified bot

```bash
npm start
```

or

```bash
node index.js
```

## Railway PostgreSQL data management

This project keeps runtime compatibility by using one local SQLite file and syncing it to Railway PostgreSQL.

Set these env vars on Railway (see `.env.example` for the full list):

- DATABASE_URL=<Railway PostgreSQL URL — auto-set by Railway Postgres plugin>
- POSTGRES_SYNC_ENABLED=true
- POSTGRES_SNAPSHOT_ID=main
- POSTGRES_SYNC_INTERVAL_MS=30000
- POSTGRES_HISTORY_KEEP=2

How it works:

- On startup, PostgreSQL snapshot is restored only when it is valid and newer than local SQLite.
- During runtime, data/unified.db is backed up safely and uploaded to PostgreSQL periodically.
- Backup command remains available: /backup channel:#channel scope:all|community|economy|security

## PostgreSQL Sync Safety Improvements

The sync mechanism keeps SQLite as runtime DB and uses PostgreSQL only for durable snapshots.

- Safe SQLite snapshot creation:
	- Uses better-sqlite3 backup API to create a temporary consistent snapshot file.
	- Runs PRAGMA integrity_check on the snapshot before upload.
- Safe restore on startup:
	- Reads candidate snapshots (main + recent generations).
	- Verifies SHA-256 checksum before applying.
	- Skips restore when local SQLite is newer.
	- Writes restore data to temp file, validates integrity_check, then atomically replaces DB.
- Sync failure tolerance:
	- PostgreSQL restore/upload failure logs warning and keeps bot running.
- Multi-run protection:
	- inFlight guard prevents concurrent uploads.
- Shutdown behavior:
	- SIGINT/SIGTERM and beforeExit trigger best-effort final sync without hard dependency.
- Snapshot generations:
	- Keeps main plus history snapshots (default 2 recent history rows).

## Changed Files And Reasons

- index.js
	- PostgreSQL restore before feature load.
	- Periodic sync startup.
	- Final sync hook registration for shutdown.
- lib/postgresPersistence.js
	- Implemented safe backup, integrity check, checksum validation, stale-restore guard, history retention, and metadata columns.
- features/community/index.js
	- Shutdown signal handlers await global pre-shutdown sync hook.
- features/economy/index.js
	- Shutdown signal handlers await global pre-shutdown sync hook.
- .env.example
	- Added PostgreSQL sync env values including history retention.

## PostgreSQL Table

Table name: bot_db_snapshots

Columns (auto-created / auto-updated):

- snapshot_id TEXT PRIMARY KEY
- db_blob BYTEA NOT NULL
- updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
- snapshot_created_at TIMESTAMPTZ
- db_size_bytes BIGINT
- db_mtime_ms BIGINT
- checksum_sha256 TEXT
- schema_version INTEGER

Notes:

- Existing tables are migrated safely using ALTER TABLE ADD COLUMN IF NOT EXISTS.
- Checksums are validated before restore.

## Initial Railway Deploy Steps

1. Create a new Railway project and link this repository.
2. Add a **PostgreSQL** database plugin in Railway (this auto-sets `DATABASE_URL`).
3. Add the following env vars in the Railway service settings:
	 - UNIFIED_DISCORD_TOKEN
	 - UNIFIED_CLIENT_ID
	 - UNIFIED_DEVELOPER_ID (optional)
	 - UNIFIED_GUILD_ID (optional)
	 - UNIFIED_DB_PATH (recommended: data/unified.db)
	 - POSTGRES_SYNC_ENABLED=true
	 - POSTGRES_SNAPSHOT_ID=main
	 - POSTGRES_SYNC_INTERVAL_MS=30000
	 - POSTGRES_HISTORY_KEEP=2
4. Railway detects `railway.json` and runs `npm start` automatically.
5. Confirm logs:
	 - [postgres-sync] no valid remote snapshot found; using local sqlite file. (first deploy expected)
	 - [postgres-sync] uploaded sqlite snapshot to PostgreSQL.

## Migration From Existing unified.db

1. Place current DB at data/unified.db.
2. Set DATABASE_URL and sync env vars.
3. Start bot once and wait for first successful upload log.
4. Restart bot and verify restore path does not downgrade local DB.

## Data Loss / Risk Cases

- If process is force-killed without signal handling window, latest unsynced writes may be missing from PostgreSQL.
- If PostgreSQL is unavailable for long periods, only local SQLite state exists until next successful sync.
- If both local SQLite and all remote snapshots are corrupted, manual recovery is required.

## Path To Full PostgreSQL Migration

To migrate off SQLite entirely in the future:

1. Replace better-sqlite3 DB access layer with PostgreSQL query layer.
2. Convert all sync SQL and transactions per feature module.
3. Add migration scripts for existing SQLite schema/data.
4. Remove snapshot blob strategy after query-layer parity validation.

## Verification Notes

- A (DATABASE_URLなし): Confirmed locally.
- F (同期失敗でもBot継続): Confirmed with invalid DATABASE_URL (ECONNREFUSED) and bot stayed online.
- B/C/D/E/G/H/I/J: Designed and implemented; full end-to-end validation requires reachable Render PostgreSQL in deployment environment.

## Notes

- Unified mode normalizes env values to one token and one CLIENT_ID before loading each bot module.
