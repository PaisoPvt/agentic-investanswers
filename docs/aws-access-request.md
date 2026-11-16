# AWS access needed to deploy the platform (dev account)

For the AWS administrator. Written for owner input OI-31 (task M2-01), 2026-11-16.

**Account:** dev, `448554876487`. **Region:** `us-east-1`. **Signed in as:** the `AWSARKDeveloperAccess` permission set (rehan.shams@ensosis.com; it replaced `AWSDeveloperAccess` on 2026-11-17).

The platform is described in AWS CDK (`infra/` in the repository) and deployed with `cdk deploy`. That permission set has no IAM rights, so neither CDK's one-time setup nor a deploy can run, because the ECS tasks need IAM roles. Option A below is the smallest request: the broad rights stay with CDK's own roles, which only CloudFormation uses.

## Option A (preferred): bootstrap CDK, let the permission set use its roles

1. **Run once** (for example in CloudShell in the dev account, us-east-1):

   ```
   npx aws-cdk@2 bootstrap aws://448554876487/us-east-1
   ```

   It creates an S3 bucket, an ECR repository, an SSM parameter and these roles:

   - `cdk-hnb659fds-deploy-role-448554876487-us-east-1`
   - `cdk-hnb659fds-file-publishing-role-448554876487-us-east-1`
   - `cdk-hnb659fds-image-publishing-role-448554876487-us-east-1`
   - `cdk-hnb659fds-lookup-role-448554876487-us-east-1`
   - `cdk-hnb659fds-cfn-exec-role-448554876487-us-east-1` (used only by CloudFormation)

2. **Add to the `AWSARKDeveloperAccess` permission set** (dev account only):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Sid": "UseCdkRoles", "Effect": "Allow", "Action": "sts:AssumeRole",
         "Resource": [
           "arn:aws:iam::448554876487:role/cdk-hnb659fds-deploy-role-448554876487-us-east-1",
           "arn:aws:iam::448554876487:role/cdk-hnb659fds-file-publishing-role-448554876487-us-east-1",
           "arn:aws:iam::448554876487:role/cdk-hnb659fds-image-publishing-role-448554876487-us-east-1",
           "arn:aws:iam::448554876487:role/cdk-hnb659fds-lookup-role-448554876487-us-east-1"
         ] },
       { "Sid": "ReadStack", "Effect": "Allow", "Action": ["cloudformation:DescribeStacks", "ssm:GetParameter"], "Resource": "*" },
       { "Sid": "OneOffHydrationTasks", "Effect": "Allow", "Action": "ecs:RunTask",
         "Resource": "arn:aws:ecs:us-east-1:448554876487:task-definition/aia-dev-hydration:*" },
       { "Sid": "PassTaskRoles", "Effect": "Allow", "Action": "iam:PassRole",
         "Resource": "arn:aws:iam::448554876487:role/aia-dev-*",
         "Condition": { "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" } } },
       { "Sid": "MassiveKey", "Effect": "Allow", "Action": ["secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret"],
         "Resource": "arn:aws:secretsmanager:us-east-1:448554876487:secret:aia-dev/*" },
       { "Sid": "PublishChart", "Effect": "Allow", "Action": ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
         "Resource": ["arn:aws:s3:::aia-dev-chart*", "arn:aws:s3:::aia-dev-chart*/*"] },
       { "Sid": "RefreshCdn", "Effect": "Allow", "Action": "cloudfront:CreateInvalidation", "Resource": "*" },
       { "Sid": "Logs", "Effect": "Allow", "Action": ["logs:StartLiveTail", "logs:FilterLogEvents", "logs:DescribeLogGroups"], "Resource": "*" }
     ]
   }
   ```

3. **Service-linked roles.** These are created automatically the first time each service is used, if allowed; or create them once:
   `AWSServiceRoleForECS`, `AWSServiceRoleForElasticLoadBalancing`, `AWSServiceRoleForElastiCache`, `AWSServiceRoleForCloudFrontVPCOrigin`.

4. **Organisation policy.** Please confirm the service control policy allows these in `us-east-1`: ECS (Fargate), ECR, ElastiCache (Serverless, Valkey), Elastic Load Balancing, DynamoDB, S3, Secrets Manager, CloudWatch Logs, CloudFormation, SSM (parameter read), and CloudFront (global). `eu-north-1` is denied today, which is fine; we deploy to `us-east-1`.

5. **Budget (optional, recommended).** A monthly budget alert on the dev account, or read access to Billing so we can set one. Expected cost: about $60 to $75 a month.

## What the stack creates (through CDK's roles, nothing more for you to create)

Four IAM roles, each limited to what it needs:

| Role | Used by | Allows |
|---|---|---|
| `aia-dev-platform-task-execution-role` | ECS starting the platform | pull the image from the CDK ECR repository, write the platform log group |
| `aia-dev-hydration-task-execution-role` | ECS starting hydration | the same, and read the `aia-dev/massive` secret |
| `aia-dev-platform-task-role` | the platform app | read the raw and cooked bar buckets; read and write the users table |
| `aia-dev-hydration-task-role` | the hydration app | read and write raw bars (no delete); read, write and delete cooked bars |

And: a VPC (2 zones, no NAT gateway in dev), 3 S3 buckets (raw bars versioned and retained), a DynamoDB table, an ElastiCache Serverless (Valkey) cache, an ECS cluster with two Fargate services, an internal Application Load Balancer, a CloudFront distribution with a VPC origin, a Secrets Manager secret and two CloudWatch log groups. No Lambda functions, so no other roles.

## Option B, if CDK cannot be bootstrapped

You create the four roles in the table above yourself, and either:
- deploy the CloudFormation template we generate (`pnpm synth`, file `infra/cdk.out/aia-dev.template.json`) with your own rights; the container image is pushed to an ECR repository first; or
- give the permission set `iam:PassRole` on those four roles and CloudFormation rights, and we deploy.

## Later: deploys from GitHub instead of a person

One role per account, for example `aia-github-deploy-dev`, trusted only by this repository's `dev` branch through GitHub's OpenID Connect provider (`token.actions.githubusercontent.com`, audience `sts.amazonaws.com`, subject `repo:rehanshamas/agentic-investanswers:ref:refs/heads/dev`), allowed only `sts:AssumeRole` on the four CDK roles above plus the chart publishing rights. Deploys then run on merge and nobody needs personal deploy rights.
