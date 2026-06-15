# Deploying SingAlong on Kubernetes

Production deployment for the `wafer-order-management` cluster (kubeadm, 3× arm64
Oracle nodes, containerd). SingAlong runs as a **single replica** (in-memory room
state + single-writer SQLite), exposed as a **NodePort** Service. The **existing
host nginx** on the control-plane node (the single public entry point) terminates
TLS and reverse-proxies `sho-karaoke.duckdns.org` to it — so no ingress-nginx,
cert-manager, or DNS changes are needed. Images are built in CI → GHCR.

> `AUTH_URL` in [base/configmap.yaml](base/configmap.yaml) must match your public
> domain (already `https://sho-karaoke.duckdns.org`).

## One-time cluster setup

### 1. Storage — local-path-provisioner

```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.30/deploy/local-path-storage.yaml
kubectl -n local-path-storage get pod   # wait for Running
```

Creates a `local-path` StorageClass (data lands under `/opt/local-path-provisioner`
on whichever node the pod schedules to).

## App deployment

### 2. Secrets (out-of-band — never committed)

Reuse the same values as the old systemd app's `.env.local`:

```bash
kubectl create namespace karaoke
kubectl -n karaoke create secret generic singalong-secrets \
  --from-literal=AUTH_SECRET='...' \
  --from-literal=AUTH_GOOGLE_ID='...' \
  --from-literal=AUTH_GOOGLE_SECRET='...' \
  --from-literal=YOUTUBE_API_KEY='...'
```

### 3. GHCR image pull

Make the GHCR package **public** (simplest — no pull secret needed):
GitHub → repo → Packages → `karaoke-yt` → Package settings → Change visibility → Public.

Or, if kept private, create a pull secret and reference it:

```bash
kubectl -n karaoke create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=YOUR_GH_USER \
  --docker-password=YOUR_GH_PAT_with_read:packages
# then add `imagePullSecrets: [{name: ghcr-pull}]` to base/deployment.yaml's pod spec.
```

### 4. Apply + verify (without touching the live site)

The old app keeps serving the domain through Caddy; this just brings up the pod
and its NodePort alongside it.

```bash
kubectl apply -k base/
kubectl -n karaoke rollout status deployment/singalong
kubectl -n karaoke get pod,svc,pvc

# Smoke-test the new app directly via its NodePort (run on the control-plane node;
# 10.0.0.32 is its internal IP). Expect "ok".
curl -s http://10.0.0.32:30080/healthz
```

### 5. Cut over nginx

This node fronts TLS with **nginx** (`/etc/nginx`). Find the vhost for the domain
and repoint its `proxy_pass` from the old app to the NodePort, keeping the
WebSocket upgrade headers (Socket.IO needs them):

```bash
grep -rn 'sho-karaoke' /etc/nginx/    # locate the vhost file
```

In that server block's `location /`:

```nginx
location / {
    proxy_pass http://10.0.0.32:30080;   # was 127.0.0.1:3000 (old systemd app)
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx   # validate, then apply
curl -sI https://sho-karaoke.duckdns.org       # verify the public site
sudo systemctl disable --now singalong         # stop the old app once happy
```

**Rollback (seconds):** set `proxy_pass` back to `http://127.0.0.1:3000;`, then
`sudo nginx -t && sudo systemctl reload nginx` and `sudo systemctl start singalong`.

### 6. Google OAuth

The redirect URI `https://sho-karaoke.duckdns.org/api/auth/callback/google` is the
**same domain the old app already uses**, so it's almost certainly already
registered in Google Cloud — just confirm sign-in works after cutover.

## Continuous deploy

[`.github/workflows/build-image.yml`](../.github/workflows/build-image.yml) builds
the arm64 image, pushes `ghcr.io/<owner>/<repo>:sha-<commit>` + `:latest`, then
SSHes to the control-plane node and `kubectl set image` to that immutable tag.
Reuses the existing repo secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT`,
`DEPLOY_SSH_KEY`; the SSH user needs a working `kubectl` (kubeconfig) on the node.
nginx is untouched by deploys (it points at the stable NodePort).

**Rollback a bad image:** `kubectl -n karaoke set image deployment/singalong app=ghcr.io/<owner>/<repo>:sha-<previous>`.

## Backups

A daily CronJob ([base/cronjob-backup.yaml](base/cronjob-backup.yaml)) takes a
**consistent** snapshot of `singalong.db` (SQLite's online `.backup()` via the app
image), integrity-checks it, gzips it, and keeps the **14 newest** on the
`singalong-backups` PVC.

```bash
kubectl -n karaoke create job --from=cronjob/singalong-backup backup-now   # run on demand
kubectl -n karaoke logs job/backup-now
```

**Restore** a snapshot:

```bash
kubectl -n karaoke scale deploy/singalong --replicas=0          # release the DB
# list snapshots, then gunzip the chosen one over the live DB via a throwaway pod
# that mounts both PVCs:
kubectl -n karaoke run restore --rm -it --restart=Never --image=ghcr.io/matthew-hms/karaoke-yt:latest \
  --overrides='{"spec":{"containers":[{"name":"r","image":"ghcr.io/matthew-hms/karaoke-yt:latest","command":["sh","-c","ls -1 /backup; echo pick one, then: gunzip -c /backup/<file>.db.gz > /data/singalong.db"],"volumeMounts":[{"name":"d","mountPath":"/data"},{"name":"b","mountPath":"/backup"}]}],"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"singalong-data"}},{"name":"b","persistentVolumeClaim":{"claimName":"singalong-backups"}}]}}'
kubectl -n karaoke scale deploy/singalong --replicas=1
```

> **Off-node durability:** snapshots sit on a node-local PVC (same node as the
> data), so they cover corruption / bad deploys / accidental deletes — **not** node
> loss. For that, add an rclone step to the CronJob that ships `/backup` to object
> storage (OCI Object Storage / S3) with creds from a Secret.

## Operating notes

- **One replica is mandatory**, not a default — see the note in
  [base/deployment.yaml](base/deployment.yaml). Scaling out needs externalized
  room state (Redis + `@socket.io/redis-adapter`) and Postgres; until then `kubectl
  scale` beyond 1 will break rooms and the SQLite lock.
- **yt-dlp** self-updates on every pod start; the daily CronJob
  ([base/cronjob-ytdlp.yaml](base/cronjob-ytdlp.yaml)) forces that via a rollout
  restart so search doesn't rot between deploys.
- **Storage is node-local.** If the node holding the volume dies, the favorites DB
  is unavailable until it returns. Favorites are the only durable state; rooms are
  ephemeral by design.
- **TLS stays with nginx** (already proven on this node). Nothing in k8s handles
  certs.
```

