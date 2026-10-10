# Deployment and operations

## Supported boundary

The reference processing backend is local Docker on a **dedicated execution
host**. The gateway must not have a Docker socket. The queue worker/controller
needs Docker access to create sibling containers and is consequently a
privileged trust boundary; place no unrelated workloads on its host.

Azure Container Apps (ACA) does not expose a supported Docker daemon for sibling
containers. Running this Docker worker in ACA is **not supported**. The Bicep
default deploys a gateway and data services, but no processing worker. Jobs can
remain queued indefinitely unless a separate, securely connected execution host
is deployed. Do not expose a gateway that accepts uploads until processing,
capacity, monitoring and fail-closed behavior have been verified end to end.

`workerDeploymentEnabled=true` is a **design blueprint only**: its container sets
`SANDBOX_BACKEND=disabled` so worker configuration fails closed. It must never be
marketed as functional processing. A future ACA-compatible backend needs a typed
sandbox adapter, separate execution isolation and regression/security validation
before that gate may change. No insecure remote Docker endpoint is provided.

## Local development

Use a disposable machine with Docker/Compose and Node.js 22+. Local storage and
Redis are development fixtures, not substitutes for production network policy,
TLS and identity.

```sh
npm ci
npm run typecheck
npm run build
npm test

export API_KEY="$(openssl rand -hex 32)"
export MINIO_ACCESS_KEY="$(openssl rand -hex 16)"
export MINIO_SECRET_KEY="$(openssl rand -hex 32)"
export MINIO_IMAGE='YOUR_PATCHED_MINIO_IMAGE@sha256:YOUR_DIGEST'
export MINIO_MC_IMAGE='YOUR_REVIEWED_MINIO_MC_IMAGE@sha256:YOUR_DIGEST'
export DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
docker build --file docker/Dockerfile.sandbox-runner --tag sandbox-runner:local .
docker compose -f deploy/compose.yaml -f deploy/compose.override.yaml \
  --profile execution-host config --quiet
docker compose -f deploy/compose.yaml -f deploy/compose.override.yaml \
  --profile execution-host up --build -d
docker compose -f deploy/compose.yaml -f deploy/compose.override.yaml \
  --profile execution-host ps
```

`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` are the application's credentials;
Compose maps the same values to MinIO's root-user/root-password settings. These
development credentials intentionally match. Production must use narrowly scoped
service credentials or Azure managed identity, never an administrator credential.

The image placeholders must be replaced before these commands work.
`RELEASE.2025-10-15T17-29-55Z` fixes the specific 2025 advisory
`GHSA-jjjj-jwhf-8rgr`, but subsequent review found additional vulnerabilities
affecting that source and later upstream revisions with no verified patched
version. **Do not treat an October source build as currently vulnerability-free.**
`MINIO_IMAGE` must identify an operator-reviewed, maintained artifact with
applicable fixes, pinned by digest. This project supplies no such verified
fixture image; full Compose E2E is blocked until one is provisioned.
Independently review and pin the `mc` initialization image.
Set repository variables `MINIO_IMAGE` and `MINIO_MC_IMAGE` to the same reviewed
immutable references for integration CI. Do not automatically build vulnerable
old official source or substitute an older published image merely to make tests
run. Registry/network unavailability and unavailable patched fixtures are
validation limitations, not grounds to bypass advisory findings.

The base Compose file intentionally does **not** enable processing or mount a
Docker socket. The `execution-host` profile and explicit local override are an
opt-in grant of host-root authority to the controller, even with a read-only
socket mount. Use only on a dedicated disposable host. Linux socket group
discovery above may need a host-specific adaptation on other Docker platforms.
Gateway binds only to localhost; Redis, MinIO API and MinIO console publish no
host ports. Local Redis is unauthenticated/plaintext on an internal development
network; it is not the Azure TLS/authentication security model.

Do not use `docker compose config` without `--quiet` in shared logs: interpolation
can disclose secrets. Keep generated keys out of source control. Build the parser
image before processing; do not let hostile requests trigger arbitrary image
pulls. Check worker startup and an authenticated upload/poll round-trip, including
a rejection, before assuming a healthy container means healthy isolation.

```sh
curl --fail-with-body --oauth2-bearer "$API_KEY" \
  -F 'file=@./sample.pdf' http://localhost:3000/attachments
curl --fail-with-body --oauth2-bearer "$API_KEY" \
  http://localhost:3000/attachments/FILE_ID
docker compose -f deploy/compose.yaml -f deploy/compose.override.yaml \
  --profile execution-host logs --tail=100 gateway worker
docker compose -f deploy/compose.yaml -f deploy/compose.override.yaml \
  --profile execution-host down
```

Logs must not contain bearer keys, Redis credentials, original file content or
client-controlled paths. `docker compose down` need not delete persistent
volumes; delete retained development data deliberately after reviewing the
Compose volume configuration.

## Build and publish images

Use your own Docker Hub namespace; there is no pre-published trusted project
image to assume. Use immutable image digests in Azure rather than floating tags.

```sh
export DOCKERHUB_NAMESPACE='your-organization'
export IMAGE_TAG="$(git rev-parse --short HEAD)"
# Authenticate interactively or with --password-stdin, never a CLI password flag.
docker login
for target in gateway worker sandbox-runner; do
  image="docker.io/$DOCKERHUB_NAMESPACE/$target:$IMAGE_TAG"
  docker build --file "docker/Dockerfile.$target" --tag "$image" .
  docker push "$image"
done
```

For multi-platform artifacts with SBOM/provenance, use
`docker buildx bake --file docker/docker-bake.hcl` with the repository's registry
variables and a correctly configured builder. The manual loop above builds only
the current host's platform. Bake defaults use `support-shield/gateway:local`,
`support-shield/worker:local` and `support-shield/sandbox-runner:local`, plus the
`sandbox-runner:local` alias expected by Compose when `TAG=local`. The direct
sandbox build plus Compose commands above are also supported. Release automation
sets its registry variables explicitly.

For native local loading into a legacy Docker image store that cannot retain
attestations, the tested development-only build is:

```sh
docker buildx bake --file docker/docker-bake.hcl \
  --set '*.platform=linux/amd64' --provenance=false --sbom=false --load
```

Use your actual native platform instead of `linux/amd64` on another architecture.
Disabling attestations is only a local-store workaround, not a release policy:
production publishing must retain SBOM/provenance with a capable builder.
Before manually dispatching `04-build-and-scan.yml` (which calls
`05-deploy-azure.yml` after release checks)
on protected `main`, configure GitHub's protected `release` and `production`
environments:

| Configuration | Purpose |
| --- | --- |
| `DOCKERHUB_NAMESPACE` variable | Actual Docker Hub organization/namespace |
| `SCOUT_ORGANIZATION` variable | Actual Scout SaaS organization with configured policies |
| `AZURE_RESOURCE_GROUP`, `AZURE_PREFIX` variables | Approved gateway deployment target |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` variables | Deployment identity using Azure OIDC federation |
| `AZURE_ACR_NAME` variable (when configured) | Existing approved ACR selected for managed-identity image pulls |
| `PUBLIC_IMAGES_CONFIRMED=true` variable (only without ACR) | Explicit acknowledgement that images are publicly pullable when `acrName` is empty |
| `DOCKERHUB_TOKEN` secret | Scoped publishing/scanning credential |
| `API_KEY` secret | Gateway service credential, at least 32 characters |

Grant the Azure identity only deployment and required role-assignment permissions
on the approved target, and restrict federation subjects to the protected
environment/repository. Configure environment reviewers and allowed branches in
GitHub settings; workflow declarations alone do not establish approval policy.
Configure Scout SaaS policies separately; the local policy JSON is a description,
not automatic organization-policy activation.

Enforce the requested MIT/Apache-2.0/BSD license allowlist in real Scout
organization policy. Reference Poppler (GPL), libvips (LGPL), MinIO (AGPL) and
base-OS licenses can block that gate; no runtime exception is pre-approved.
Legal review and compatible component replacement or an explicitly authorized
policy change are required. Fail closed on image promotion until configured
Scout checks and required license approvals pass. A successful local build or
vulnerability-only scan is not license compliance.

The workflow publishes SHA-tagged images to
`ghcr.io/OWNER/REPOSITORY/{gateway,worker,sandbox-runner}` and
`docker.io/NAMESPACE/{gateway,worker,sandbox-runner}`; configure the protected ACR
target for the required Azure registry publication and use its immutable digests
for deployment. It deploys immutable digest
references, forces `workerDeploymentEnabled=false`, and performs ARM validation,
what-if, deployment and gateway revision/image checks when supplied with valid
Azure access. These are workflow capabilities, not a claim that Azure checks have
already passed in this checkout.

The sandbox image is a separate artifact and must be present on the execution
host. Pin and scan **all three** artifacts, not just the gateway. Image publishing
does not provision a secured worker host or configure GitHub/Azure permissions.
The release workflow publishes before Scout evaluates the artifacts. A pushed
tag alone is not approved for deployment: consume digests only after all release
checks pass, and implement a reviewed promotion/quarantine policy for registries.
Image-size budgets must distinguish compressed registry artifacts from local
uncompressed image sizes. Native validation reported approximately 291 MB for
gateway and 334 MB for worker uncompressed; a pinned Node 22 base plus the required
static Docker CLI already exceeds a 150 MB uncompressed worker budget before
application dependencies. Native gzip Docker exports measured 78,838,194 bytes
for gateway and 99,092,547 bytes for worker, each below 150 MB. Those are measured
compressed export streams, not registry-layer totals or uncompressed image sizes.
Measure each released platform and registry artifact independently; do not remove
required runtime/security components to report a misleading size target.
Set `acrName` to enable managed-identity pull from an existing same-resource-group
ACR. The template assigns **AcrPull**, scoped to that registry, to each distinct
gateway/worker UAMI and configures each ACA app's registry entry with its own
identity. It never enables ACR admin access or handles ACR passwords. Images must
use the actual registry login server and immutable digest; `acrName` does not
rewrite image references. When `acrName` is empty, no ACR roles/registry entries
are deployed and publicly pullable images are required.

ACR provisioning, approved repository/image promotion and publisher permissions
are separate protected infrastructure/release responsibilities. The deployer
needs role-assignment permission at the existing registry; the publisher needs
reviewed push rights, never shared admin credentials. This reference uses classic
registry RBAC with AcrPull; ABAC-enabled registries require a reviewed
repository-reader role configuration instead. Restrict Azure OIDC subjects to
the protected workflow/environment and grant only needed scopes.

Ensure ACR networking/private DNS permits image pulls from ACA and the dedicated
execution host. Private-endpoint-only ACR connectivity is not provisioned by this
template. If ACR exists in another resource group, extend the explicit resource
scope in a reviewed change rather than passing a misleading name. The public
image confirmation gate is unnecessary only when a configured ACR supplies the
managed-identity image pull path.

## Bicep modules

| Module | Resources / policy |
| --- | --- |
| `network` | VNet; delegated ACA subnet; separate private-endpoint subnet |
| `monitoring` | Log Analytics (30-day retention), workspace Application Insights |
| `identities` | Distinct gateway and worker user-assigned managed identities |
| `storage` | Private quarantine/clean containers; account-key access disabled; private endpoint; lifecycle; container-scoped RBAC |
| `redis` | Premium Azure Cache for Redis; TLS 1.2+, port 6380 only; private endpoint; no public access; no eviction |
| `containerAppEnv` | VNet-integrated ACA workload-profile environment; Log Analytics |
| `containerApps` | Authenticated gateway; opt-in nonfunctional worker/KEDA blueprint |

Gateway scales from one to ten replicas; the unsupported worker blueprint scales
from zero to ten. The HTTP scaler targets eight concurrent requests, below the
16-active-upload admission cap; autoscaling is not instantaneous capacity.
Gateway admission currently limits requests to 30/minute per observed client IP
per replica and concurrent uploads to 16 per replica. These in-process
limits are **not global quotas**: scaling adds admission capacity. Configure
global edge rate limits, caller quotas, total backlog/queue-age budgets and
execution-host capacity controls before production.
`trustProxy` is false: behind ACA/reverse proxies the observed IP may be the proxy,
not the originating caller. Review trusted proxy CIDRs and global edge limits
for the deployment topology; do not blanket-enable `trustProxy: true` or trust
arbitrary client-supplied forwarding headers.

The adapter uses containers `quarantine-files` and `clean-files`.
Gateway identity: **Storage Blob Data Contributor on quarantine only**.
Worker identity: **Storage Blob Data Reader on quarantine**, **Storage Blob
Data Contributor on clean**. Neither identity gets account-level Contributor,
Owner, account keys, or public blob access. The contributor role includes delete:
custom write-only roles may further constrain the gateway after validating the
storage adapter's exact operations. The gateway has no clean-read privilege; a
future download service needs its own reviewed authorization and identity.

Quarantine block blobs expire after more than one day since modification.
Azure lifecycle scheduling is asynchronous: this is not guaranteed deletion
exactly 24 hours after arrival. Versioning and soft-delete are disabled here so
the retention rule does not silently preserve previous versions. Clean retention
is deliberately unspecified; set a business retention/deletion policy before
production. A queued job that outlives quarantine retention must reject safely.

Queue commit followed by acknowledgement loss can leave acceptance ambiguous.
The gateway returns an error but retains quarantine after any enqueue attempt
fails, since Redis may have accepted the job. Do not “repair” that ambiguity by
deleting its active input. Retained orphans rely on lifecycle expiry; a client
retry can create a distinct job because client idempotency is not implemented.
Azure expiry is asynchronous, not an exact 24-hour SLA. Verify local MinIO's
quarantine lifecycle configuration independently; Azure's policy does not apply
to local object-store volumes.

Redis uses an access key, delivered only via an ACA secret reference. Storage
uses managed identity, not keys. Redis MI/token authentication is **not
implemented** by this blueprint or the KEDA password configuration. Keys are
broad Redis privileges: treat queue data as hostile, restrict network access,
rotate keys, and plan migration to per-service authentication if supported by
the chosen Redis and BullMQ adapters.

Azure Cache for Redis has announced retirement. Check current subscription
creation eligibility, region/SKU availability and retirement dates before
deploying; this Premium reference is not a long-term managed-service commitment.
Azure Managed Redis migration requires reviewing TLS endpoints, authentication,
clustering and BullMQ Lua/script compatibility rather than blindly replacing
the resource type.

## Compile, preview, deploy

Prerequisites: Azure CLI/Bicep, registered `Microsoft.App`, `Microsoft.Cache`,
`Microsoft.Storage`, `Microsoft.Network`, `Microsoft.ManagedIdentity`,
`Microsoft.OperationalInsights`, and `Microsoft.Insights` providers, plus a
subscription supporting these SKUs. The deployer needs resource deployment and
RBAC assignment permissions; the application identities do not.

```sh
az login
az account set --subscription YOUR_SUBSCRIPTION_ID
az group create --name support-shield --location eastus
az bicep build --file deploy/bicep/main.bicep --stdout > /dev/null

export API_KEY="$(openssl rand -hex 32)"
export GATEWAY_IMAGE='docker.io/your-organization/gateway@sha256:YOUR_DIGEST'
export WORKER_IMAGE='docker.io/your-organization/worker@sha256:YOUR_DIGEST'

# Do not enable shell tracing. Secure parameters are not emitted as outputs.
az deployment group what-if \
  --resource-group support-shield \
  --template-file deploy/bicep/main.bicep \
  --parameters prefix=support-shield location=eastus \
    gatewayImage="$GATEWAY_IMAGE" workerImage="$WORKER_IMAGE" \
    apiKey="$API_KEY" workerDeploymentEnabled=false

az deployment group create \
  --resource-group support-shield \
  --template-file deploy/bicep/main.bicep \
  --parameters prefix=support-shield location=eastus \
    gatewayImage="$GATEWAY_IMAGE" workerImage="$WORKER_IMAGE" \
    apiKey="$API_KEY" workerDeploymentEnabled=false
```

For a protected existing ACR, set `ACR_NAME` to its resource name, set both image
variables to that registry's approved digest references, and add
`acrName="$ACR_NAME"` to both preview/deployment parameter lists. Do not set
`PUBLIC_IMAGES_CONFIRMED` merely to bypass an ACR image-pull configuration error.

An environment-expanded secret argument can be visible to local process
inspection. Use a trusted deployment runner, disable shell tracing and prefer
approved secure parameter/Key Vault integration in CI. Never put actual values in
checked-in parameter files. Outputs include resource identifiers and the gateway
URL, never API or Redis credentials.

`deploy/bicep/main.bicepparam` reads deployment values from the environment rather
than committing credentials. Set `GATEWAY_IMAGE`, `WORKER_IMAGE` and `API_KEY`
before compiling or deploying it; prefix/location are editable nonsecret choices
and `workerDeploymentEnabled` remains false. With a recent Azure CLI/Bicep, use
`--parameters deploy/bicep/main.bicepparam` instead of individual parameters.
Do not persist generated parameter JSON: it contains resolved secure values.
The file also reads optional `ACR_NAME`, defaulting to empty.

Compilation is static validation, not proof of successful Azure provisioning.
Run `what-if`, a controlled deployment, DNS/private-endpoint resolution checks,
identity/RBAC checks and authenticated end-to-end tests in your subscription.
Account for eventual RBAC propagation and private DNS readiness. This template
does not configure custom domains, WAF, egress filtering, budgets, alert rules,
ACR provisioning/networking, availability-zone redundancy, backup or disaster recovery.
Private DNS zone names assume a resource group without conflicting existing
zones; integrate with centrally owned zones for shared-network deployments.

The template provisions Application Insights and references its connection
string through an ACA secret. The current application starts OpenTelemetry only
when `OTEL_EXPORTER_OTLP_ENDPOINT` is configured; it does not consume that
Application Insights connection string as an exporter. A reviewed collector or
Azure Monitor exporter integration is still required for application traces.
The optional `otlpEndpoint` deployment parameter defaults to empty and sets
`OTEL_EXPORTER_OTLP_ENDPOINT`. Point it only to a reviewed, reachable OTLP collector,
not an Application Insights ingestion URL. The parameter file reads that
environment variable, defaulting to empty. No collector, exporter authentication
or automatic trace delivery is provisioned.
ACA console logs reach Log Analytics independently. Do not point a generic OTLP
exporter at an Application Insights ingestion URL and assume compatibility.

## Dedicated execution host (external reference)

Provisioning that host is outside this Bicep template. Place it in a private
network connected to the service VNet/DNS. Use a reviewed Azure VM/host identity
assignment for the worker UAMI, or another audited identity federation flow;
creating a UAMI alone does not make it usable on an arbitrary server. Configure
the worker's Azure storage endpoint, identity and Redis TLS connection. Do not
grant it gateway API secrets.

The host needs hardened Docker, a pre-pulled pinned sandbox image, dedicated
scratch space, tested cleanup, bounded process/CPU/memory/time, and no public
Docker listener. Containers need `network=none`, read-only root filesystem,
capability drop, no-new-privileges and no cloud/queue/storage credentials. Only
the controller may access storage/Redis. Network isolation is not permission to
mount host directories broadly. Retain only sanitized audit events.

The current adapter streams bounded input/output over Docker attach and uses an
in-container tmpfs scratch directory rather than broad host bind mounts. Preserve
that boundary: do not add host-path mounts to make an incompatible deployment
appear functional. Do not connect an ACA worker to a host by exporting an
unauthenticated Docker TCP API.

## KEDA queue blueprint

BullMQ defaults to prefix `bull`, queue name `attachments`, and waiting list
`bull:attachments:wait`. The opt-in template uses that exact Redis list, TLS and
a secret-authenticated KEDA Redis scaler. It scales from zero, caps replicas at
ten, and never needs HTTP ingress. If the adapter changes the queue prefix/name,
the scaler must change too; `support-shield:wait` is **not** the default key.

This scaler observes only the waiting list. Delayed, prioritized,
waiting-children and active jobs are not equivalent to that list; it is not a
complete backlog/autoscaling solution for those BullMQ features. Zero-scale
activation must be tested with the actual queue features and worker backend.
Because this worker backend is unsupported in ACA, the blueprint deliberately
does not provide that verification or production processing.
