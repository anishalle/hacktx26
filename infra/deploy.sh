#!/usr/bin/env bash
set -euo pipefail

infra_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
aws_profile="${AWS_PROFILE:-sunay}"
aws_region="${AWS_REGION:-us-east-1}"
stack_name="${STACK_NAME:-hacktx-newcomer}"
expected_account="${EXPECTED_AWS_ACCOUNT_ID:-407902218075}"

account_id="$(aws sts get-caller-identity --profile "$aws_profile" --region "$aws_region" --query Account --output text)"
if [[ "$account_id" != "$expected_account" ]]; then
  echo "Wrong AWS account: expected $expected_account; got $account_id" >&2
  exit 1
fi

python3 "$infra_dir/package.py"
sam validate --lint --template-file "$infra_dir/template.yaml" \
  --profile "$aws_profile" --region "$aws_region"
sam deploy \
  --template-file "$infra_dir/template.yaml" \
  --stack-name "$stack_name" \
  --profile "$aws_profile" \
  --region "$aws_region" \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides "ProjectName=$stack_name" \
  --tags Project=hacktx-newcomer

aws cloudformation describe-stacks \
  --stack-name "$stack_name" --profile "$aws_profile" --region "$aws_region" \
  --query 'Stacks[0].Outputs' --output json > "$infra_dir/.build/outputs.json"
echo "Stack outputs saved to infra/.build/outputs.json"
