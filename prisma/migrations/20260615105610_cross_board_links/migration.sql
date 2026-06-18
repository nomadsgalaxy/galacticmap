-- CreateTable
CREATE TABLE "cross_board_links" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceBoardId" TEXT NOT NULL,
    "targetBoardId" TEXT NOT NULL,
    "sourceNodeId" TEXT,
    "targetNodeId" TEXT,
    "label" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cross_board_links_sourceBoardId_fkey" FOREIGN KEY ("sourceBoardId") REFERENCES "boards" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "cross_board_links_targetBoardId_fkey" FOREIGN KEY ("targetBoardId") REFERENCES "boards" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "cross_board_links_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "cross_board_links_sourceBoardId_idx" ON "cross_board_links"("sourceBoardId");

-- CreateIndex
CREATE INDEX "cross_board_links_targetBoardId_idx" ON "cross_board_links"("targetBoardId");
