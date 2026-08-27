CREATE TABLE creators (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  public_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consent_grants (
  id uuid PRIMARY KEY,
  creator_id uuid NOT NULL REFERENCES creators(id),
  action text NOT NULL CHECK (action IN ('GRANTED', 'REVOKED')),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 120),
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 40),
  evidence_digest text CHECK (evidence_digest IS NULL OR length(evidence_digest) = 64),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX consent_grants_current_idx
  ON consent_grants (creator_id, occurred_at DESC, id DESC);

CREATE TABLE recordings (
  id uuid PRIMARY KEY,
  creator_id uuid NOT NULL REFERENCES creators(id),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 80),
  status text NOT NULL CHECK (status IN (
    'REQUESTED', 'STARTING', 'RECORDING', 'FINALIZING', 'READY',
    'CANCELLED', 'FAILED', 'REJECTED_NO_CONSENT'
  )),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  max_duration_seconds integer NOT NULL CHECK (max_duration_seconds BETWEEN 5 AND 600),
  requested_at timestamptz NOT NULL,
  stop_requested_at timestamptz,
  completed_at timestamptz,
  final_object_name text,
  final_byte_count bigint NOT NULL DEFAULT 0 CHECK (final_byte_count >= 0),
  duration_millis bigint NOT NULL DEFAULT 0 CHECK (duration_millis >= 0),
  segment_count integer NOT NULL DEFAULT 0 CHECK (segment_count >= 0),
  retention_expires_at timestamptz,
  purged_at timestamptz,
  projection_version bigint NOT NULL DEFAULT 0 CHECK (projection_version >= 0),
  public_demo boolean NOT NULL DEFAULT false,
  failure_code text,
  failure_message text,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'READY' OR final_object_name IS NOT NULL)
);

CREATE INDEX recordings_public_recent_idx
  ON recordings (requested_at DESC) WHERE public_demo = true;
CREATE INDEX recordings_active_idx
  ON recordings (status) WHERE status IN ('REQUESTED', 'STARTING', 'RECORDING', 'FINALIZING');
CREATE INDEX recordings_retention_idx
  ON recordings (retention_expires_at) WHERE purged_at IS NULL;

CREATE TABLE recording_attempts (
  id uuid PRIMARY KEY,
  recording_id uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  job_name text NOT NULL UNIQUE CHECK (length(job_name) BETWEEN 1 AND 63),
  job_uid text,
  lease_worker_id text,
  lease_expires_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  terminal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recording_id, ordinal)
);

CREATE INDEX recording_attempts_expired_lease_idx
  ON recording_attempts (lease_expires_at) WHERE lease_expires_at IS NOT NULL;

CREATE TABLE recording_events (
  event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 8 AND 128),
  recording_id uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES recording_attempts(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type IN (
    'RECORDING_STARTED', 'SEGMENT_UPLOADED', 'RECORDING_FINALIZING',
    'RECORDING_COMPLETED', 'RECORDING_FAILED', 'RECORDING_STOPPED'
  )),
  occurred_at timestamptz NOT NULL,
  payload bytea NOT NULL,
  payload_json jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (length(payload_hash) = 64),
  processed_at timestamptz NOT NULL DEFAULT now(),
  conflict_payload_json jsonb,
  conflict_payload_hash text,
  conflict_detected_at timestamptz,
  UNIQUE (attempt_id, sequence)
);

CREATE INDEX recording_events_history_idx
  ON recording_events (recording_id, attempt_id, sequence, occurred_at, event_id);

CREATE TABLE outbox_messages (
  command_id uuid PRIMARY KEY,
  aggregate_id uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  topic text NOT NULL,
  message_key text NOT NULL,
  payload bytea NOT NULL,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  locked_at timestamptz,
  locked_by text
);

CREATE INDEX outbox_unpublished_idx
  ON outbox_messages (created_at) WHERE published_at IS NULL;

INSERT INTO creators (id, display_name, public_demo)
VALUES ('00000000-0000-4000-8000-000000000001', 'Vigil Demo Source', true)
ON CONFLICT (id) DO NOTHING;

