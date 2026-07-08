#!/bin/bash
# Deploy the distillation job to AWS Lambda as a container image
# Usage: ./scripts/deploy_distillation_lambda.sh
# Requires: Docker, AWS CLI configured, .env.local with AWS/DB credentials
# Run scripts/setup_distillation_role.sh first if the IAM role doesn't exist yet.

set -e

# Load environment variables from .env.local
source .env.local

REGION=${AWS_REGION:-ap-south-1}
AWS_PROFILE=${AWS_PROFILE:-}
FUNCTION_NAME=${DISTILLATION_LAMBDA_FUNCTION_NAME:-oikos-recall-distillation}
ROLE_NAME="oikos-recall-distillation-role"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="oikos-recall-distillation"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}"

echo "Deploying to Lambda: ${FUNCTION_NAME} in ${REGION}"
echo "Account: ${ACCOUNT_ID}"

# Step 1: Create ECR repository if it doesn't exist
echo "Creating ECR repository..."
aws ecr describe-repositories \
  --repository-names ${ECR_REPO} \
  --region ${REGION} 2>/dev/null || \
aws ecr create-repository \
  --repository-name ${ECR_REPO} \
  --region ${REGION}

# Step 2: Authenticate Docker to ECR
echo "Authenticating Docker to ECR..."
aws ecr get-login-password \
  --region ${REGION} | \
docker login \
  --username AWS \
  --password-stdin \
  ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com

# Step 3: Build Docker image — context is the repo root, not distillation/, because the
# Dockerfile also copies ingestion/models and ingestion/certs (see distillation/Dockerfile).
echo "Building Docker image..."
docker build \
  --platform linux/amd64 \
  --provenance=false \
  --output type=docker \
  -t ${ECR_REPO}:latest \
  -f distillation/Dockerfile \
  .

# Step 4: Tag image for ECR
echo "Tagging image..."
docker tag ${ECR_REPO}:latest ${ECR_URI}:latest

# Step 5: Push image to ECR
echo "Pushing image to ECR..."
docker push ${ECR_URI}:latest

# Step 6: Create function if it doesn't exist, otherwise update its code
if aws lambda get-function --function-name ${FUNCTION_NAME} --region ${REGION} >/dev/null 2>&1; then
  echo "Function exists — updating code..."
  aws lambda update-function-code \
    --function-name ${FUNCTION_NAME} \
    --image-uri ${ECR_URI}:latest \
    --region ${REGION} \
    --output text \
    --query 'FunctionName'
else
  echo "Function does not exist — creating it..."
  ROLE_ARN=$(aws iam get-role --role-name ${ROLE_NAME} --query Role.Arn --output text)
  aws lambda create-function \
    --function-name ${FUNCTION_NAME} \
    --package-type Image \
    --code ImageUri=${ECR_URI}:latest \
    --role ${ROLE_ARN} \
    --timeout 300 \
    --memory-size 512 \
    --region ${REGION} \
    --output text \
    --query 'FunctionName'
fi

# Step 7: Wait for code update to complete
echo "Waiting for Lambda code update..."
aws lambda wait function-updated \
  --function-name ${FUNCTION_NAME} \
  --region ${REGION} \
  --output text \
  --query 'FunctionName'

# Step 8: Update Lambda runtime configuration
echo "Updating Lambda configuration..."
aws lambda update-function-configuration \
  --function-name ${FUNCTION_NAME} \
  --timeout 300 \
  --memory-size 512 \
  --region ${REGION} \
  --output text \
  --query 'FunctionName'

# Wait before setting env vars — two update-function-configuration calls
# cannot overlap; Lambda rejects the second while the first is in progress.
echo "Waiting for Lambda configuration update..."
aws lambda wait function-updated \
  --function-name ${FUNCTION_NAME} \
  --region ${REGION} \
  --output text \
  --query 'FunctionName'

# Step 9: Set environment variables
echo "Setting environment variables..."
aws lambda update-function-configuration \
  --function-name ${FUNCTION_NAME} \
  --region ${REGION} \
  --environment "Variables={DATABASE_URL_DIRECT=${DATABASE_URL_DIRECT},DISTILL_RW_PASSWORD=${DISTILL_RW_PASSWORD},DB_PROVIDER=${DB_PROVIDER:-cockroach},OPENAI_API_KEY=${OPENAI_API_KEY}}" \
  --output text \
  --query 'FunctionName'

echo ""
echo "Deployment complete!"
echo "Lambda function: ${FUNCTION_NAME}"
echo "Image: ${ECR_URI}:latest"
echo ""
echo "Next step: schedule it with ./scripts/setup_distillation_schedule.sh"
