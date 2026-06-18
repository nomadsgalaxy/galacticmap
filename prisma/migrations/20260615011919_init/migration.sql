-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "isInstanceAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "board_memberships" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'VISITOR',
    "invitedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "board_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "board_memberships_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "boards" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "board_memberships_invitedBy_fkey" FOREIGN KEY ("invitedBy") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "boardId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'VISITOR',
    "token" TEXT NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "acceptedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invitations_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "boards" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "invitations_invitedBy_fkey" FOREIGN KEY ("invitedBy") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "boards" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Untitled board',
    "settings" JSONB,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "boards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "nodes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "boardId" TEXT NOT NULL,
    "parentId" TEXT,
    "layout" TEXT NOT NULL DEFAULT 'manual',
    "collapsed" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "type" TEXT NOT NULL DEFAULT 'text',
    "posX" REAL,
    "posY" REAL,
    "width" REAL,
    "height" REAL,
    "zIndex" INTEGER NOT NULL DEFAULT 0,
    "data" JSONB,
    "style" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "nodes_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "boards" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "nodes_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "nodes" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "edges" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "boardId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'connector',
    "type" TEXT NOT NULL DEFAULT 'animated',
    "animated" BOOLEAN NOT NULL DEFAULT true,
    "label" TEXT,
    "data" JSONB,
    "style" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "edges_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "boards" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "edges_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "nodes" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "edges_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "nodes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "boardId" TEXT,
    "storageDriver" TEXT NOT NULL DEFAULT 'local',
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "checksum" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "assets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "assets_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "boards" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "public_shares" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "boardId" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'SNAPSHOT',
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "suggestionsOpen" BOOLEAN NOT NULL DEFAULT true,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 30,
    "maxPerWindow" INTEGER NOT NULL DEFAULT 5,
    "windowSeconds" INTEGER NOT NULL DEFAULT 300,
    "dailyCap" INTEGER NOT NULL DEFAULT 50,
    "burstAllowance" INTEGER NOT NULL DEFAULT 2,
    "requireCaptchaAboveRate" BOOLEAN NOT NULL DEFAULT false,
    "maxSuggestions" INTEGER NOT NULL DEFAULT 500,
    "snapshot" JSONB,
    "snapshotTakenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "public_shares_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "boards" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "public_share_nodes" (
    "shareId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,

    PRIMARY KEY ("shareId", "nodeId"),
    CONSTRAINT "public_share_nodes_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "public_shares" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "public_share_nodes_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "public_share_edges" (
    "shareId" TEXT NOT NULL,
    "edgeId" TEXT NOT NULL,

    PRIMARY KEY ("shareId", "edgeId"),
    CONSTRAINT "public_share_edges_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "public_shares" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "public_share_edges_edgeId_fkey" FOREIGN KEY ("edgeId") REFERENCES "edges" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "suggestions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shareId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "authorName" TEXT,
    "authorNote" TEXT,
    "payload" JSONB NOT NULL,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "reviewedAt" DATETIME,
    "reviewedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "suggestions_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "public_shares" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "suggestion_throttles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shareId" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "windowStart" DATETIME NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "suggestion_throttles_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "public_shares" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "board_memberships_boardId_role_idx" ON "board_memberships"("boardId", "role");

-- CreateIndex
CREATE INDEX "board_memberships_userId_idx" ON "board_memberships"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "board_memberships_userId_boardId_key" ON "board_memberships"("userId", "boardId");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_key" ON "invitations"("token");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_boardId_email_key" ON "invitations"("boardId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "boards_publicId_key" ON "boards"("publicId");

-- CreateIndex
CREATE INDEX "boards_userId_idx" ON "boards"("userId");

-- CreateIndex
CREATE INDEX "nodes_boardId_idx" ON "nodes"("boardId");

-- CreateIndex
CREATE INDEX "nodes_parentId_idx" ON "nodes"("parentId");

-- CreateIndex
CREATE INDEX "edges_boardId_idx" ON "edges"("boardId");

-- CreateIndex
CREATE INDEX "edges_sourceId_idx" ON "edges"("sourceId");

-- CreateIndex
CREATE INDEX "edges_targetId_idx" ON "edges"("targetId");

-- CreateIndex
CREATE INDEX "assets_userId_idx" ON "assets"("userId");

-- CreateIndex
CREATE INDEX "assets_boardId_idx" ON "assets"("boardId");

-- CreateIndex
CREATE UNIQUE INDEX "public_shares_secret_key" ON "public_shares"("secret");

-- CreateIndex
CREATE INDEX "public_shares_boardId_idx" ON "public_shares"("boardId");

-- CreateIndex
CREATE INDEX "public_share_nodes_shareId_idx" ON "public_share_nodes"("shareId");

-- CreateIndex
CREATE INDEX "public_share_edges_shareId_idx" ON "public_share_edges"("shareId");

-- CreateIndex
CREATE INDEX "suggestions_shareId_status_idx" ON "suggestions"("shareId", "status");

-- CreateIndex
CREATE INDEX "suggestions_shareId_createdAt_idx" ON "suggestions"("shareId", "createdAt");

-- CreateIndex
CREATE INDEX "suggestions_ipHash_idx" ON "suggestions"("ipHash");

-- CreateIndex
CREATE INDEX "suggestion_throttles_shareId_ipHash_idx" ON "suggestion_throttles"("shareId", "ipHash");

-- CreateIndex
CREATE UNIQUE INDEX "suggestion_throttles_shareId_ipHash_windowStart_key" ON "suggestion_throttles"("shareId", "ipHash", "windowStart");
