#!/bin/bash
# Create the EventBridge schedule that triggers the distillation Lambda
# Run once after ./scripts/deploy_distillation_lambda.sh has created the function

set -e

# ── Change this to adjust how often distillation runs ──────────────────────────
# Default: nightly at 02:00 UTC. EventBridge schedule expressions use UTC.
SCHEDULE_EXPRESSION="cron(0 2 * * ? *)"
# ─────────────────────────────────────────────────────────────────────────────

REGION=${AWS_REGION:-ap-south-1}
AWS_PROFILE=${AWS_PROFILE:-oikos-recall}
FUNCTION_NAME=${DISTILLATION_LAMBDA_FUNCTION_NAME:-oikos-recall-distillation}
RULE_NAME="oikos-recall-distillation-schedule"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
FUNCTION_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"

# --- Grant the deploying user (oikos_recall) EventBridge + Lambda permission-setting
# access, scoped to this specific rule and function. Neither was needed before now
# since the original project had no scheduled jobs.
echo "Granting EventBridge/Lambda permission-management access..."
cat > /tmp/eventbridge-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "events:PutRule",
        "events:PutTargets",
        "events:DescribeRule",
        "events:RemoveTargets",
        "events:DeleteRule"
      ],
      "Resource": "arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${RULE_NAME}"
    },
    {
      "Effect": "Allow",
      "Action": "lambda:AddPermission",
      "Resource": "${FUNCTION_ARN}"
    }
  ]
}
EOF

# aws iam put-user-policy \
#   --user-name oikos_recall \
#   --policy-name oikos-recall-eventbridge-policy \
#   --policy-document file:///tmp/eventbridge-policy.json

echo "Creating EventBridge rule: ${RULE_NAME} (${SCHEDULE_EXPRESSION})"
aws events put-rule \
  --name ${RULE_NAME} \
  --schedule-expression "${SCHEDULE_EXPRESSION}" \
  --state ENABLED \
  --region ${REGION} \
  --output text \
  --query 'RuleArn'

RULE_ARN=$(aws events describe-rule \
  --name ${RULE_NAME} \
  --region ${REGION} \
  --query 'Arn' \
  --output text)

echo "Allowing EventBridge to invoke the Lambda..."
aws lambda add-permission \
  --function-name ${FUNCTION_NAME} \
  --statement-id ${RULE_NAME} \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn ${RULE_ARN} \
  --region ${REGION} \
  2>/dev/null || echo "Permission already exists — skipping"

echo "Attaching Lambda as the rule's target..."
aws events put-targets \
  --rule ${RULE_NAME} \
  --targets "Id"="1","Arn"="${FUNCTION_ARN}" \
  --region ${REGION}

echo ""
echo "Schedule created: ${RULE_NAME} → ${FUNCTION_NAME} (${SCHEDULE_EXPRESSION})"