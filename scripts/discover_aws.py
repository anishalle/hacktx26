"""Inspect an existing stack; never creates, deploys, or changes AWS resources."""

import argparse
import json
from pathlib import Path

import boto3

EXPECTED_ACCOUNT = "407902218075"


def discover(profile: str | None, region: str, stack: str) -> dict:
    session = boto3.Session(profile_name=profile, region_name=region)
    identity = session.client("sts").get_caller_identity()
    if identity["Account"] != EXPECTED_ACCOUNT:
        raise RuntimeError(
            f"Profile belongs to {identity['Account']}; expected {EXPECTED_ACCOUNT}. "
            "Configure a separate teammate profile."
        )
    cfn = session.client("cloudformation")
    description = cfn.describe_stacks(StackName=stack)["Stacks"][0]
    outputs = {
        item["OutputKey"]: item["OutputValue"]
        for item in description.get("Outputs", [])
    }
    resources = []
    for page in cfn.get_paginator("list_stack_resources").paginate(StackName=stack):
        resources.extend(page["StackResourceSummaries"])
    result = {
        "account": identity["Account"],
        "region": region,
        "stack": stack,
        "outputs": outputs,
        "resources": [
            {
                "name": item["LogicalResourceId"],
                "type": item["ResourceType"],
                "id": item.get("PhysicalResourceId"),
            }
            for item in resources
        ],
        "env": {"AWS_REGION": region, "AWS_PROFILE": profile or ""},
    }
    output_mapping = {
        "databaseclusterarn": "DATABASE_CLUSTER_ARN",
        "databasesecretarn": "DATABASE_SECRET_ARN",
        "databasename": "DATABASE_NAME",
        "embeddingmodelid": "BEDROCK_EMBEDDING_MODEL_ID",
    }
    for key, value in outputs.items():
        setting = output_mapping.get(key.lower())
        if setting:
            result["env"][setting] = value
    rds = session.client("rds")
    databases = []
    for item in resources:
        resource_type = item["ResourceType"]
        physical = item.get("PhysicalResourceId")
        if resource_type == "AWS::RDS::DBInstance":
            db = rds.describe_db_instances(DBInstanceIdentifier=physical)[
                "DBInstances"
            ][0]
            if db["Engine"] == "postgres":
                databases.append(
                    {
                        "DATABASE_HOST": db["Endpoint"]["Address"],
                        "DATABASE_PORT": str(db["Endpoint"]["Port"]),
                        "DATABASE_NAME": db.get("DBName") or "postgres",
                        "DATABASE_SECRET_ARN": db.get("MasterUserSecret", {}).get(
                            "SecretArn", ""
                        ),
                    }
                )
        elif resource_type == "AWS::RDS::DBCluster":
            db = rds.describe_db_clusters(DBClusterIdentifier=physical)["DBClusters"][0]
            if "postgres" in db["Engine"]:
                databases.append(
                    {
                        "DATABASE_CLUSTER_ARN": db["DBClusterArn"],
                        "DATABASE_HOST": db["Endpoint"],
                        "DATABASE_PORT": str(db["Port"]),
                        "DATABASE_NAME": db.get("DatabaseName") or "postgres",
                        "DATABASE_DATA_API": str(
                            db.get("HttpEndpointEnabled", False)
                        ).lower(),
                        "DATABASE_SECRET_ARN": db.get("MasterUserSecret", {}).get(
                            "SecretArn", ""
                        ),
                    }
                )
    if len(databases) == 1:
        result["env"].update(databases[0])
        if not result["env"]["DATABASE_SECRET_ARN"]:
            secrets = [
                item["PhysicalResourceId"]
                for item in resources
                if item["ResourceType"] == "AWS::SecretsManager::Secret"
            ]
            if len(secrets) == 1:
                result["env"]["DATABASE_SECRET_ARN"] = secrets[0]
    elif len(databases) > 1:
        result["database_candidates"] = databases
    for key, value in outputs.items():
        if "claude" in key.lower() and (
            "model" in key.lower() or "profile" in key.lower()
        ):
            result["env"]["BEDROCK_CLAUDE_MODEL_ID"] = value
    if not result["env"].get("BEDROCK_CLAUDE_MODEL_ID"):
        profiles = (
            session.client("bedrock")
            .list_inference_profiles(typeEquals="SYSTEM_DEFINED")
            .get("inferenceProfileSummaries", [])
        )
        preferred = next(
            (
                item
                for item in profiles
                if "claude haiku 4.5" in item["inferenceProfileName"].lower()
                and item["status"] == "ACTIVE"
            ),
            None,
        )
        if preferred:
            result["env"]["BEDROCK_CLAUDE_MODEL_ID"] = preferred["inferenceProfileId"]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--stack", default="hacktx-newcomer")
    parser.add_argument("--write-env", action="store_true")
    args = parser.parse_args()
    result = discover(args.profile, args.region, args.stack)
    # Outputs may include sensitive values in a third-party template: never print them.
    print(
        json.dumps(
            {
                "account": result["account"],
                "region": result["region"],
                "stack": result["stack"],
                "resources": result["resources"],
                "output_names": list(result["outputs"]),
                "detected_settings": list(result["env"]),
                "database_count": len(result.get("database_candidates", []))
                or int(bool(result["env"].get("DATABASE_HOST"))),
            },
            indent=2,
        )
    )
    if args.write_env:
        path = Path(".env.aws.local")
        # Never overwrite an existing local configuration.
        with path.open("x", encoding="utf8") as file:
            for key, value in result["env"].items():
                file.write(f"{key}={json.dumps(value)}\n")
        print("Wrote .env.aws.local (gitignored); no secret values were fetched.")


if __name__ == "__main__":
    main()
