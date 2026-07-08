// Shared CockroachDB Managed MCP Server client — server-side only, never import into a "use client" file.
// Connects via streamable HTTP transport. Tool names/params (select_query, insert_rows, database, query,
// cluster_id) were verified against the live Managed MCP Server's tools/list response before writing this.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"

const MCP_ENDPOINT = "https://cockroachlabs.cloud/mcp"
const MCP_DATABASE = "oikosledger"

// Tool names the Managed MCP Server is known to expose. Write-shaped tools are listed here only so
// callers can be asserted against — they must never be invoked from the interactive read paths
// (Macro, Compare). Read/write separation is enforced here in application code, not by the platform.
const WRITE_SHAPED_TOOLS = new Set(["insert_rows", "create_table", "create_database"])

let clientPromise: Promise<Client> | null = null
let toolsCache: Tool[] | null = null

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required to connect to the CockroachDB Managed MCP Server`)
  return value
}

async function connect(): Promise<Client> {
  const apiKey = requiredEnv("COCKROACHDB_MCP_API_KEY")
  const clusterId = requiredEnv("COCKROACHDB_MCP_CLUSTER_ID")

  const transport = new StreamableHTTPClientTransport(new URL(MCP_ENDPOINT), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "mcp-cluster-id": clusterId,
      },
    },
  })

  const client = new Client({ name: "oikos-recall", version: "0.1.0" })
  await client.connect(transport)
  return client
}

// Lazily connects once per server instance and reuses the connection across requests.
export async function getMcpClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = connect().catch((err) => {
      clientPromise = null
      throw err
    })
  }
  return clientPromise
}

// Enumerates the server's actual tools/list — used to validate tool names before calling them,
// rather than assuming a fixed contract.
export async function listMcpTools(): Promise<Tool[]> {
  if (toolsCache) return toolsCache
  const client = await getMcpClient()
  const { tools } = await client.listTools()
  toolsCache = tools
  return tools
}

function extractRows<T>(result: Awaited<ReturnType<Client["callTool"]>>): T[] {
  const structured = (result as { structuredContent?: unknown }).structuredContent
  if (Array.isArray(structured)) return structured as T[]
  if (structured && typeof structured === "object" && Array.isArray((structured as { rows?: unknown }).rows)) {
    return (structured as { rows: T[] }).rows
  }

  const content = (result.content ?? []) as Array<{ type: string; text?: string }>
  const textPart = content.find((c) => c.type === "text" && c.text)
  if (!textPart?.text) return []
  try {
    const parsed = JSON.parse(textPart.text)
    if (Array.isArray(parsed)) return parsed as T[]
    if (parsed && Array.isArray(parsed.rows)) return parsed.rows as T[]
    return []
  } catch {
    return []
  }
}

// Read-only helper for the interactive app path. Only ever calls `select_query` — never a
// write-shaped tool — so the Macro/Compare routes stay read-only by construction.
export async function mcpSelectQuery<T = Record<string, unknown>>(
  query: string,
  database = MCP_DATABASE,
): Promise<T[]> {
  const client = await getMcpClient()
  const result = await client.callTool({
    name: "select_query",
    arguments: { database, query },
  })
  if (result.isError) {
    throw new Error(`MCP select_query failed: ${JSON.stringify(result.content)}`)
  }
  return extractRows<T>(result)
}

export function assertReadOnlyTool(toolName: string): void {
  if (WRITE_SHAPED_TOOLS.has(toolName)) {
    throw new Error(
      `Refusing to call write-shaped MCP tool "${toolName}" from a read-only path`,
    )
  }
}
