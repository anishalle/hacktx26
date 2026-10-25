"""Create three approved hackathon users; keep passwords in a private local file."""

import json
import os
import secrets
import string
import subprocess
from pathlib import Path

import boto3

ACCOUNT = "407902218075"
GROUP = "HackTXDevelopers"
USERNAMES = ("hacktx-dev-1", "hacktx-dev-2", "hacktx-dev-3")
TARGET = Path(__file__).resolve().parent / ".build" / "teammate-access.md"


def main() -> None:
    if TARGET.exists():
        raise RuntimeError("Access file already exists; refusing to replace passwords")
    profile = os.environ.get("AWS_PROFILE", "sunay")
    credentials = json.loads(
        subprocess.check_output(
            [
                "aws",
                "configure",
                "export-credentials",
                "--profile",
                profile,
                "--region",
                "us-east-1",
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
        region_name="us-east-1",
    )
    if session.client("sts").get_caller_identity()["Account"] != ACCOUNT:
        raise RuntimeError("Wrong AWS account")
    iam = session.client("iam")
    for username in USERNAMES:
        try:
            iam.get_user(UserName=username)
        except iam.exceptions.NoSuchEntityException:
            continue
        raise RuntimeError(f"User {username} already exists; refusing to overwrite")
    try:
        iam.get_group(GroupName=GROUP)
    except iam.exceptions.NoSuchEntityException:
        iam.create_group(GroupName=GROUP)
    iam.attach_group_policy(
        GroupName=GROUP,
        PolicyArn="arn:aws:iam::aws:policy/AdministratorAccess",
    )
    try:
        minimum = iam.get_account_password_policy()["PasswordPolicy"][
            "MinimumPasswordLength"
        ]
    except iam.exceptions.NoSuchEntityException:
        minimum = 8
    length = max(32, minimum)
    alphabet = string.ascii_letters + string.digits + "!@#$%*-_+="
    passwords = {}
    for username in USERNAMES:
        while True:
            password = "".join(secrets.choice(alphabet) for _ in range(length))
            if (
                any(c.islower() for c in password)
                and any(c.isupper() for c in password)
                and any(c.isdigit() for c in password)
                and any(c in "!@#$%*-_+=" for c in password)
            ):
                passwords[username] = password
                break
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    # Write credentials before AWS changes so interrupted creation is recoverable.
    fd = os.open(TARGET, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write(
            "# HackTX teammate access - private\n\n"
            "Share each person only their own credentials. Do not commit this file.\n\n"
            f"Account: `{ACCOUNT}`\n\n"
            f"Console: https://{ACCOUNT}.signin.aws.amazon.com/console\n\n"
            "Region: `us-east-1`\n\n"
            f"Group: `{GROUP}` (`AdministratorAccess`, entire account)\n\n"
            "Change passwords at first sign-in. No access keys were created.\n\n"
        )
        for username, password in passwords.items():
            output.write(
                f"## {username}\n\n"
                f"Username: `{username}`\n\n"
                f"Temporary password: `{password}`\n\n"
            )
        output.write(
            "## Setup on each teammate's computer\n\n"
            "1. Open the console link, sign in, and change the password.\n"
            "2. Install AWS CLI v2.32+ and run:\n\n"
            "```sh\n"
            "aws login --profile hacktx --region us-east-1\n"
            "export AWS_PROFILE=hacktx\n"
            "export AWS_REGION=us-east-1\n"
            "aws sts get-caller-identity\n"
            "```\n\n"
            "Choose your own IAM user in the browser; the account must be "
            f"`{ACCOUNT}`. Run `aws login` again when the session expires.\n\n"
            "Use `hacktx-newcomer` as the CloudFormation stack. "
            "The repo's infra/deploy.sh and infra/verify.py respect AWS_PROFILE. "
            "Have one person update the stack at a time. "
            "Get endpoints from CloudFormation Outputs; do not put AWS "
            "credentials in the frontend.\n"
        )
    for username in USERNAMES:
        iam.create_user(
            UserName=username,
            Tags=[{"Key": "Project", "Value": "hacktx-newcomer"}],
        )
        iam.add_user_to_group(GroupName=GROUP, UserName=username)
        iam.create_login_profile(
            UserName=username,
            Password=passwords[username],
            PasswordResetRequired=True,
        )
        iam.get_login_profile(UserName=username)
        assert any(
            group["GroupName"] == GROUP
            for group in iam.list_groups_for_user(UserName=username)["Groups"]
        )
        print(f"Created and verified {username}")
    print(f"Private access instructions: {TARGET}")


if __name__ == "__main__":
    main()
