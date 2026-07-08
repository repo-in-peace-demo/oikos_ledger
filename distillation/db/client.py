"""CockroachDB engine and session factory for the distillation job — connects as oikos_recall_distill_rw."""

import logging
import os
from contextlib import contextmanager
from typing import Generator

from sqlalchemy import Engine, create_engine
from sqlmodel import Session

from distillation.config import settings

log = logging.getLogger(__name__)

_engine: Engine | None = None


def _get_engine() -> Engine:
    global _engine
    if _engine is None:
        if os.getenv("AWS_LAMBDA_FUNCTION_NAME"):
            cert_path = f'{os.getenv("LAMBDA_TASK_ROOT")}/certs/root.crt'
            database_url = f"{settings.distill_database_url}&sslrootcert={cert_path}"
            _engine = create_engine(database_url)
        else:
            _engine = create_engine(settings.distill_database_url)
    return _engine


@contextmanager
def get_session() -> Generator[Session, None, None]:
    """Yield a SQLModel session, committing on success and rolling back on exception."""
    with Session(_get_engine()) as session:
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
