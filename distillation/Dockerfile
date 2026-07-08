# Lambda container image for the Oikos Recall distillation job
# Build context is the repo root (not this directory) — it needs ingestion/models and
# ingestion/certs alongside distillation/ itself. See scripts/deploy_distillation_lambda.sh.
FROM public.ecr.aws/lambda/python:3.12

# Install system dependencies for pgvector
RUN microdnf install -y \
    gcc \
    gcc-c++ \
    postgresql-devel \
    && microdnf clean all

# Copy requirements file
COPY distillation/requirements.txt ${LAMBDA_TASK_ROOT}/

# Copy CockroachDB's root cert — shared with the ingestion pipeline, not duplicated
COPY ingestion/certs/root.crt ${LAMBDA_TASK_ROOT}/certs/root.crt

# Install Python dependencies
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

# Copy the distillation package, plus the ingestion SQLModel definitions it reuses
# (EpisodicEvent, SemanticFact) — see distillation/pipeline/distiller.py
COPY distillation ${LAMBDA_TASK_ROOT}/distillation/
COPY ingestion/models ${LAMBDA_TASK_ROOT}/ingestion/models/

# Set the Lambda handler
CMD ["distillation.lambda_handler.handler"]
