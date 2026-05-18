# Migration plan — Cloudflare quick tunnel → named tunnel

The sap-logistics public URL today comes from `cloudflared tunnel --url
http://localhost:4000` (a "quick tunnel"). That URL is **rotated every
time the tunnel process restarts** — which means operators (Moti and
others) lose access on every reboot, and we have to chase the new URL
out of `pm2 logs cloudflare-tunnel`.

This document is the step-by-step to fix that with a **named tunnel**
backed by a stable domain (e.g., `logistics.oig.co.il`). Result: the URL
stops changing.

**Effort**: ~30-45 minutes of focused work, no Claude needed.

**Prerequisites**:
- A Cloudflare account (free tier is fine)
- A domain registered (you already have `oig.co.il` per the bot agent)
  OR willing to register one on Cloudflare (~$10/year for `.app` or
  `.co.il`)
- Local admin (one elevated PowerShell run for PM2 update)

---

## Step 0 — confirm the domain situation

The simplest path is to use `oig.co.il` as the parent domain. The
sap-logistics hub will live at a subdomain like
`logistics.oig.co.il`.

To use `oig.co.il` via Cloudflare:
1. Your domain registrar (probably the Israeli registrar where you
   first bought oig.co.il) must let you change the nameservers
2. The nameservers point at Cloudflare (Cloudflare gives you 2 of them
   when you add the domain)
3. After 1-2 hours of DNS propagation, Cloudflare is the authority for
   `oig.co.il` and can route subdomains

If you don't want to touch the existing `oig.co.il` (e.g. because email
is on it) — buy a new domain on Cloudflare specifically for internal
tools (~$10/year). Suggested: `oig.app` or `oig-tools.com`.

---

## Step 1 — log in once with cloudflared

In any PowerShell:

```
cloudflared tunnel login
```

A browser opens. Sign in to your Cloudflare account, pick the
domain (e.g. `oig.co.il`) to associate. A credentials file is written to
`~/.cloudflared/cert.pem`.

This step is interactive and only needs to be done once.

---

## Step 2 — create the named tunnel

```
cloudflared tunnel create sap-logistics
```

This:
- Generates a tunnel UUID (e.g. `e1b2...`)
- Saves credentials to `~/.cloudflared/<UUID>.json`

The UUID is the long-term identifier. It survives restarts and is what
gives you the stable URL.

---

## Step 3 — bind the tunnel to a DNS record

```
cloudflared tunnel route dns sap-logistics logistics.oig.co.il
```

This creates a CNAME in Cloudflare DNS:
- `logistics.oig.co.il` → `<UUID>.cfargotunnel.com`

After ~30s, https://logistics.oig.co.il/ resolves to the tunnel.

---

## Step 4 — write the tunnel config

Create `C:\Users\izik\.cloudflared\config.yml` with this content (use
the UUID from Step 2):

```yaml
tunnel: <PASTE-UUID-HERE>
credentials-file: C:\Users\izik\.cloudflared\<PASTE-UUID-HERE>.json

ingress:
  - hostname: logistics.oig.co.il
    service: http://localhost:4000
  - service: http_status:404
```

Test that the config is well-formed:
```
cloudflared tunnel ingress validate
```

---

## Step 5 — update PM2 to run the named tunnel

The current PM2 process `cloudflare-tunnel` runs:
```
cloudflared tunnel --url http://localhost:4000 --no-autoupdate
```

Change it to:
```
cloudflared tunnel run sap-logistics
```

Easiest way to update PM2:

```
pm2 stop cloudflare-tunnel
pm2 delete cloudflare-tunnel
pm2 start cloudflared --name cloudflare-tunnel -- tunnel run sap-logistics
pm2 save
```

The `--` separates PM2 args from the args passed to `cloudflared`.

---

## Step 6 — update CORS in backend/.env

The backend's `CORS_ORIGINS` currently lists the LAN URLs and the old
quick-tunnel URL (`https://therefore-breakfast-temperature-coating.trycloudflare.com`).
Add the new stable URL, leave the old ones for safety:

```
CORS_ORIGINS=http://localhost:5173,http://localhost:5174,http://localhost:4000,http://192.168.0.14:5173,http://192.168.0.14:4000,https://logistics.oig.co.il
```

Then reload the backend:
```
pm2 reload sap-logistics
```

---

## Step 7 — tell the operators the new URL

Send Moti and anyone else:
```
שלום, החל מהיום הכניסה למערכת היא דרך:
https://logistics.oig.co.il
שמרו כסימניה. הכתובת לא תתחלף יותר.
```

---

## Step 8 — clean up old quick-tunnel artefacts

Optional but tidy:
- Delete the old `cloudflare-tunnel` PM2 logs that mention rotating URLs
- Remove old `trycloudflare.com` entries from `CORS_ORIGINS` after a
  week of confirmed stability

---

## Verifying

After Step 5, run:
```
curl https://logistics.oig.co.il/health
```

Expect:
```
HTTP/2 200
{"ok":true,"sapConnected":true,...}
```

If you get a tunnel error, check:
```
pm2 logs cloudflare-tunnel --lines 50
cloudflared tunnel info sap-logistics
```

---

## Cost summary

| Item | Cost |
|---|---|
| Cloudflare account | Free |
| Named tunnel | Free (unlimited) |
| Custom domain — first year | ~$10 (if buying new) OR $0 (if reusing `oig.co.il`) |
| Bandwidth | Free at this scale (you're not pushing 1TB+ a month) |

**Total**: $0 if you reuse the existing domain.

---

## Why this matters

| Today (quick tunnel) | After named tunnel |
|---|---|
| URL changes every reboot | URL is permanent |
| Need to chase URL from PM2 logs | Bookmark works forever |
| `tunnel-url-watcher.mjs` script (in sap-bi) has to detect changes and update Vercel env vars | Not needed |
| Operators get confused (today's incident: 4 cycles wasted on URL identity) | "Just go to the bookmark" |
| Browser tabs / saved password autofill break on every change | Stable |

The migration is ~30 min of work for a permanent fix.

---

## Related

- A similar named-tunnel migration would benefit `sap-bi` (currently
  `sunglasses-bend-timber-fabrics.trycloudflare.com`) for the same
  reasons.
- The `tunnel-url-watcher.mjs` script in `sap-bi/scripts/` could be
  retired after migration.
