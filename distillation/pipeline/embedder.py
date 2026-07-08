"""OpenAI embedding helper for newly written semantic_facts rows."""

import openai

from distillation.config import settings

_client: openai.OpenAI | None = None


def _get_client() -> openai.OpenAI:
    global _client
    if _client is None:
        _client = openai.OpenAI(api_key=settings.openai_api_key)
    return _client


def generate_embedding(text: str) -> list[float]:
    response = _get_client().embeddings.create(
        model="text-embedding-3-small",
        input=text,
        dimensions=1536,
    )
    return response.data[0].embedding
