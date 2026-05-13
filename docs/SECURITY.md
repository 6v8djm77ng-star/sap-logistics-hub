# Security Notes

## 2026-05-13 — `backend/data/store.json` removed from git tracking

### What changed
- `backend/data/store.json` was added to `.gitignore` and removed from the
  index via `git rm --cached`. The file remains on disk so the running
  system (`pm2 sap-logistics`) keeps reading it.
- A sanitized schema reference, `backend/data/store.example.json`, was
  added in its place. Operators bootstrapping a new environment should
  copy it to `store.json` and replace the `PasswordHash` placeholder
  before first login.

### Why
The live `store.json` was being tracked in git and contained:
- 2 bcrypt password hashes (`admin`, `moti`) — cost factor 10, brute-forceable
  offline by anyone with access to the repo history.
- 1,587 customerDeliveryProfiles loaded from the operator's master xlsx,
  with full customer names, cities, streets, weekly delivery schedules,
  and (for private customers) names that are personal identifiers.
- 3 driver phone numbers in plaintext.
- 62 active runs and 846 stops with operational data.

This violates the project memory rule **"credentials only in .env, not
in DB"** and adds new PII to git history with every operational change.

### Legacy exposure in git history
Two bcrypt hashes are still reachable through `git log -p` on commits
before this one:

| User | Hash prefix (first 10 chars) | Plaintext | Status |
|---|---|---|---|
| admin | `$2a$10$Ern...` | `admin123` (documented in PRODUCTION.md) | ROTATED 2026-05-13 |
| מוטי  | `$2a$10$0Ow...` | `123456` (weak default) | ROTATED 2026-05-13 |

Both plaintexts are recoverable in seconds by anyone with access to the
history. The accounts were rotated on 2026-05-13 to 16-character random
passwords; the new hashes are intentionally kept out of git (this commit
and going forward) and out of this document.

### Action required before production cutover

1. **Rotate the live admin + moti passwords again** when moving from
   the demo/PM2 setup to a production environment with a real database.
   The currently-live hashes never entered git, but it is good hygiene
   to rotate one more time at that boundary.
2. **History rewrite is intentionally NOT being done now.**
   `git filter-branch` / BFG would break every existing clone and
   `wave-a-mitigation` branch checkpoint. Defer until:
   - There is a single canonical clone to coordinate from.
   - Every operator working on the repo is on standby to re-clone.
3. **Never re-add `store.json` to git** even temporarily — if it shows
   up in `git status` as staged again, abort and check `.gitignore`.

### What stays trackable
- `store.example.json` — schema reference, sanitized.
- `scripts/load_customer_profiles.py` — the loader that rebuilds
  `customerDeliveryProfiles` from the operator's xlsx files. The xlsx
  files themselves are operator-supplied and not in git.
- `scripts/classify_non_eilat.js`, `scripts/enrich_orphan_orders.js`,
  `scripts/tag_needs_review.js` — idempotent migrations that run on
  top of a freshly-loaded `store.json`.

### Bootstrapping a fresh environment
```bash
cd backend/data
cp store.example.json store.json
# Generate a real admin password hash:
node -e "console.log(require('bcryptjs').hashSync('STRONG-PASSWORD-HERE', 10))"
# Paste the hash into store.json users[0].PasswordHash, then:
cd ../..
python scripts/load_customer_profiles.py     # populate customerDeliveryProfiles
node    scripts/classify_non_eilat.js         # bulk-set DocPolicy
node    scripts/enrich_orphan_orders.js       # placeholder profiles for orphan SAP orders
node    scripts/tag_needs_review.js           # Status field on every profile
pm2 restart sap-logistics
```
