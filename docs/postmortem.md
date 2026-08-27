# Storage-permission incident exercise

- Status: scheduled for the first live deployment
- Severity: portfolio exercise / no user data
- Date: 2026-08-27
- Scope: synthetic demo source only

## Intended exercise

Temporarily remove only the bucket-level `roles/storage.objectAdmin` binding for the dedicated recorder service account, start a short recording, observe upload failure and the terminal event, confirm no playback is exposed, restore the exact binding, and prove a subsequent recording reaches `READY`.

## Safety boundaries

- Change only the `vigil-<project-number>-recordings` bucket binding for `vigil-recorder@boltstream-r7m5o9ld.iam.gserviceaccount.com`.
- Do not change project-wide IAM, public-access prevention, worker cleanup access, or unrelated resources.
- Capture UTC timestamps and redacted logs; never record credentials or signed URLs.
- Restore the binding even if an intermediate assertion fails.

## Expected detection and response

The recorder should emit a redacted storage error, publish `RECORDING_FAILED`, and exit non-zero. The scheduler sees a failed Job but deterministic terminal event handling prevents state regression. The public API must show `FAILED` with no playback. Recovery is complete only after the binding is restored and a fresh recording produces valid H.264/AAC media.

## Actual timeline and findings

This section will be replaced with measured timestamps, alert/log evidence, recovery duration, and follow-up actions after the deployed exercise.
