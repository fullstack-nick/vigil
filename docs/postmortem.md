# Storage-permission incident exercise

- Status: completed, alert observed, and recovered
- Severity: portfolio exercise / no user data
- Date: 2026-08-27
- Window: 05:00:22–05:05:14 UTC (4m 52s)
- Scope: synthetic demo source and Vigil's dedicated recordings bucket only

## Summary

The exercise intentionally removed the bucket-level `roles/storage.objectAdmin` binding from only the Vigil recorder service account. Recording `0d450786-bc77-4d0f-a1c8-010c887625e9` failed closed with `SEGMENT_UPLOAD_PIPELINE`; the public API exposed no playback. The binding was restored in a `finally` path and read back from IAM. Recovery recording `fead4a27-b2fd-4ce9-9586-a5bbf88e5b77` subsequently reached `READY`, and its public media endpoint returned HTTP 200.

## Timeline

| UTC | Observation |
| --- | --- |
| 05:00:22 | Exercise began after verifying the exact recorder binding existed. |
| 05:00:27 | Cloud Audit Logs recorded removal of the bucket binding by the owner account. |
| 05:00:58 | Scheduler created the intentionally affected recorder Job. |
| 05:01:00 | Recorder acquired a valid consent lease and began capture. |
| 05:01:05 | First segment upload received `403 storage.objects.create`; recording became `FAILED` and remained non-playable. |
| 05:01:08 | Cloud Audit Logs recorded restoration of the exact bucket binding. |
| 05:01:29 | First recovery scheduling attempt exposed a separate six-Job namespace quota exhaustion. |
| 05:04:48 | After terminal demo Jobs were removed, the scheduler was restarted and replayed the uncommitted command. |
| 05:04:52 | Recovery recorder Job was created. |
| 05:05:14 | Recovery reached `READY`; playback returned HTTP 200. |

## Impact and detection

The intended failure affected one 15-second synthetic recording. No user data, unrelated bucket, project-wide IAM binding, credential, or signed URL was involved. Detection was visible in three independent places: the recorder's redacted structured log contained the Storage `403`, the event projection exposed `SEGMENT_UPLOAD_PIPELINE`, and the public contract denied playback. The failed attempt left no published VOD object.

## Findings and corrective actions

The primary cause was the planned least-scope IAM removal, and restoration worked as designed. The exercise also found that a one-hour Job TTL could exhaust the namespace's six-Job quota during a compact demonstration. The scheduler logged the create failure but advanced its in-process fetch loop without retrying that uncommitted command; recovery therefore required a restart.

The implementation now retains a failed scheduling command and retries it with exponential backoff capped at 30 seconds, reduces finished-Job TTL to 60 seconds, isolates spool cleanup beneath an attempt-specific directory, and writes Go structured logs directly to stdout so Cloud Logging preserves their declared severity. The final cloud smoke suite rechecks success, consent revocation, forced Pod termination, and playback after these changes.

## Verification rerun

The corrected deployment was exercised again from 05:42:15–05:43:59 UTC. Recording `2e02e3a6-45fb-436f-97e3-b5e299ba0dc8` failed closed with `SEGMENT_UPLOAD_PIPELINE`; recovery recording `f9226d6b-6485-42fa-a7d7-506c53537d07` reached `READY` and returned HTTP 200 media after IAM restoration. Cloud Monitoring ingested a value of `1` for `logging.googleapis.com/user/vigil/recorder_failures` from the affected recorder Pod and opened alert `projects/boltstream-r7m5o9ld/alerts/0.obx4vbt3wg0i` at 05:46:13 UTC under policy `Vigil recorder failure`. The 60-second Job TTL prevented the quota issue seen in the first exercise.
