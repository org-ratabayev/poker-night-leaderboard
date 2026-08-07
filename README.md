# 🃏 Poker Night Leaderboard

A tiny, self-hosted points leaderboard for poker nights. Players collect
points over a **season**; the season champion gets the prize. Built for a
group of friends who are also software engineers — so the code is deliberately
simple, the deployment is fully automated, and pull requests are welcome.

## Features

- **Seasons** — create a season, add results after every game, archive the
  season when it's done. The champion 🏆 is recorded for history and a new
  season starts automatically.
- **Points table** — configurable: `100,75,55,40,30,20,12,8,5,3` by default.
- **Any player can enter results** — everyone in the group logs the finishing
  order after a game; positions map to points automatically.
- **Admin** — the first registered user is admin: manages seasons, renames
  players, deletes any game, promotes others.
- **Mobile-friendly** dark "poker table" UI — works great at the table.

## Tech stack

| Layer    | Choice                                                          |
|----------|-----------------------------------------------------------------|
| Runtime  | [Bun](https://bun.sh) (`Bun.serve` + `bun:sqlite` + `Bun.password`) |
| Database | SQLite (single file, WAL mode)                                  |
| Frontend | Static HTML/CSS/JS served by the app — **zero npm dependencies** |
| Tests    | `bun test` (27 tests: auth, permissions, standings, seasons)    |
| Deploy   | Docker Compose on an Oracle always-free ARM instance + Cloudflare Tunnel |
| CI/CD    | GitHub Actions (CI on every PR, auto-deploy on push to `main`)  |

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
                                              http://***REMOVED***:8787
                                                    │
                              Docker Compose ──▶ poker app (ARM host)
                                                    │
                                              SQLite volume ./data
```

- **App**: Docker Compose on the Oracle always-free ARM instance (`***REMOVED***`),
  bound to the host's **private IP only** — no public ports.
- **TLS**: Cloudflare Tunnel (`poker.<domain>`), DNS CNAME proxied.
- **DB**: SQLite at `/srv/poker/data/poker.db`, backed up nightly to the
  management host (see [`infra/backups.md`](infra/backups.md)).
- **Cost**: $0. Oracle always-free ARM + free Cloudflare tunnel + free GitHub
  Actions.

### First-time bootstrap

`deploy/ansible/playbook.yml` creates `/srv/poker`, writes `.env` from an
ansible-vault and starts the container:

```bash
cd deploy/ansible
cp inventory.example inventory.ini     # set the ARM host / SSH key
cp group_vars/all/example.yml group_vars/all/vault.yml
ansible-vault encrypt group_vars/all/vault.yml
ansible-playbook -i inventory.ini playbook.yml --ask-vault-pass
```

The playbook is idempotent — rerun it to refresh code + restart.

### Automatic deploys

Merging to `main` triggers [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml),
which runs on the org's self-hosted `ARM64` runner (the same box) and does
`docker compose up -d --build` in `/srv/poker`. No credentials are stored in
GitHub — the `.env` lives only on the host. Fork PRs can never trigger it.

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
| POST   | `/api/games`                | user  | Add game results                     |
| DELETE | `/api/games/:id`            | admin/author | Delete a game               |
| POST   | `/api/seasons`              | admin | Create a season (when none active)   |
| POST   | `/api/seasons/:id/archive`  | admin | Archive + auto-start next season     |
| POST   | `/api/players/:id/rename`   | admin | Rename a player                      |
| POST   | `/api/players/:id/admin`    | admin | Grant/revoke admin                   |
| GET    | `/api/health`               | open  | Health check (docker/curl)           |

## Contributing

This is a group project — contributions from the poker table are the point.

1. Fork the repo (or just open a branch if you're a collaborator).
2. Make your change with a test: `bun test` must pass.
3. Open a PR. CI runs the full suite on every PR.
4. Merging to `main` deploys automatically to production.

Ideas on the roadmap: head-to-head stats, streak tracking, tournament mode
(2 tables), CSV export, Telegram notifications after each game.

## License

MIT — see [LICENSE](LICENSE).
