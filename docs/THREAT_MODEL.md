# Threat model and operational security

## Assets and trust boundaries

Assets: original attachments, rebuilt outputs, API/Redis credentials, managed
identities, queue integrity, execution-host integrity and audit evidence.
Attackers may control every input byte, multipart field, filename, claimed MIME
type and job/parser metadata. Dependency and image compromise are separate
threats, not mitigated merely by validating file signatures.

```text
Internet / caller
   | TB1: HTTPS, authentication, rate/byte limits
Gateway (no parsers; no Docker socket)
   | TB2: private storage + TLS Redis; distinct identity
Quarantine / queue (untrusted data)
   | TB3: schema and job ownership validation
Privileged controller on dedicated execution host
   | TB4: bounded input + networkless disposable container
Untrusted parser and parser output
   | TB5: result validation, bounded rebuilt output only
Clean private storage
```

The controller's Docker socket is **host-root-equivalent**. Compromise of the
controller or Docker daemon can defeat the sandbox and its mounts. Never mount
the socket in the public-facing gateway, never use an unauthenticated remote
Docker endpoint, and never co-locate unrelated tenants/workloads on this host.
ACA cannot host this sibling-container controller. Containers share a kernel:
use a stronger sandbox/VM boundary for high-assurance or hostile multi-tenancy.

## STRIDE

| Threat | Controls | Residual risk / required operations |
| --- | --- | --- |
| Spoofing | Required bearer API key; separate UAMIs; TLS Redis; private endpoints | Shared key is not user/tenant identity; rotate it; authenticate trusted upload clients |
| Tampering | Bounded streaming; 512-byte signature gate; generated storage keys; hostile job/result validation; clean-only rebuilt output | Redis access keys are broad; protect credentials/network and validate every queue message |
| Repudiation | Structured job correlation, telemetry, boundary-mapped errors | Configure retention/alerting; avoid sensitive content; logs are not automatically immutable evidence |
| Information disclosure | Private containers; no storage account keys; least-privilege container RBAC; sandbox no network/credentials | Controller sees originals; output can still contain sensitive text/pixels; retention and tenant authorization require policy |
| Denial of service | 20 MiB input; 32 MiB expansion/output; 100:1 ratio; 128 entries; 20 pages; 16M pixels; 15s deadline; CPU/memory/PID/scratch limits | Upload concurrency and total queue backlog need capacity policy; Redis/host outages must reject or remain pending, never bypass validation |
| Elevation of privilege | Dedicated Docker host; capability drop; no-new-privileges; read-only/no-network sandbox; no parser on gateway/worker host | Kernel/daemon/container escape and parser exploits remain possible; patch host and parsers, prefer stronger isolation |

## Fail-closed processing

Signature acceptance is only routing, not content validation. PDF/image/archive
parsing belongs exclusively in the disposable container. Do not load a parser in
the gateway or controller to “preflight” data. Reject malformed results, oversized
or inconsistent outputs, unsupported types, traversal, absolute paths, symlinks,
nested archives and validation anomalies. Kill timed-out jobs, await cleanup and
map failure to `QUARANTINE_REJECTED`. Never copy the original upload into clean
storage on failure.

Image re-encoding and PDF rasterization/rebuilding remove some active structures
but are **not antivirus, DLP or a guarantee of harmless output**. Visible
malicious content, phishing, steganography and parser vulnerabilities remain.
File-signature detection can accept polyglots; bounded parsers must still reject
bad structure. Resource limits must apply during parsing, not only after output
has already consumed memory.

Storage/network controls do not make queue metadata trusted. Validate identifiers,
object locations, expected MIME/output format, byte counts and parser response
schemas before clean writes. External callers must not select host paths, Docker
arguments, images, parser commands or cloud object names.

## GitHub and supply chain

Workflows are automation, not evidence that repository security settings are
enabled. An administrator must:

1. Enable available GitHub Advanced Security/code scanning, secret scanning and
   push protection, subject to repository visibility and organization licensing.
2. Configure CodeQL analysis and inspect findings, not merely check for a YAML
   file. CodeQL cannot prove sandbox security or analyze all parser binaries.
3. Protect the release/default branch: require PR review and the actual CI,
   exploit-regression, CodeQL and image-scan checks; restrict bypass and pushes.
4. Give Actions minimal permissions. Use scoped Docker Hub publishing credentials
   (organization namespace, no administrator token) and Azure workload identity
   federation with subject restrictions, not long-lived Azure client secrets.
5. Pin action versions/image digests where possible; review Dependabot updates,
   npm lockfile changes and parser dependencies against advisory databases.
6. Use Docker Scout (or the configured image scanner) on gateway, worker and
   sandbox images. Gate actionable findings with an explicit reviewed exception
   policy; an unavailable scan must not be reported as a successful scan.
7. Scan changed files for secrets before commits. If one leaks, revoke/rotate it;
   deleting the file does not revoke credentials or erase Git history.

Keep installation/build scripts and supply-chain scanners away from production
secrets. Pull-request code is untrusted; do not expose publish credentials to fork
PRs or run their code in privileged `pull_request_target` contexts. SBOMs and
provenance are useful only if verified during promotion. Never claim a workflow
alone activates GHAS, branch protection, an Azure identity federation trust or
Docker Hub permissions.

## Operational acceptance checklist

- Test parser rejection for malformed/truncated content, polyglots, zip bombs,
  archive traversal/symlinks/nesting, excessive PDF pages/pixels and malicious
  parser result metadata.
- Inspect actual sandbox flags, network isolation, mount permissions, memory,
  CPU/PID/time/output limits and cleanup after crash/shutdown. Verify there is no
  original-file fallback.
- Check all user-facing API/status routes reject missing/incorrect credentials.
- Verify container-scoped Azure RBAC and that public Blob/Redis access is denied.
  Check private DNS from gateway and dedicated execution host.
- Set backlog/concurrency budgets and alerts for rejected jobs, sandbox timeouts,
  cleanup failures, queue age and infrastructure outages.
- Verify safe logs and correlation. Application Insights provisioning does not
  automatically create traces; instrument and validate actual telemetry.
- Exercise secret rotation, host/image patching, recovery and quarantine expiry.
- Complete an environment-specific security review and end-to-end load/exploit
  tests before production. Static Bicep compilation is not Azure deployment
  validation, and the disabled ACA worker is not a complete processing platform.
