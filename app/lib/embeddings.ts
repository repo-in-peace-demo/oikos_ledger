// Shared OpenAI embedding helper — text-embedding-3-small, 1536 dims, matches the vector columns
// on transactions, merchants, query_cache, episodic_events, and semantic_facts.
import { openai } from "@/lib/openai"

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
    dimensions: 1536,
    user: "oikos-ledger",
  })
  return response.data[0].embedding
}
