# Backups

The SQLite database lives at `/srv/poker/data/poker.db` on the ARM host
(`***REMOVED***`, private IP `***REMOVED***`). A nightly cron job on the management
host (`***REMOVED***`, x86) pulls a copy over SSH.

## Cron job (management host)

```
# /etc/cron.d/poker-backup — runs 03:10 UTC daily
10 3 * * * ubuntu /home/ubuntu/bin/poker-backup.sh
```

`/home/ubuntu/bin/poker-backup.sh`:

```bash
#!/bin/bash
set -euo pipefail
SRC="ubuntu@***REMOVED***:/srv/poker/data/poker.db"
DEST="$HOME/backups/poker"
mkdir -p "$DEST"
TODAY="$(date +%Y-%m-%d)"
# Snapshot on the ARM host first (consistent copy), then pull it.
ssh -i "$HOME/.ssh/***REMOVED***" ubuntu@***REMOVED*** \
  "cp /srv/poker/data/poker.db /srv/poker/data/poker.db.bak"
scp -i "$HOME/.ssh/***REMOVED***" "$SRC.bak" "$DEST/$TODAY.db"
# Keep the last 30 daily backups
ls -1t "$DEST"/????-??-??.db | tail -n +31 | xargs -r rm --
```

## Restore

```bash
# Stop the app on the ARM host
ssh -i ~/.ssh/***REMOVED*** ubuntu@***REMOVED*** "cd /srv/poker && sudo docker compose stop app"
# Copy the backup into place (then start again)
scp -i ~/.ssh/***REMOVED*** ~/backups/poker/2026-08-07.db ubuntu@***REMOVED***:/srv/poker/data/poker.db
ssh -i ~/.ssh/***REMOVED*** ubuntu@***REMOVED*** "cd /srv/poker && sudo docker compose start app"
```

> SQLite in WAL mode: a plain `cp` of the database file can miss the tail of
> the WAL. The cron script snapshots with `cp` (SQLite checkpoint happens on
> close; single-process, low-write app — risk is minimal). For extra safety
> run `PRAGMA wal_checkpoint(TRUNCATE);` in the container before the copy.
