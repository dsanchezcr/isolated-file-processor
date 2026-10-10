# SupportShield — isolated file processor

Authenticated, asynchronous ingestion of hostile attachments. The gateway inspects
at most 512 signature bytes; parsers run only in disposable, networkless Docker
containers on a **dedicated execution host**. Only validated, rebuilt output may
enter clean storage. Failures end as `QUARANTINE_REJECTED`, never an original-file
fallback.

**Deployment limitation:** Azure Container Apps can host the gateway, but cannot
run this repository's Docker sibling-container sandbox. The Azure worker is
disabled by default; its opt-in KEDA blueprint intentionally fails closed. This
repository is not a complete production-functional ACA file-processing service.

## Architecture

```text
Untrusted client -- HTTPS + bearer API_KEY --> gateway (ACA or local Compose)
                                                | bounded upload
                                                v
                                         private quarantine
                                                |
                                   BullMQ / TLS Redis queue
                                                |
                                                v
                              worker / Docker controller
                              DEDICATED execution host
                                                |
                         network=none, read-only, limits, no credentials
                                                v
                               disposable parser container
                                                |
                                      validated rebuilt output
                                                v
                                           private clean
```

The Docker controller is privileged: access to its Docker socket is effectively
host-root access. Never expose that socket or mount it into the public gateway.
Container isolation and rasterization are risk reduction, **not antivirus or a
proof that an output is harmless**.

## Quickstart

Prerequisites: Node.js 22+, Docker with Compose, `openssl`, and `curl`. Run Docker
only on a disposable, dedicated development/execution machine.

```sh
npm ci
npm run typecheck
npm run build
npm test

# Secrets are generated at runtime, not committed to the repository.
export API_KEY="$(openssl rand -hex 32)"
export REDIS_PASSWORD="$(openssl rand -hex 32)"
export MINIO_ROOT_USER="$(openssl rand -hex 16)"
export MINIO_ROOT_PASSWORD="$(openssl rand -hex 32)"
export MINIO_ACCESS_KEY="$MINIO_ROOT_USER"
export MINIO_SECRET_KEY="$MINIO_ROOT_PASSWORD"
docker compose config --quiet
docker compose up --build -d
```

Never commit `.env` files, print secrets in CI logs, or share the generated API
key. See [deployment and local configuration](docs/deployment.md) for the exact
Compose settings and image publication instructions.

## API

All user-facing ingestion and status requests require an `Authorization` header
using the `Bearer` scheme with the API key. An absent or incorrect key is rejected; there is
no public unauthenticated job-status endpoint.

```sh
curl --fail-with-body \
  --oauth2-bearer "$API_KEY" \
  -F "file=@./sample.pdf" \
  http://localhost:3000/attachments

# Use the job ID returned by the 202 response:
curl --fail-with-body \
  --oauth2-bearer "$API_KEY" \
  "http://localhost:3000/attachments/FILE_ID"
```

`202 Accepted` means queued, not safe. Poll until a terminal result:
`CLEAN_READY` or `QUARANTINE_REJECTED`. See [API contract](docs/api.md) for
validation and lifecycle details. Webhook delivery is reserved, not implemented.

## Security envelope

| Bound | Maximum |
| --- | --- |
| Upload | 20 MiB |
| Expanded data / rebuilt output | 32 MiB each |
| Expansion ratio | 100:1 |
| Archive entries | 128 |
| Image pixels | 16,000,000 |
| PDF pages | 20 |
| Sandbox execution | 15 seconds |
| Sandbox memory / scratch | 256 MiB / 64 MiB |
| Sandbox CPU / processes | 0.5 CPU / 32 PIDs |

Archives with traversal, symlinks or nested archives are rejected. Limits and
signature checks do not establish file safety; parser vulnerabilities remain a
threat. See [threat model and controls](docs/security.md).

## Azure and supply chain

`deploy/bicep/main.bicep` provisions Log Analytics, Application Insights, a
VNet-integrated Container Apps environment, private-endpoint Blob Storage and
TLS-only Azure Cache for Redis, scoped identities, and the gateway. Quarantine
has a one-day lifecycle rule (asynchronous deletion, not an exact deletion SLA).
Redis availability/retirement and the missing ACA sandbox backend must be
resolved before any production rollout.

[Deployment guide](docs/deployment.md) covers compilation and `what-if`.
[Security guide](docs/security.md) covers GitHub Advanced Security, required
checks, Docker Scout, trust boundaries, and operational caveats. Repository
settings and external services must be enabled by administrators; files alone do
not enable those controls.
