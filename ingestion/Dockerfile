# Lambda container image for Oikos Ledger ingestion pipeline
FROM public.ecr.aws/lambda/python:3.12

# Install system dependencies for PostGIS and pgvector
RUN microdnf install -y \
    gcc \
    gcc-c++ \
    postgresql-devel \
    && microdnf clean all

# Copy requirements file
COPY requirements.txt ${LAMBDA_TASK_ROOT}/

# Copy Cockroachdb's root cert
COPY certs/root.crt ${LAMBDA_TASK_ROOT}/certs/root.crt

# Install Python dependencies
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

# Copy ingestion package
COPY . ${LAMBDA_TASK_ROOT}/ingestion/

# Set the Lambda handler
CMD ["ingestion.lambda_handler.handler"]
