"""Exercise deployed infrastructure; report service timings, never credentials."""

import json
import os
import statistics
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


def main() -> None:
    profile = os.environ.get("AWS_PROFILE", "sunay")
    region = os.environ.get("AWS_REGION", "us-east-1")
    stack = os.environ.get("STACK_NAME", "hacktx-newcomer")
    # Capture temporary credentials in memory; never write or print them.
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
    identity = session.client("sts").get_caller_identity()
    expected = os.environ.get("EXPECTED_AWS_ACCOUNT_ID", "407902218075")
    if identity["Account"] != expected:
        raise RuntimeError("Wrong AWS account; refusing verification")
    cf = session.client("cloudformation")
    deployed = cf.describe_stacks(StackName=stack)["Stacks"][0]
    if deployed["StackStatus"] not in ("CREATE_COMPLETE", "UPDATE_COMPLETE"):
        raise RuntimeError(f"Stack is not ready: {deployed['StackStatus']}")
    outputs = {
        entry["OutputKey"]: entry["OutputValue"] for entry in deployed["Outputs"]
    }
    timings = {}

    def timed(label, operation):
        start = time.perf_counter()
        result = operation()
        timings[label] = round((time.perf_counter() - start) * 1000, 1)
        print(f"PASS {label}: {timings[label]} ms")
        return result

    def signed_request(url, service, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = AWSRequest(
            method="POST" if data is not None else "GET",
            url=url,
            data=data,
            headers={"Content-Type": "application/json"},
        )
        SigV4Auth(
            session.get_credentials().get_frozen_credentials(), service, region
        ).add_auth(request)
        with urllib.request.urlopen(
            urllib.request.Request(url, data=data, headers=dict(request.headers)),
            timeout=30,
        ) as response:
            return json.load(response)

    url = outputs["ApiUrl"]

    def health():
        with urllib.request.urlopen(f"{url}/api/v1/health", timeout=30) as response:
            value = json.load(response)
        assert value == {"status": "ok"}, value

    timed("health_first_request", health)
    samples = []
    for _ in range(5):
        start = time.perf_counter()
        health()
        samples.append(round((time.perf_counter() - start) * 1000, 1))
    timings["health_followup_median"] = statistics.median(samples)
    print(f"PASS health_followup_median: {statistics.median(samples)} ms")
    try:
        urllib.request.urlopen(f"{url}/api/v1/openapi.json", timeout=30)
    except urllib.error.HTTPError as exc:
        assert exc.code in (401, 403), exc.code
        print("PASS unsigned_application_route_denied")
    else:
        raise AssertionError("Application route unexpectedly allows unsigned access")
    schema = timed(
        "signed_application_route",
        lambda: signed_request(f"{url}/api/v1/openapi.json", "execute-api"),
    )
    assert "/api/v1/health" in schema["paths"]

    sql = session.client("rds-data")

    def execute(statement):
        return sql.execute_statement(
            resourceArn=outputs["DatabaseClusterArn"],
            secretArn=outputs["DatabaseSecretArn"],
            database=outputs["DatabaseName"],
            sql=statement,
        )

    timed("enable_pgvector", lambda: execute("CREATE EXTENSION IF NOT EXISTS vector"))
    result = timed(
        "vector_query",
        lambda: execute("SELECT '[1,0,0]'::vector <=> '[1,0,0]'::vector AS distance"),
    )
    assert result["records"][0][0].get("doubleValue") == 0, result

    s3 = session.client("s3")
    bucket = outputs["MediaBucketName"]
    key = "infrastructure-check/roundtrip.txt"
    try:
        s3.put_object(Bucket=bucket, Key=key, Body=b"hacktx-infrastructure-ready")
        result = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
        assert result == b"hacktx-infrastructure-ready"
        print("PASS private_s3_roundtrip")
    finally:
        s3.delete_object(Bucket=bucket, Key=key)

    events = timed(
        "appsync_publish",
        lambda: signed_request(
            outputs["EventsHttpUrl"],
            "appsync",
            {
                "channel": "/groups/infrastructure-check",
                "events": [json.dumps({"type": "infrastructure.check"})],
            },
        ),
    )
    if events.get("failed") or events.get("errors"):
        raise AssertionError(events)

    bedrock = session.client("bedrock-runtime")
    generation = timed(
        "bedrock_short_generation",
        lambda: bedrock.converse(
            modelId=outputs["GenerationModelId"],
            messages=[
                {"role": "user", "content": [{"text": "Reply with exactly: ready"}]}
            ],
            inferenceConfig={"maxTokens": 8, "temperature": 0},
        ),
    )
    assert generation["output"]["message"]["content"]
    timings["bedrock_reported_generation"] = generation["metrics"]["latencyMs"]
    embedding = timed(
        "bedrock_embedding",
        lambda: bedrock.invoke_model(
            modelId=outputs["EmbeddingModelId"],
            contentType="application/json",
            body=json.dumps(
                {"inputText": "a group nickname", "dimensions": 256, "normalize": True}
            ),
        ),
    )
    assert len(json.loads(embedding["body"].read())["embedding"]) == 256

    report = {
        "stack": stack,
        "region": region,
        "account": expected,
        "outputs": outputs,
        "timings_ms": timings,
        "health_followup_samples_ms": samples,
        "limitations": [
            "Timings are infrastructure probes, not chat/AI feature benchmarks.",
            "First health request is not guaranteed to represent a Lambda cold start.",
            "AppSync publish acceptance does not measure subscriber delivery latency.",
            "Service probes use the deployment identity, not the API role.",
        ],
    }
    target = Path(__file__).resolve().parent / ".build" / "verification.json"
    target.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Verification report: {target}")


if __name__ == "__main__":
    main()
