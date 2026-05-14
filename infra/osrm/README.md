# OSRM — Self-hosted road routing for SAP Logistics Hub

Open-source routing engine that powers the **"אופטימיזציית כביש"** button in
the run details screen. Replaces Google Maps Distance Matrix — no API key,
no per-request cost, no rate limits, no external dependency.

## What it does

The Node backend (`backend/src/demo/routeOptimizer.js`) calls OSRM's
`/table/v1/driving/{coords}?annotations=distance` endpoint to get an N×N
matrix of real driving distances between stops. The backend then runs
nearest-neighbour + 2-opt on top of that matrix to find the shortest route.

OSRM runs as a Docker container bound to `127.0.0.1:5000`. The Node process
talks to it over localhost. OSRM has **no built-in auth** — exposing the
port to LAN or internet would let anyone hit the routing API. Don't change
the port binding.

## Prerequisites

| Component | Why |
|-----------|-----|
| Docker Desktop (Windows) | Runs the OSRM container |
| WSL2 | Docker Desktop's backend on Windows |
| ~2 GB free disk | OSM data + processed graphs + Docker image |
| ~3 GB free RAM (one-time, during initial build) | osrm-extract peak |
| ~700 MB RAM (steady state) | osrm-routed serving requests |

Install Docker Desktop and WSL2 from a PowerShell elevated terminal:

```powershell
wsl --install                              # one-time, needs admin + Windows restart
winget install --id Docker.DockerDesktop   # one-time, needs admin
```

After Docker Desktop is installed:
- Set "Start Docker Desktop when you sign in" in Settings → General
- The Docker daemon will then auto-start with Windows

## First-time setup

```bash
cd infra/osrm

# 1. Download the OSM extract (Israel + Palestine, ~120 MB).
#    Geofabrik refreshes this daily; you only need to refresh every few
#    months unless road geometry changes a lot in your area.
curl -L -o data/israel-and-palestine-latest.osm.pbf \
  https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf

# 2. Start the stack. First boot runs osrm-prepare (~10-15 min) and then
#    starts osrm-routed. Subsequent boots skip prepare.
docker compose up -d

# 3. Watch the prepare logs (optional)
docker compose logs -f osrm-prepare

# 4. Once osrm-prepare exits successfully, verify osrm-routed is up
curl 'http://localhost:5000/route/v1/driving/34.7818,32.0853;35.2137,31.7683'
# Expected: routes[0].distance around 60000-72000 (60-72 km Tel Aviv → Jerusalem)
```

## Steady-state operation

```bash
# Status
docker compose ps

# Logs
docker compose logs -f osrm

# Stop / start
docker compose stop osrm
docker compose start osrm

# Restart after Windows reboot (usually automatic via "Start Docker Desktop on login"
# + restart: unless-stopped policy)
docker compose up -d
```

## Updating OSM data

```bash
cd infra/osrm

# 1. Stop the routed service
docker compose stop osrm

# 2. Download fresh extract (overwrite)
curl -L -o data/israel-and-palestine-latest.osm.pbf \
  https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf

# 3. Delete the processed files so prepare reruns
rm data/israel.osrm*

# 4. Bring it back up — prepare rebuilds graphs, then routed restarts
docker compose up -d
```

## Backend integration

`backend/.env`:

```
OSRM_BASE_URL=http://localhost:5000
```

Behaviour:
- If `OSRM_BASE_URL` is unset → `POST /api/runs/:id/optimize` returns **HTTP 422**
  with code `MISSING_OSRM_URL` and does NOT touch StopOrder.
- If OSRM is unreachable or returns non-OK → **HTTP 502** with code
  `OSRM_API_FAILED`, again without touching StopOrder.
- On success → response includes `source: "osrm"` and `totalKm` based on
  driving distance.

## Troubleshooting

**"osrm-prepare" container exits with "FATAL: /data/...pbf is missing"**
→ The PBF wasn't downloaded. Step 1 of first-time setup.

**"osrm-prepare" exits with non-zero during partition/customize**
→ Out of RAM. Close Chrome / Office / other heavy apps and rerun
`docker compose up -d osrm-prepare`. Initial build peak is ~2-3 GB.

**Backend logs "Google Maps Distance Matrix נכשל"**
→ Stale logs from before OSRM migration. Restart sap-logistics PM2:
`pm2 restart sap-logistics --update-env`.

**Backend logs "OSRM אופטימיזציה נכשלה"**
→ OSRM not running. Check `docker compose ps`. If the `osrm` container
shows `unhealthy`, check `docker compose logs osrm` for the underlying
error.

**`curl http://localhost:5000/...` returns "connection refused"**
→ Docker Desktop isn't running. Open Docker Desktop from the Start menu.
The `unless-stopped` restart policy will bring OSRM up once Docker is up.

## Profile choice (car.lua)

We use the stock `car.lua` profile shipped with the OSRM image. This routes
on roads available to private cars. **Truck-specific routing** (height
restrictions, ZHQ areas, weight limits) is NOT considered — if a delivery
van takes a different route than a private car in some Tel Aviv neighbour-
hood, the optimizer won't notice. In practice this is a minor effect over
typical Israeli distribution areas, but worth being aware of.

To switch to a truck profile, you would need to bake a custom Lua file
into the image (the upstream image only ships car/foot/bicycle).
