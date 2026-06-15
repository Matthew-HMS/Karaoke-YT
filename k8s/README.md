# Deploying SingAlong on Kubernetes

Production deployment for the `wafer-order-management` cluster (kubeadm, 3× arm64
Oracle nodes, ingress-nginx, containerd). SingAlong runs as a **single replica**
(in-memory room state + single-writer SQLite), behind ingress-nginx with
cert-manager TLS. Images are built in CI and pushed to GHCR.

> Replace `EXAMPLE.duckdns.org` with your real DuckDNS host in
> [base/configmap.yaml](base/configmap.yaml) and [base/ingress.yaml](base/ingress.yaml)
> before applying. (The Let's Encrypt email is passed to the webhook chart in step 3.)

## One-time cluster setup

Run these once. They add isolated, cluster-wide components that don't touch your
existing `production`/`staging` workloads.

### 1. Storage — local-path-provisioner

```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.30/deploy/local-path-storage.yaml
kubectl -n local-path-storage get pod   # wait for Running
```

This creates a `local-path` StorageClass. (Data lands under `/opt/local-path-provisioner`
on whichever node the pod schedules to.)

### 2. Edge — expose ingress-nginx on :80/:443

The controller is currently `NodePort` (:30554/:32328). Make one node listen on
the standard ports via `hostPort`, then open them in Oracle:

```bash
kubectl -n ingress-nginx patch deployment ingress-nginx-controller --type=json -p '[
  {"op":"add","path":"/spec/template/spec/containers/0/ports/-","value":{"name":"http-host","containerPort":80,"hostPort":80}},
  {"op":"add","path":"/spec/template/spec/containers/0/ports/-","value":{"name":"https-host","containerPort":443,"hostPort":443}}
]'
```

Then:
- **Oracle Security List / NSG:** allow ingress TCP **80** and **443** from `0.0.0.0/0`.
- **Host firewall** (if `iptables`/`ufw` on the node blocks it): allow 80/443.
- **DuckDNS:** point your subdomain at that node's **public IP**.

Verify from outside: `curl -I http://EXAMPLE.duckdns.org` should reach nginx (404
from nginx is fine — it means traffic arrives).

### 3. TLS — cert-manager + DuckDNS DNS-01 webhook

The webhook chart installs the DNS-01 solver, stores your DuckDNS token, **and
creates the ClusterIssuers** — so there's no separate issuer or token secret to
apply by hand.

```bash
# cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl -n cert-manager rollout status deploy/cert-manager-webhook

# DuckDNS DNS-01 webhook + ClusterIssuers. The chart is NOT on a hosted helm
# repo, so install from the cloned chart path. (token from https://www.duckdns.org)
git clone https://github.com/ebrianne/cert-manager-webhook-duckdns.git
helm install cert-manager-webhook-duckdns \
  ./cert-manager-webhook-duckdns/deploy/cert-manager-webhook-duckdns \
  --namespace cert-manager \
  --set duckdns.token='YOUR_DUCKDNS_TOKEN' \
  --set clusterIssuer.production.create=true \
  --set clusterIssuer.staging.create=true \
  --set clusterIssuer.email='you@example.com' \
  --set logLevel=2

kubectl get clusterissuer   # expect cert-manager-webhook-duckdns-{production,staging}
```

The Ingress references `cert-manager-webhook-duckdns-production`. **Tip:** to avoid
Let's Encrypt rate limits while testing, first set the Ingress annotation
`cert-manager.io/cluster-issuer` to `...-staging`, confirm a cert issues, then
switch back to `...-production`.

## App deployment

### 4. Secrets (out-of-band — never committed)

From your `.env.local` values:

```bash
kubectl create namespace karaoke   # or let the kustomize apply create it first
kubectl -n karaoke create secret generic singalong-secrets \
  --from-literal=AUTH_SECRET='...' \
  --from-literal=AUTH_GOOGLE_ID='...' \
  --from-literal=AUTH_GOOGLE_SECRET='...' \
  --from-literal=YOUTUBE_API_KEY='...'
```

### 5. GHCR image pull

Make the GHCR package **public** (simplest — no pull secret needed):
GitHub → repo → Packages → `karaoke-yt` → Package settings → Change visibility → Public.

Or, if kept private, create a pull secret and reference it:

```bash
kubectl -n karaoke create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=YOUR_GH_USER \
  --docker-password=YOUR_GH_PAT_with_read:packages
# then add `imagePullSecrets: [{name: ghcr-pull}]` to base/deployment.yaml's pod spec.
```

### 6. Apply

```bash
kubectl apply -k base/
kubectl -n karaoke rollout status deployment/singalong
kubectl -n karaoke get pod,svc,ingress,pvc,certificate
```

Watch the cert issue (DNS-01 can take a couple minutes):

```bash
kubectl -n karaoke describe certificate singalong-tls
```

When `singalong-tls` is Ready, open `https://EXAMPLE.duckdns.org`.

### 7. Google OAuth

Add `https://EXAMPLE.duckdns.org/api/auth/callback/google` to the OAuth client's
authorized redirect URIs in Google Cloud Console.

## Continuous deploy

[`.github/workflows/build-image.yml`](../.github/workflows/build-image.yml) builds
the arm64 image, pushes `ghcr.io/<owner>/<repo>:sha-<commit>` + `:latest`, then
SSHes to the control-plane node and `kubectl set image` to that immutable tag.
Reuses the existing repo secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT`,
`DEPLOY_SSH_KEY`; the SSH user needs a working `kubectl` (kubeconfig) on the node.

**Rollback:** `kubectl -n karaoke set image deployment/singalong app=ghcr.io/<owner>/<repo>:sha-<previous>`.

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
