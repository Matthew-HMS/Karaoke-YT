// Shared-secret auth for the off-cluster reference-contour worker (the ingest
// POST and the pending list). The worker sends `Authorization: Bearer <token>`;
// the token is REFERENCE_INGEST_TOKEN in the cluster's Secret. When no token is
// configured the endpoints are closed, so nobody can inject/read without one.

export function ingestAuthOk(authHeader: string | null): boolean {
  const token = process.env.REFERENCE_INGEST_TOKEN || "";
  return token !== "" && authHeader === `Bearer ${token}`;
}
