# Cloudflare tunnel: exposing poker.<domain>

## Architecture

The Cloudflare tunnel runs on the x86 management host — the same named
tunnel that serves `dashboard.<domain>`. The poker app runs in
Docker on the ARM host. The tunnel routes the `poker` hostname to the ARM
box's private IP: the app never listens on a public interface.

```
Browser ──▶ Cloudflare edge ──▶ cloudflared (x86 host)
                                        ├─ dashboard.<domain> → http://localhost:9119
                                        └─ poker.<domain>   → http://<arm-private-ip>:8787
```

## Current config

`~/.cloudflared/config.yaml` on the x86 host (systemd unit:
`cloudflared-dashboard.service`):

```yaml
tunnel: <tunnel-uuid>
credentials-file: /home/ubuntu/.cloudflared/<tunnel-uuid>.json

ingress:
  - hostname: dashboard.<domain>
    service: http://localhost:9119
  - hostname: poker.<domain>
    service: http://<arm-private-ip>:8787
  - service: http_status:404
```

Apply after changing the config:

```bash
sudo systemctl restart cloudflared-dashboard.service
sudo systemctl status cloudflared-dashboard.service --no-pager
```

## DNS record (Cloudflare dashboard)

| Type  | Name                  | Target                                            | Proxy |
|-------|-----------------------|---------------------------------------------------|-------|
| CNAME | `poker`               | `<tunnel-uuid>.cfargotunnel.com`                  | ✅ Proxied |

The tunnel certificate / API token is NOT stored on any machine — DNS
records are managed manually in the Cloudflare dashboard.

## Verify

```bash
dig @1.1.1.1 poker.<domain> +short            # → Cloudflare IP
curl -fsS https://poker.<domain>/api/health   # → {"ok":true}
```

## Security notes

- The ARM subnet's security list allows ingress to port `8787` from the x86
  host's private IP (`<x86-private-ip>/32`) **only** — the tunnel is the only
  public entry point.
- The app's Docker Compose additionally binds to `HOST_BIND_IP` (the ARM
  box's private IP from the host `.env`), never `0.0.0.0`.
- TLS termination happens at Cloudflare (free Universal SSL). The origin
  connection (tunnel → app) is plain HTTP on the private network, which is
  fine for this threat model; set the SSL mode to **Full** if you ever move
  the app to a public endpoint.
