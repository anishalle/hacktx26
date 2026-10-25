CREATE TABLE IF NOT EXISTS video_calls (
    id text PRIMARY KEY,
    group_id text NOT NULL,
    meeting_id text UNIQUE NOT NULL,
    meeting_json jsonb NOT NULL,
    started_ms bigint NOT NULL,
    ended_at timestamptz
);

CREATE TABLE IF NOT EXISTS video_call_members (
    call_id text NOT NULL REFERENCES video_calls(id) ON DELETE CASCADE,
    attendee_id text NOT NULL,
    user_id text NOT NULL,
    token_hash text UNIQUE NOT NULL,
    is_host boolean NOT NULL DEFAULT false,
    PRIMARY KEY (call_id, attendee_id)
);

CREATE TABLE IF NOT EXISTS video_call_transcripts (
    call_id text NOT NULL REFERENCES video_calls(id) ON DELETE CASCADE,
    result_id text NOT NULL,
    start_ms bigint NOT NULL,
    end_ms bigint NOT NULL CHECK (end_ms >= start_ms),
    text text NOT NULL,
    items jsonb NOT NULL DEFAULT '[]',
    is_partial boolean NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (call_id, result_id)
);

CREATE INDEX IF NOT EXISTS video_call_transcripts_time_idx
    ON video_call_transcripts (call_id, start_ms DESC);
