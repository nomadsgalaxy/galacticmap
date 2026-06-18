-- CreateTable
CREATE TABLE "suggestion_votes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "suggestionId" TEXT NOT NULL,
    "tempId" TEXT NOT NULL,
    "voterHash" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "suggestion_votes_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "suggestions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "suggestion_votes_suggestionId_idx" ON "suggestion_votes"("suggestionId");

-- CreateIndex
CREATE UNIQUE INDEX "suggestion_votes_suggestionId_tempId_voterHash_key" ON "suggestion_votes"("suggestionId", "tempId", "voterHash");
