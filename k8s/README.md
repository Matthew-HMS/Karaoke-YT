# Deploying SingAlong on Kubernetes

The manifests in [`base/`](base/) run SingAlong as a **single-replica**
Deployment with a persistent volume for its database, exposed as a Service that
you front with your own TLS reverse proxy. There's no ingress controller or
cert-manager dependency — if you already terminate TLS somewhere, point it here
and you're done.

```bash
kubectl apply -k base/
kubectl -n karaoke rollout status deployment/singalong
curl -s http://<service-address>/healthz        # expect "ok"
```

## What you need to supply

The manifests are deliberately generic. Three things are yours to fill in:

1. **`AUTH_URL` in [`base/configmap.yaml`](base/configmap.yaml)** — your public
   origin. Google sign-in breaks if it doesn't match.
2. **A Secret named `singalong-secrets`**, created out-of-band so nothing
   sensitive lands in git:

   ```bash
   kubectl -n karaoke create secret generic singalong-secrets \
     --from-literal=AUTH_SECRET='...' \
     --from-literal=AUTH_GOOGLE_ID='...' \
     --from-literal=AUTH_GOOGLE_SECRET='...'
   ```

   Add any of the optional keys from [`.env.local.example`](../.env.local.example)
   the same way; leave one out and that feature simply stays off. Pods re-read
   the Secret on `kubectl -n karaoke rollout restart deployment/singalong`.
3. **A reverse proxy** in front of the Service that forwards **WebSocket upgrade
   headers** — real-time sync won't work without them:

   ```nginx
   proxy_http_version 1.1;
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   ```

   Also pass `X-Forwarded-For` and `X-Forwarded-Proto`, and optionally an
   `X-Country` header (an ISO country code from a GeoIP lookup) to improve how
   well song results match where your users are. Without it the app falls back
   to the browser's locale.

Images are built in CI and pushed to a container registry; make the package
public or add an `imagePullSecrets` entry to the pod spec.

## Operating notes

- **One replica is mandatory, not a default.** Live room state is in-process and
  the database is single-writer, so scaling past 1 breaks rooms. Doing it
  properly needs externalized room state (e.g. Redis with the Socket.IO
  adapter) and a networked database first.
- **Storage is node-local** with the default `local-path` provisioner. Favourites
  are the only durable state — rooms are ephemeral by design — but if the node
  holding the volume goes away, so do they until it's back.
- **A daily CronJob snapshots the database**
  ([`base/cronjob-backup.yaml`](base/cronjob-backup.yaml)), integrity-checks it,
  and keeps the newest few on a separate volume. That covers bad deploys and
  accidental deletes, not node loss — ship the snapshots off-node if you care
  about that.
- **Search depends on `yt-dlp`**, which self-updates on pod start; a daily
  CronJob ([`base/cronjob-ytdlp.yaml`](base/cronjob-ytdlp.yaml)) restarts the
  Deployment so it doesn't go stale between deploys.
- **Melody scoring needs to analyse song audio**, which is awkward to do from a
  datacenter IP. The app can either do it in-cluster or accept contours from a
  helper running elsewhere; either way the feature degrades on its own and the
  rest of the app is unaffected.
- **TLS lives entirely in your proxy.** Nothing in these manifests handles
  certificates.
- **Rolling back** is `kubectl -n karaoke set image deployment/singalong
  app=<registry>/<image>:<previous-tag>`.

> Hostnames, IP addresses, tokens and registry paths for a specific deployment
> belong in your own private notes, not in this file — **this repo is public.**
