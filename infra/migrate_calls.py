"""Apply the additive call schema through Aurora Data API."""

import json
import os
import subprocess
from pathlib import Path


def main() -> None:
    options = [
        "--profile",
        os.environ.get("AWS_PROFILE", "sunay"),
        "--region",
        os.environ.get("AWS_REGION", "us-east-1"),
        "--output",
        "json",
    ]

    def aws(*args):
        return json.loads(subprocess.check_output(["aws", *args, *options], text=True))

    expected = os.environ.get("EXPECTED_AWS_ACCOUNT_ID", "407902218075")
    if aws("sts", "get-caller-identity")["Account"] != expected:
        raise RuntimeError("Wrong AWS account")
    stack = aws(
        "cloudformation",
        "describe-stacks",
        "--stack-name",
        os.environ.get("STACK_NAME", "hacktx-newcomer"),
    )["Stacks"][0]
    outputs = {item["OutputKey"]: item["OutputValue"] for item in stack["Outputs"]}
    schema = Path(__file__).resolve().parents[1] / "backend/app/calls/schema.sql"
    for statement in schema.read_text().split(";"):
        if not statement.strip():
            continue
        aws(
            "rds-data",
            "execute-statement",
            "--cli-input-json",
            json.dumps(
                {
                    "resourceArn": outputs["DatabaseClusterArn"],
                    "secretArn": outputs["DatabaseSecretArn"],
                    "database": outputs["DatabaseName"],
                    "sql": statement.strip(),
                }
            ),
        )
    print("Call tables and index are ready")


if __name__ == "__main__":
    main()
