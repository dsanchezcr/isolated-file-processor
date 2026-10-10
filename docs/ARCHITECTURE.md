# SupportShield architecture

## Processing flow and boundaries

```text
UNTRUSTED caller
    |
    | HTTPS + bearer service credential
    v
Gateway: authenticate, rate limit, bounded multipart stream
    | signature inspection <= 512 bytes; NO parser; NO Docker socket
    +--------------------> private quarantine-files
    |
    +--------------------> BullMQ attachments queue (prefix bull)
                                      |
                                      v
                    Dedicated execution-host worker
                    Validate job metadata; fetch bounded input
                    Privileged Docker controller, NOT an ACA worker
                                      |
                        bounded stdin / stdout, no host bind mounts
                                      v
                    Disposable parser container
                    network=none, read-only, non-root,
                    capabilities dropped, no-new-privileges,
                    CPU/memory/PID/scratch/time/output limits
                                      |
                         validated rebuilt bytes only
                                      v
                             private clean-files
                                      |
                         authenticated status polling
```

The clean result must never be an unchecked copy of the original upload.
Signature matching only selects an isolated transformation; it is not a safety
verdict. Parser output, filenames and queue metadata remain hostile across every
boundary. The public API never invokes a parser or obtains Docker privileges.

## Domain and infrastructure

`src/core` contains framework-free domain models, fixed policy and typed ports
for storage, queues, telemetry and sandbox execution. Node, Fastify, BullMQ,
Azure SDK and Docker details belong in adapters, not core.

The gateway generates object/job identifiers, bounds streamed uploads, records
quarantine metadata and enqueues work only after acceptance. The worker validates
the queue envelope and invokes a sandbox port. Docker is the currently supported
reference backend: its controller creates and disposes a new container for each
job. Parsers execute only inside that container; they do not receive cloud
identity, Redis credentials, API keys or network access.

The input envelope is 20 MiB; expansion and rebuilt output each cap at 32 MiB;
ratio is at most 100:1; archives cap at 128 entries and reject traversal, symlinks
and nesting; PDFs cap at 20 pages and images at 16 million pixels. Docker caps
memory at 256 MiB, scratch at 64 MiB, CPU at 0.5 and PIDs at 32. The execution
deadline is 15 seconds. Shutdown and errors must await cleanup; failures reject
rather than silently bypass a control.

## Lifecycle and API

```text
authenticated upload -> QUEUED -> PROCESSING -> CLEAN_READY
                              \              \-> QUARANTINE_REJECTED
                               \----------------> QUARANTINE_REJECTED
```

`202` means accepted for asynchronous processing, not clean. Poll the returned
status URL with the same bearer credential. Both ingestion and status are
authenticated; there is no unauthenticated user-facing status route. A shared
service key is not per-user authorization: tenant ownership and download
authorization would require additional reviewed layers. Webhook delivery is
reserved and not implemented. See [API specification](API_SPEC.md).

Azure quarantine expires asynchronously after more than one day without
modification. Long-lived queued jobs can lose their input and must then reject.
Clean storage remains private. This reference does not provide a public download
endpoint or automatically enforce business retention on clean artifacts.

## Azure topology and supported execution

`deploy/bicep/main.bicep` assembles modular Log Analytics/Application Insights,
VNet-integrated ACA environment, private-endpoint storage, TLS-only private Redis,
distinct managed identities and gateway. Gateway has quarantine contributor
access only; worker has quarantine reader and clean contributor access. Storage
account keys and anonymous/public blob access are disabled.

**ACA cannot run the local Docker sibling-container backend.** The template's
`workerDeploymentEnabled` parameter defaults to false. Its optional
`containerApps.bicep` worker is only a scaling blueprint, sets
`SANDBOX_BACKEND=disabled` and intentionally fails startup. It is not a functioning
production Azure worker. No exposed Docker TCP endpoint bridges that gap.

A separate dedicated execution host must have reviewed network/DNS connectivity,
identity assignment, hardening and a pinned pre-pulled sandbox image. The Docker
socket is host-root-equivalent even when mounted read-only. Never mount it in a
gateway, share the host with unrelated workloads, or treat UID restrictions as
protection against a malicious Docker controller.

The future KEDA design watches `bull:attachments:wait` over TLS with an ACA secret,
min replicas zero and max five. It does not observe delayed/prioritized/active
jobs and has not been validated with a supported ACA sandbox backend. Queue key
changes must update the scaler.

## Observability and assurance

ACA console logs reach Log Analytics. Application Insights is provisioned, but
the current OpenTelemetry adapter requires a configured OTLP exporter endpoint;
a connection string alone does not activate trace export. A reviewed collector
or Azure Monitor integration and environment-specific alerting remain required.

Rebuilding/rasterization reduces some active-content risks but is not antivirus,
DLP or a guarantee that visible content is harmless. Kernel/container escape,
parser compromise, supply-chain risk, queue tampering and credential compromise
remain in the [threat model](THREAT_MODEL.md). See [deployment](deployment.md) for
explicit local socket opt-in, image publication and Azure deployment limitations.
