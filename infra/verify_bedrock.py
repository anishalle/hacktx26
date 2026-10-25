"""One bounded live Bedrock probe through the local HTTP application.

Does not deploy anything, touch RDS, or require call audio.
The account check runs before the single paid inference request.
"""

import argparse
import json
import time

import boto3
from botocore.config import Config
from fastapi.testclient import TestClient

from app.core import bedrock
from app.main import app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--expected-account", default="407902218075")
    parser.add_argument(
        "--live",
        action="store_true",
        help="Make exactly one inference request after account validation",
    )
    args = parser.parse_args()
    config = Config(
        connect_timeout=3, read_timeout=8, retries={"total_max_attempts": 1}
    )
    session = boto3.Session(
        profile_name=args.profile, region_name=bedrock.settings.AWS_REGION
    )
    identity = session.client("sts", config=config).get_caller_identity()
    if identity["Account"] != args.expected_account:
        raise SystemExit(
            f"BLOCKED: profile account {identity['Account']} differs from "
            f"expected {args.expected_account}. No inference request sent."
        )
    print(
        json.dumps(
            {
                "account": identity["Account"],
                "region": bedrock.settings.AWS_REGION,
                "model": bedrock.settings.GENERATION_MODEL_ID,
            }
        )
    )
    if not args.live:
        print(
            "Identity check passed. Add --live for one request "
            "capped at 80 output tokens."
        )
        return
    runtime = session.client("bedrock-runtime", config=config)
    observed = {}

    def capture(parsed, **kwargs):
        for key in ("usage", "metrics", "stopReason"):
            if key in parsed:
                observed[key] = parsed[key]
        observed["request_id"] = parsed.get("ResponseMetadata", {}).get("RequestId")

    runtime.meta.events.register("after-call.bedrock-runtime.Converse", capture)
    bedrock._client = runtime
    bedrock.settings.MAX_OUTPUT_TOKENS_PER_REQUEST = 80
    start = time.perf_counter()
    with TestClient(app) as client:
        result = client.post(
            "/api/v1/explain/call",
            json={
                "call_id": "bedrock-verification",
                "user_id": "verification",
                "follow_up": "What does the nest refer to?",
                "recent_transcript": [
                    {
                        "speaker_id": "sam",
                        "speaker_name": "Sam",
                        "text": "We call the library the nest.",
                        "start_ms": 0,
                        "end_ms": 2000,
                    }
                ],
            },
        )
    print(
        json.dumps(
            {
                "http_status": result.status_code,
                "elapsed_ms": round((time.perf_counter() - start) * 1000),
                "result": result.json(),
                **observed,
            },
            indent=2,
        )
    )
    if result.status_code != 200 or not observed.get("request_id"):
        raise SystemExit("FAIL: live Bedrock roundtrip not verified.")
    answer = result.json()["answer"]
    if "library" not in answer.lower() or len(answer.split()) > 35:
        raise SystemExit("FAIL: response received, but meaning/length check failed.")
    print("PASS: one live API-to-Bedrock roundtrip; no database writes.")


if __name__ == "__main__":
    main()
