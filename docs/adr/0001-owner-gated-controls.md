# ADR-0001: public reads and owner-gated controls

- Status: accepted
- Date: 2026-08-27

## Context

A public portfolio should be inspectable without friction, but starting recorder Jobs creates cost and can be abused. Consent mutations also represent authorization evidence and cannot be anonymous.

## Decision

Public access is read-only and limited to records marked as public demos. An owner enters a server-held credential, exchanges it for a short-lived HttpOnly SameSite cookie, and supplies a per-session CSRF token on mutations. Login and general request rates are bounded. Source selection remains fixed server-side.

## Consequences

Visitors can inspect health, timelines, and completed media. They cannot grant/revoke consent, start/stop recordings, access private records, or mint signed URLs. Anonymous interactive recording would require a separate abuse-control design and is deliberately excluded.
