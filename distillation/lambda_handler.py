"""AWS Lambda entry point — runs the distillation job on an EventBridge schedule."""

import logging
from typing import Any

from distillation.pipeline.distiller import run_distillation

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


def handler(event: dict, context: Any) -> dict:
    """Lambda entry point. Triggered by EventBridge on a schedule — the event payload is unused."""
    log.info("Distillation run started")
    summary = run_distillation()
    log.info("Distillation run finished", extra=summary)
    return {"status": "complete", **summary}


if __name__ == "__main__":
    print(handler({}, None))
