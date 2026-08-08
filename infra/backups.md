# Backups

The SQLite database lives at `/srv/poker/data/poker.db` on the ARM host.
A nightly cron job on the management host (x86) pulls a copy over SSH.

## Cron job (management host)

```
# /etc/cron.d/poker-backup — runs 03:10 UTC daily
10 3 * * * <user> /home/<user>/bin/poker-backup.sh
```

`/home/<user>/bin/poker-backup.sh`:

```bash
#!/bin/bash
set -euo pipefail
SRC="<user>@<arm-private-ip>:/srv/poker/data/poker.db"
DEST="$HOME/backups/poker"
mkdir -p "$DEST"
TODAY="$(date +%Y-%m-%d)"
# Snapshot on the ARM host first (consistent copy), then pull it.
ssh -i "$HOME/.ssh/<deploy-key>" <user>@<arm-private-ip> \
  "cp /srv/poker/data/poker.db /srv/poker/data/poker.db.bak"
scp -i "$HOME/.ssh/<deploy-key>" "$SRC.bak" "$DEST/$TODAY.db"
# Keep the last 30 daily backups
ls -1t "$DEST"/????-??-??.db | tail -n +31 | xargs -r rm --
```

## Restore

```bash
# Stop the app on the ARM host
ssh -i ~/.ssh/<deploy-key> <user>@<arm-private-ip> "cd /srv/poker && sudo docker compose stop app"
# Copy the backup into place (then start again)
scp -i ~/.ssh/<deploy-key> ~/backups/poker/<YYYY-MM-DD>.db <user>@<arm-private-ip>:/srv/poker/data/poker.db
ssh -i ~/.ssh/<deploy-key> <user>@<arm-private-ip> "cd /srv/poker && sudo docker compose start app"
```

> SQLite in WAL mode: a plain `cp` of the database file can miss the tail of
> the WAL. The cron script snapshots with `cp` (SQLite checkpoint happens on
> close; single-process, low-write app — risk is minimal). For extra safety
> run `PRAGMA wal_checkpoint(TRUNCATE);` in the container before the copy.
