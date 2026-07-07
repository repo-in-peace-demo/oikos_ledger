flowchart LR
    %% Style Declarations
    classDef user fill:#e1f5fe,stroke:#0288d1,stroke-width:2px,color:#000
    classDef client fill:#efebe9,stroke:#5d4037,stroke-width:2px,color:#000
    classDef gateway fill:#fff3e0,stroke:#f57c00,stroke-width:2px,color:#000
    classDef compute fill:#e8f5e9,stroke:#388e3c,stroke-width:2px,color:#000
    classDef database fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px,color:#000
    classDef storage fill:#fce4ec,stroke:#c62828,stroke-width:2px,color:#000

    %% 1. Client Layer
    subgraph UserTier["👤 Client Boundary"]
        User["Browser / Client Canvas"]:::user
    end

    %% 2. Web Hosting & Compute Layer
    subgraph Vercel["⚡ Vercel — Next.js 15 Serverless Platform"]
        NextClient["Next.js UI Engine\n(Login · Transactions · Insights · Recs · Macro · Compare)"]:::client
        
        subgraph API["Backend API Routes"]
            AuthAPI["/api/auth"]:::compute
            TxnAPI["/api/transactions"]:::compute
            InsightsAPI["/api/insights/query\n(+ Cache Layer)"]:::compute
            SessionAPI["/api/insights/session"]:::compute
            RecsAPI["/api/recommendations"]:::compute
            MacroAPI["/api/macro"]:::compute
            CompareAPI["/api/accounts/compare"]:::compute
        end
    end

    %% 3. Identity Provider
    subgraph AuthCloud["🔐 Identity Provider"]
        Google["Google OAuth 2.0"]:::gateway
    end

    %% 4. AI Core Model Layer
    subgraph OpenAI["🧠 OpenAI Core API Platform"]
        GPT["GPT-4o-mini\n(NL→SQL · Insights · Fact Phrasing)"]:::gateway
        Embed["text-embedding-3-small\n(Query + Merchant + Fact Vectors)"]:::gateway
        Realtime["Realtime API\n(Bidirectional Voice Node)"]:::gateway
    end

    %% 5. Ingestion Pipeline (AWS)
    subgraph AWS["☁️ AWS Infrastructure (ap-south-1)"]
        S3["📦 [Amazon S3]\nStatement Document Store"]:::storage
        Lambda["⚡ [AWS Lambda]\nParse → Normalize → Embed"]:::compute
        EventBridge["⏰ [Amazon EventBridge]\nScheduled Cron Trigger"]:::gateway
        DistillLambda["⚡ [AWS Lambda]\nDistillation Job\n(Trend · Decay · Percentile)"]:::compute
    end

    %% 6. CockroachDB — Unified Data + Memory Layer
    subgraph CockroachCloud["🪳 CockroachDB Cloud (Mumbai · ap-south-1)"]
        MCP["🔌 Managed MCP Server\n(Read-only agent role · Write-scoped service account)"]:::gateway
        
        subgraph CRDB["CockroachDB Basic Cluster · Distributed Vector Index"]
            CoreTables["Core Ledger Tables\n• transactions  • bank_accounts\n• users  • merchants  • uploads\n• query_cache (pgvector 1536d)"]:::database
            Episodic["episodic_events\n(immutable · append-only)"]:::database
            Semantic["semantic_facts\n(vector index · decay fields)"]:::database
        end
    end

    %% --- Connection Pathways ---
    User -->|HTTPS| NextClient
    User -->|Direct Upload via Presigned URL| S3
    User <-->|Direct WebSocket Audio Stream| Realtime

    NextClient -->|Session Handshake| AuthAPI
    NextClient -->|Fetch Records| TxnAPI
    NextClient -->|Submit Text Prompt| InsightsAPI
    NextClient -->|Request Ephemeral Token| SessionAPI
    NextClient -->|POST Tailored Feeds| RecsAPI
    NextClient -->|Request macro context| MacroAPI
    NextClient -->|Request account comparison| CompareAPI

    AuthAPI <-->|Token Validation Exchange| Google

    TxnAPI -->|Read / Write Ledger Data| CoreTables
    InsightsAPI -->|Execute Compiled SQL| CoreTables
    InsightsAPI -->|Vector Semantic Search| CoreTables
    RecsAPI -->|Rolling Baseline Query| CoreTables

    InsightsAPI -->|Translate Text to SQL| GPT
    InsightsAPI -->|Generate Query Vector| Embed
    RecsAPI -->|Insight → Impact → Action Analysis| GPT
    SessionAPI -->|Provision Access Token| Realtime

    S3 -->|S3 Object Created Event Trigger| Lambda
    Lambda -->|Normalize Merchants| GPT
    Lambda -->|Generate Merchant Name Vectors| Embed
    Lambda -->|Atomic Row Insertion| CoreTables

    %% --- Memory Layer Connections ---
    MacroAPI -->|Recall via read-only role| MCP
    CompareAPI -->|Recall via read-only role| MCP
    RecsAPI -->|Recall via read-only role| MCP
    MCP -->|Query| Semantic
    MCP -->|Query| Episodic
    MacroAPI -->|Log new event| Episodic
    CompareAPI -->|Log new event| Episodic

    EventBridge -->|Scheduled invocation| DistillLambda
    DistillLambda -->|Batch-read via service account| MCP
    DistillLambda -->|Phrase distilled fact| GPT
    DistillLambda -->|Embed fact| Embed
    DistillLambda -->|Write-scoped update| MCP
    MCP -->|Read| Episodic
    MCP -->|Write| Semantic

    %% Apply structural container backgrounds
    class Vercel,AWS,AuthCloud,OpenAI,CockroachCloud compute;

    %% --- Dynamic Link Color Stylings ---
    %% Core CRUD to CockroachDB in Green
    linkStyle 11,12,13,14 stroke:#2e7d32,stroke-width:2.5px;

    %% Lambda ingestion write to CockroachDB in Blue
    linkStyle 22 stroke:#1565c0,stroke-width:2.5px;

    %% Insights/Recs routes to OpenAI in Purple
    linkStyle 15,16,17 stroke:#6a1b9a,stroke-width:2.5px;

    %% Lambda/Distillation to OpenAI in Black
    linkStyle 20,21,32,33 stroke:#212121,stroke-width:2.5px;

    %% Interactive recall + log path via MCP in Teal
    linkStyle 23,24,25,26,27,28,29 stroke:#00838f,stroke-width:2.5px;

    %% Batch distillation path via MCP in Deep Orange
    linkStyle 30,31,34,35,36 stroke:#e65100,stroke-width:2.5px;