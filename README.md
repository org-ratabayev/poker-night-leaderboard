# 🃏 Poker Night Leaderboard

A tiny, self-hosted points leaderboard for poker nights. Players collect
points over a **season**; the season champion gets the prize. Built for a
group of friends who are also software engineers — so the code is deliberately
simple, the deployment is fully automated, and pull requests are welcome.

## Features

- **Seasons** — create a season, add results after every game, archive the
  season when it's done. The champion 🏆 is recorded for history and a new
  season starts automatically.
- **Points by formula** — 1st place always gets 100; the rest scale by
  `round(100 · (N − position + 1) / N)` (N = players in that game). For 6
  players: 100 / 83 / 67 / 50 / 33 / 17.
- **Betting between players** — every registered player starts a season with a
  50-point bank. Anyone can wager their points on who wins the current game —
  **except on themselves** — and bets are **hidden from everyone until the
  first bust-out**, then locked and revealed. Payouts are parimutuel: losing
  stakes are split among those who backed the winner; if nobody backed the
  winner, all stakes are refunded. Betting P/L is added to the season
  standings. The admin follows exactly the same rules as everyone else.
- **Live game tracking** — the admin starts a game with the players at the
  table, then marks players as they bust out. The first player out gets the
  worst position, the last one standing wins (1st place). Everyone else can
  watch the result live — the page auto-refreshes every 10 seconds.
- **One game per day, admin-only** — a game can only be started by an admin,
  and only once per calendar day (with an *undo* for the last elimination).
- **Admin** — the first registered user is admin: starts/undoes/deletes games,
  manages seasons, renames players, promotes others.
- **Mobile-friendly** dark "poker table" UI — works great at the table.

## Tech stack

| Layer    | Choice                                                          |
|----------|-----------------------------------------------------------------|
| Runtime  | [Bun](https://bun.sh) (`Bun.serve` + `bun:sqlite` + `Bun.password`) |
| Database | SQLite (single file, WAL mode)                                  |
| Frontend | Static HTML/CSS/JS served by the app — **zero npm dependencies** |
| Tests    | `bun test` (27 tests: auth, permissions, standings, seasons)    |
| Deploy   | Docker Compose on an Oracle always-free ARM instance + Cloudflare Tunnel |
| CI/CD    | None by design — deploys are manual, triggered on demand (Ansible + Docker Compose) |

Zero dependencies means a tiny attack surface, instant builds, and no
supply-chain surprises.

## Quick start (local)

```bash
bun install        # no-op today: no deps, kept for future ones
bun test           # run the test suite

# Run with a scratch config
SESSION_SECRET=dev-secret INVITE_CODE=dev-invite DATA_DIR=/tmp/poker-dev bun src/server.ts
# → http://localhost:8787
```

Or with Docker:

```bash
cp .env.example .env   # fill in SESSION_SECRET + INVITE_CODE
docker compose up --build
```

## Deployment

### Production setup (as deployed)

```
Browser ──HTTPS──▶ Cloudflare edge ──tunnel──▶ cloudflared (x86 host)
                                                    │
                                              http://<arm-private-ip>:8787
                                                    │
                              Docker Compose ──▶ poker app (ARM host)
                                                    │
                                              SQLite volume ./data
```

- **App**: Docker Compose on the Oracle always-free ARM instance,
  bound to the host's **private IP only** — no public ports.
- **TLS**: Cloudflare Tunnel (`poker.<domain>`), DNS CNAME proxied.
- **DB**: SQLite at `/srv/poker/data/poker.db`, backed up nightly to the
  management host (see [`infra/backups.md`](infra/backups.md)).
- **Cost**: $0. Oracle always-free ARM + free Cloudflare tunnel + free GitHub
  Actions.

### First-time bootstrap

`deploy/ansible/playbook.yml` clones the repo to `/srv/poker`, writes `.env`
from an ansible-vault, installs the systemd deploy units and starts the
container:

```bash
cd deploy/ansible
cp inventory.example inventory.ini     # set the ARM host / SSH key
cp group_vars/all/example.yml group_vars/all/vault.yml
ansible-vault encrypt group_vars/all/vault.yml
ansible-playbook -i inventory.ini playbook.yml --ask-vault-pass
```

### Deploying (after bootstrap)

Code updates are picked up by `deploy/arm-deploy.sh`, which runs every 5
minutes via `poker-deploy.timer` on the ARM host:

1. `git fetch origin main` — exits silently if nothing changed;
2. if new commits exist → runs `bun test` in a throwaway container;
3. **only if tests pass** → `docker compose up -d --build`.

A failing test aborts the deploy and the old container keeps running. No
GitHub Actions, no cloud CI — the box polls the repo itself.

To deploy immediately (skip the 5-minute wait):

```bash
systemctl start poker-deploy.service        # on the ARM host
# or, from anywhere with SSH:
ssh ubuntu@<arm-host> "cd /srv/poker && docker compose up -d --build"
```

The `.env` lives only on the host at `/srv/poker/.env` and is never in the
repository; the same holds for the SQLite data in `/srv/poker/data/`
(git-ignored, untouched by `git reset --hard`).

### Cloudflare tunnel / DNS

See [`infra/cloudflare-tunnel.md`](infra/cloudflare-tunnel.md) for the exact
tunnel ingress config and the DNS record.

## Security model

| Area            | Control                                                                  |
|-----------------|--------------------------------------------------------------------------|
| Passwords       | Argon2id (via `Bun.password`)                                            |
| Sessions        | HMAC-SHA256-signed cookie, HttpOnly + Secure + SameSite=Lax, 30-day TTL |
| CSRF            | SameSite=Lax + Origin header check on all mutating requests              |
| Registration    | Shared invite code (constant-time comparison), rate-limited login        |
| Network         | App bound to private IP only; public access solely via Cloudflare tunnel |
| Permissions     | Any member can add results; delete/seasons/players = admin (or author)   |
| Secrets         | `.env` never committed; generated on the host; vault for Ansible         |
| Container       | Runs as unprivileged `bun` user, 64 KB body limit, WAL SQLite            |

## API overview

| Method | Path                        | Auth  | Description                          |
|--------|-----------------------------|-------|--------------------------------------|
| GET    | `/api/state`                | open  | Everything the UI needs in one call  |
| GET    | `/api/season/:id`           | open  | Archived season + champion           |
| GET    | `/api/me`                   | user  | Current player                       |
| POST   | `/api/auth/register`        | open  | Register (invite code required)      |
| POST   | `/api/auth/login`           | open  | Log in                               |
| POST   | `/api/auth/logout`          | user  | Log out                              |
| POST   | `/api/games`                | admin | Start a game (participants, one per day) |
| POST   | `/api/games/:id/eliminate`  | admin | Mark a player as eliminated          |
| POST   | `/api/games/:id/undo`       | admin | Undo the last elimination / the win  |
| POST   | `/api/games/:id/bets`       | user  | Place a bet (non-participants only, before the lock) |
| DELETE | `/api/games/:id`            | admin | Delete a game                        |
| POST   | `/api/seasons`              | admin | Create a season (when none active)   |
| POST   | `/api/seasons/:id/archive`  | admin | Archive + auto-start next season     |
| POST   | `/api/players/:id/rename`   | admin | Rename a player                      |
| POST   | `/api/players/:id/admin`    | admin | Grant/revoke admin                   |
| GET    | `/api/health`               | open  | Health check (docker/curl)           |

## Contributing

This is a group project — contributions from the poker table are the point.

1. Fork the repo (or just open a branch if you're a collaborator).
2. Make your change with a test — run `bun test` locally, it must pass.
3. Open a PR. (No CI is configured; the maintainer reviews and runs the
   tests before merging.)
4. Merges to `main` do **not** auto-deploy — the host deploys explicitly when
   he decides the change is ready.

Ideas on the roadmap: head-to-head stats, streak tracking, tournament mode
(2 tables), CSV export, Telegram notifications after each game.

## License

MIT — see [LICENSE](LICENSE).
