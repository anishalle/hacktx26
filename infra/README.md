# HackTX AWS infrastructure

One application CloudFormation/SAM stack in account `407902218075`, region
`us-east-1`, using AWS CLI profile `sunay`. SAM uses its existing managed S3
artifact bucket for deployment packages.

## Deploy

```sh
aws login --profile sunay --region us-east-1  # only if the session has expired
bash infra/deploy.sh
```

Requires AWS CLI v2, SAM CLI, Python 3 and uv. Packaging installs Linux x86_64
wheels into the ignored `infra/.build/` directory; Docker is not required.
The deploy script checks the account ID before making changes.

## Resources and boundaries

- API Gateway HTTP API and ordinary Lambda running FastAPI.
  `/api/v1/health` is public. Call routes use a shared prototype key for
  create/join and per-participant tokens thereafter; other API routes require
  AWS SigV4 authentication.
- AppSync Events with IAM authentication and `groups` / `users` namespaces.
  This is infrastructure only: client authentication, per-group access checks,
  and application publishing/subscription logic still need implementation.
  Do not embed AWS root or IAM access keys in the mobile app.
- Aurora PostgreSQL Serverless v2 with Data API, private subnets, encryption,
  generated credentials in Secrets Manager, and capacity range 0.5–2 ACU.
  Lambda is outside the VPC and accesses SQL over the authenticated Data API.
  No NAT gateway, RDS Proxy, provisioned concurrency, or additional vector DB.
- Private encrypted S3 bucket for recordings/imports.
- Lambda IAM permissions for SQL, its generated database secret, the media bucket,
  publishing to AppSync, Bedrock, and Chime meeting/transcription control.
- Chime Transcribe service-linked role and a generated demo key in Secrets Manager.
  Meetings are created on demand by the backend, not as permanent stack resources.
- Seven-day API/Lambda logs. No message bodies or credentials in access logs.

The runtime has `DATABASE_CLUSTER_ARN`, `DATABASE_SECRET_ARN`, `DATABASE_NAME`,
`MEDIA_BUCKET`, `APPSYNC_HTTP_ENDPOINT`, `APPSYNC_REALTIME_ENDPOINT`,
`GENERATION_MODEL_ID`, and `EMBEDDING_MODEL_ID` environment variables. The backend
database module is currently a stub; deploying services does not implement chat,
retrieval or glossary extraction. The Chime backend stores transcript events
forwarded by clients and explains recent speech. See [the call API contract](../docs/CALLS_API.md).

Bedrock is an account/region service, not a server deployed by CloudFormation.
The stack grants invocation permissions; model access and actual inference must
be checked separately. Default generation: Nova Lite; embeddings: Titan Text v2.

Aurora Data API returns SQL results as JSON. A later implementation should use
parameterized statements and cast vector values explicitly when using pgvector.
Do not assume the original direct-Postgres SQLModel connection design is wired up.

## Verify

```sh
uv run --with boto3 python infra/verify.py
```

Deployment outputs are saved to `infra/.build/outputs.json`. Check the health URL,
verify unsigned application routes return 403, enable `vector` via the Data API,
run a vector query, and invoke both configured Bedrock models. Measure those
operations separately; a healthy scaffold is not an end-to-end chat latency test.

## Costs and cleanup

The database has a nonzero minimum capacity and bills while idle. Lambda,
API Gateway, AppSync and Bedrock are usage-based; S3, secrets, and logs also bill.
Chime meeting usage and live Transcribe sessions incur usage charges.

Delete the stack when finished, using the console or `aws cloudformation
delete-stack`. Aurora takes a final snapshot and the media bucket is retained to
avoid losing data. Retained objects/snapshots continue billing until removed.
SAM's shared artifact bucket is outside this application stack.

## Teammate access

Use individual IAM users in one permissions group. For unrestricted hackathon
development, `AdministratorAccess` gives each member access to the whole account;
it is not restricted to this project's resources. Do not share the root login.
Each teammate uses a recent AWS CLI (v2.32+) with browser-based login:

```sh
aws login --profile hacktx --region us-east-1
export AWS_PROFILE=hacktx
export AWS_REGION=us-east-1
aws sts get-caller-identity
aws cloudformation describe-stacks --stack-name hacktx-newcomer \
  --query 'Stacks[0].Outputs' --output table
```

The deploy and verification scripts respect `AWS_PROFILE`. Share stack outputs
and region, not credentials. `infra/.build/outputs.json` contains endpoints and
resource identifiers, not passwords, but generated build files remain ignored.
Have one person deploy stack changes at a time; everyone can develop against the
same services. Teammate users/groups are not created by this application stack.

The approved users `hacktx-dev-1`, `hacktx-dev-2`, and `hacktx-dev-3` were created
in `HackTXDevelopers` by `infra/create_teammates.py`. Their separate temporary
console passwords are stored only in `infra/.build/teammate-access.md` (mode 600,
gitignored), and each must change their password on first login. No access keys
were created. Do not rerun user creation to reset credentials; the script refuses
to overwrite existing users or its private access file.
