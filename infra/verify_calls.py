"""Test deployed call control/text paths; no microphone/audio is simulated."""

import json
import os
import subprocess
import time
from pathlib import Path

import boto3
import httpx


def main() -> None:
    # Connect retries happen before any HTTP request is sent, including for POST.
    with httpx.Client(
        transport=httpx.HTTPTransport(
            retries=2,
            limits=httpx.Limits(keepalive_expiry=30),
        ),
        timeout=httpx.Timeout(35, connect=10),
    ) as client:
        verify(client)


def verify(client: httpx.Client) -> None:
    profile = os.environ.get("AWS_PROFILE", "sunay")
    region = os.environ.get("AWS_REGION", "us-east-1")
    credentials = json.loads(
        subprocess.check_output(
            [
                "aws",
                "configure",
                "export-credentials",
                "--profile",
                profile,
                "--region",
                region,
                "--format",
                "process",
            ],
            text=True,
        )
    )
    session = boto3.Session(
        aws_access_key_id=credentials["AccessKeyId"],
        aws_secret_access_key=credentials["SecretAccessKey"],
        aws_session_token=credentials.get("SessionToken"),
        region_name=region,
    )
    expected = os.environ.get("EXPECTED_AWS_ACCOUNT_ID", "407902218075")
    if session.client("sts").get_caller_identity()["Account"] != expected:
        raise RuntimeError("Wrong AWS account")
    stack = session.client("cloudformation").describe_stacks(
        StackName=os.environ.get("STACK_NAME", "hacktx-newcomer"),
    )["Stacks"][0]
    outputs = {item["OutputKey"]: item["OutputValue"] for item in stack["Outputs"]}
    secret = session.client("secretsmanager").get_secret_value(
        SecretId=outputs["CallsDemoKeySecretArn"],
    )
    demo_key = json.loads(secret["SecretString"])["key"]
    base = outputs["ApiUrl"] + "/api/v1"
    folder = Path(__file__).resolve().parent / ".build"
    env_file = folder / "calls-frontend.env"
    fd = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(f"EXPO_PUBLIC_CALLS_API_URL={base}\n")
        stream.write(f"EXPO_PUBLIC_CALLS_DEMO_KEY={demo_key}\n")
    checks = []

    def request(path, body=None, token=None, demo=False, expected_status=200):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Call-Token"] = token
        if demo:
            headers["X-Demo-Key"] = demo_key
        try:
            response = client.request(
                "POST" if body is not None else "GET",
                base + path,
                json=body,
                headers=headers,
            )
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise RuntimeError(
                f"HTTPS connection failed for {path} after 3 connection attempts: {exc}"
            ) from None
        except httpx.ReadTimeout:
            raise RuntimeError(
                f"Timed out waiting for {path}; not retried because the request "
                "may already have been processed"
            ) from None
        status, payload = response.status_code, response.json()
        if status != expected_status:
            # Responses never include the demo key or attendee tokens on errors.
            raise AssertionError(
                f"{path}: expected {expected_status}; got {status}: {payload}"
            )
        return payload

    def check(label):
        checks.append(label)
        print(f"PASS {label}", flush=True)

    request(
        "/calls",
        {"group_id": "video-backend-smoke", "user_id": "smoke-host"},
        expected_status=401,
    )
    check("unsigned_call_creation_denied")
    host = request(
        "/calls",
        {"group_id": "video-backend-smoke", "user_id": "smoke-host"},
        demo=True,
        expected_status=201,
    )
    call_id, host_token = host["call_id"], host["call_token"]
    prefix = f"/calls/{call_id}"
    ended = False
    try:
        check("create_chime_meeting_and_host")
        guest = request(prefix + "/join", {"user_id": "smoke-guest"}, demo=True)
        guest_token = guest["call_token"]
        assert guest["attendee"]["AttendeeId"] != host["attendee"]["AttendeeId"]
        check("join_returns_separate_attendee_and_call_token")
        request(
            prefix + "/transcription/start", {}, token=guest_token, expected_status=403
        )
        request(prefix + "/transcription/start", {}, token=host_token)
        check("host_can_request_transcription_guest_cannot")
        request(prefix + "/transcripts", token="wrong", expected_status=403)
        check("invalid_participant_token_denied")

        def result(result_id, text, partial=False):
            now = int(time.time() * 1000)
            return {
                "resultId": result_id,
                "isPartial": partial,
                "startTimeMs": now - 1000,
                "endTimeMs": now,
                "alternatives": [{"transcript": text, "items": []}],
            }

        definition = result("definition", "We call Swayam's house Grandma's.")
        word_start = definition["startTimeMs"] - 100
        definition["alternatives"][0]["items"] = [
            {
                "type": "pronunciation",
                "content": definition["alternatives"][0]["transcript"],
                "startTimeMs": word_start,
                "endTimeMs": word_start - 10,
                "attendee": {
                    "attendeeId": host["attendee"]["AttendeeId"],
                    "externalUserId": host["attendee"]["ExternalUserId"],
                },
            }
        ]
        request(prefix + "/transcripts", {"results": [definition]}, token=host_token)
        saved = request(prefix + "/transcripts", token=host_token)["results"][0]
        assert saved["start_ms"] == word_start
        assert saved["items"][0]["endTimeMs"] == word_start
        check("chime_word_bounds_are_preserved_and_stored")
        # Move the definition into the background, outside the 10-second focus.
        time.sleep(11)
        focus = result("focus", "Grandma's after the game.")
        request(prefix + "/transcripts", {"results": [focus]}, token=host_token)
        request(prefix + "/transcripts", {"results": [focus]}, token=guest_token)
        stored = request(prefix + "/transcripts", token=guest_token)["results"]
        assert len(stored) == 2
        check("sql_storage_and_duplicate_event_deduplication")
        start = time.perf_counter()
        explanation = request(
            prefix + "/explain",
            {"at_ms": focus["endTimeMs"]},
            token=guest_token,
        )
        explanation_ms = round((time.perf_counter() - start) * 1000, 1)
        assert explanation["status"] == "explained", explanation
        assert explanation["source"] == "conversation", explanation
        assert "definition" in explanation["source_result_ids"], explanation
        assert "swayam" in explanation["answer"].lower(), explanation
        check("bedrock_uses_background_to_explain_recent_reference")

        late = {
            **focus,
            "isPartial": True,
            "alternatives": [{"transcript": "incorrect late partial", "items": []}],
        }
        request(
            prefix + "/explain",
            {
                "at_ms": focus["endTimeMs"],
                "pending_results": [late],
            },
            token=guest_token,
        )
        stored = request(prefix + "/transcripts", token=guest_token)["results"]
        assert (
            next(row for row in stored if row["result_id"] == "focus")["text"]
            == focus["alternatives"][0]["transcript"]
        )
        check("late_partial_cannot_overwrite_final_transcript")

        time.sleep(11)
        unknown = result("unknown", "Meet at Blorple's secret spot.")
        uncertain = request(
            prefix + "/explain",
            {
                "at_ms": unknown["endTimeMs"],
                "pending_results": [unknown],
            },
            token=guest_token,
        )
        assert uncertain["status"] == "unclear", uncertain
        check("unknown_personal_reference_is_not_invented")
        request(prefix + "/end", {}, token=guest_token, expected_status=403)
        request(prefix + "/end", {}, token=host_token)
        ended = True
        request(prefix + "/end", {}, token=host_token)
        check("host_end_is_idempotent_and_guest_cannot_end")
        report = {
            "checks": checks,
            "explanation_roundtrip_ms": explanation_ms,
            "example_answer": explanation["answer"],
            "limitations": [
                "Transcript events were synthetic, not from microphone audio.",
                "Transcription start acceptance does not prove a media stream started.",
            ],
        }
        (folder / "calls-verification.json").write_text(
            json.dumps(report, indent=2) + "\n"
        )
        print(f"Frontend environment file: {env_file}", flush=True)
    finally:
        if not ended:
            try:
                request(prefix + "/end", {}, token=host_token)
            except Exception:
                # Ensure test meetings do not remain active if the API itself fails.
                session.client("chime-sdk-meetings").delete_meeting(
                    MeetingId=host["meeting"]["MeetingId"],
                )
        session.client("rds-data").execute_statement(
            resourceArn=outputs["DatabaseClusterArn"],
            secretArn=outputs["DatabaseSecretArn"],
            database=outputs["DatabaseName"],
            sql=(
                "DELETE FROM video_calls "
                "WHERE id=:id AND group_id='video-backend-smoke'"
            ),
            parameters=[{"name": "id", "value": {"stringValue": call_id}}],
        )


if __name__ == "__main__":
    main()
