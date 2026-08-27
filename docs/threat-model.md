# Threat notes

## Assets and trust boundaries

The protected assets are consent history, owner control capability, private database data, recorder execution budget, Kafka integrity, and stored media. The public internet reaches only the REST/UI Cloud Run service. Native lease RPCs require Cloud Run IAM. Data services and the synthetic source live on the dedicated private network.

## Principal threats and controls

| Threat | Control | Residual risk |
|---|---|---|
| Anonymous workload launch or consent change | Owner credential exchange, HttpOnly session, CSRF, same-origin checks, rate limits | Credential theft grants temporary operator capability until session expiry |
| Credential disclosure | Secret Manager, no frontend embedding, constant-time comparison, structured-log redaction, no service-account keys | An owner endpoint compromise still requires credential rotation |
| Recorder used for SSRF | Deployed source ID and URL fixed server-side; recorder scheme, credential, redirect, host, metadata, and playlist-size checks | DNS rebinding is irrelevant for the fixed IP/host deployment but would need stronger resolution pinning before arbitrary sources |
| Consent revoked during capture | Append-only revocation, immediate playback suppression, short renewable lease, recorder watchdog, partial-object deletion | Previously completed recordings follow ordinary retention; retroactive deletion is outside this demo |
| Duplicate or reordered events | Deterministic IDs/sequences, payload hashes, full-history reduction, DB transaction before offset commit | A permanently malformed authorized event can halt the small projector and requires runbook intervention |
| Object overwrite or false completion | Generation preconditions, checksum/size comparison on retry, deterministic names, projection-time final-object validation | Storage administrator compromise is outside application IAM controls |
| Compromised workload moves laterally | One KSA/GSA per workload, namespace RBAC, private nodes, NetworkPolicy, least-resource IAM | Project owners retain broad administrative power |
| Resource exhaustion | Owner-only requests, API limits, duration/concurrency checks, ResourceQuota, Pod resource limits, bounded spool and upload workers | The owner can intentionally spend within configured limits |
| Supply-chain mutation | Lockfiles, pinned base-image digests, deployed image digests, pinned GitHub Actions, generated-code drift and secret scan | Dependency provenance is not independently reproduced or signed in this portfolio version |

## Explicit non-goals

Vigil is single-owner and single-source. It does not claim multi-tenant isolation, DRM handling, arbitrary URL safety, seamless media resume, regional disaster recovery, or formal compliance certification.
