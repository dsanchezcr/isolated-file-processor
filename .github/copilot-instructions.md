# SupportShield engineering contracts

- Use strict TypeScript. Explicit `any` and `unknown as any` are forbidden.
- Treat all uploads, job metadata, parser output, and filenames as hostile.
  Validation anomalies must end processing as `QUARANTINE_REJECTED`; never copy
  the original upload to clean storage as a fallback.
- Keep `src/core` framework-free, with no Node, Fastify, BullMQ, Azure, or Docker
  dependencies. Infrastructure must implement typed ports.
- The gateway may inspect at most 512 signature bytes; parsing belongs exclusively
  in a disposable networkless sandbox. Never invoke a parser in the gateway or
  queue worker host.
- Bound streams, expansion, entry count, pixels, pages, output, execution time,
  memory, CPU, and processes. Reject archive traversal, symlinks, and nesting.
- Use domain errors, map errors at HTTP and queue boundaries, await all work,
  handle shutdown, and never leave unhandled promise rejections.
- Never mount a Docker socket into a public-facing container. A Docker controller
  is a privileged trust boundary and requires a dedicated execution host.
- Add regression tests, run typecheck/build/tests, scan changes for secrets, and
  validate infrastructure and supply-chain changes before merging.
