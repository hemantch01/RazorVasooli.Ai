-- Create table for CaseEmbedding
CREATE TABLE "CaseEmbedding" (
    "caseId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recovered" BOOLEAN NOT NULL,
    "amountInr" DOUBLE PRECISION NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "narrative" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseEmbedding_pkey" PRIMARY KEY ("caseId")
);

-- Create index
CREATE INDEX "CaseEmbedding_category_idx" ON "CaseEmbedding"("category");

-- Enable pgvector and add vector column
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE "CaseEmbedding" ADD COLUMN IF NOT EXISTS embedding vector(768);
CREATE INDEX IF NOT EXISTS "CaseEmbedding_embedding_idx" ON "CaseEmbedding" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
