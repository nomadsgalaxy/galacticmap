-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_suggestions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shareId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "authorName" TEXT,
    "authorNote" TEXT,
    "payload" JSONB NOT NULL,
    "authorTokenHash" TEXT,
    "payloadRev" INTEGER NOT NULL DEFAULT 0,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "reviewedAt" DATETIME,
    "reviewedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "suggestions_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "public_shares" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_suggestions" ("authorName", "authorNote", "createdAt", "id", "ipHash", "payload", "payloadVersion", "reviewedAt", "reviewedBy", "shareId", "status", "userAgent") SELECT "authorName", "authorNote", "createdAt", "id", "ipHash", "payload", "payloadVersion", "reviewedAt", "reviewedBy", "shareId", "status", "userAgent" FROM "suggestions";
DROP TABLE "suggestions";
ALTER TABLE "new_suggestions" RENAME TO "suggestions";
CREATE INDEX "suggestions_shareId_status_idx" ON "suggestions"("shareId", "status");
CREATE INDEX "suggestions_shareId_createdAt_idx" ON "suggestions"("shareId", "createdAt");
CREATE INDEX "suggestions_ipHash_idx" ON "suggestions"("ipHash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
