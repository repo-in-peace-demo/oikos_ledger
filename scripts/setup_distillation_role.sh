#!/bin/bash
# Setup IAM execution role for the distillation Lambda
# Run once before the first deployment
# CloudWatch Logs only — this function never touches S3, unlike the ingestion role

set -e

ROLE_NAME="oikos-recall-distillation-role"
REGION=${AWS_REGION:-ap-south-1}
AWS_PROFILE=${AWS_PROFILE:-}

# Create trust policy
cat > /tmp/distillation-trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# Create role
echo "Creating IAM role: ${ROLE_NAME}"
aws iam create-role \
  --role-name ${ROLE_NAME} \
  --assume-role-policy-document file:///tmp/distillation-trust-policy.json \
  --query Role.Arn \
  --output text

# Attach basic Lambda execution policy (CloudWatch Logs only)
aws iam attach-role-policy \
  --role-name ${ROLE_NAME} \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole


# --- ECR permission fix for the deploying user (oikos_recall), not this role ---
# CreateFunction from a container image requires the calling identity to have
# ecr:GetRepositoryPolicy / ecr:SetRepositoryPolicy so Lambda can attach its own
# pull-access policy on the repo. Update the user's existing inline ECR policy
# to include these, scoped to the distillation repo specifically.
echo "Updating oikos-recall-ecr-policy with repository-policy permissions..."
cat > /tmp/ecr-policy-update.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:GetRepositoryPolicy",
        "ecr:SetRepositoryPolicy"
      ],
      "Resource": "arn:aws:ecr:${REGION}:${ACCOUNT_ID}:repository/${ECR_REPO}"
    }
  ]
}
EOF

aws iam put-user-policy \
  --user-name oikos_recall \
  --policy-name oikos-recall-ecr-policy \
  --policy-document file:///tmp/ecr-policy-update.json

# Get role ARN
ROLE_ARN=$(aws iam get-role \
  --role-name ${ROLE_NAME} \
  --query Role.Arn \
  --output text)

echo "Role created: ${ROLE_ARN}"
echo ""
echo "Next step: deploy the function with this role:"
echo "./scripts/deploy_distillation_lambda.sh"
