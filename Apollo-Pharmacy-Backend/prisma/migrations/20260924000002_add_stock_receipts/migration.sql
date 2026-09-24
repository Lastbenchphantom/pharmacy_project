CREATE TABLE "StockReceipt" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "fileData" BYTEA NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    CONSTRAINT "StockReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockReceipt_fileHash_key" ON "StockReceipt"("fileHash");

CREATE TABLE "StockReceiptItem" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "medicineName" TEXT NOT NULL,
    "brandName" TEXT,
    "genericName" TEXT,
    "strength" TEXT,
    "dosageForm" TEXT,
    "packSize" TEXT,
    "quantity" INTEGER,
    "unitPrice" DOUBLE PRECISION,
    "totalPrice" DOUBLE PRECISION,
    "batchNumber" TEXT,
    "expiryDate" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "matchStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "matchedMedicineId" TEXT,
    CONSTRAINT "StockReceiptItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockReceiptItem_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "StockReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "StockTransaction" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "medicineId" TEXT NOT NULL,
    "transactionType" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "previousStock" INTEGER NOT NULL,
    "newStock" INTEGER NOT NULL,
    "batchNumber" TEXT,
    "expiryDate" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockTransaction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockTransaction_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "StockReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "StockReceipt_status_uploadedAt_idx" ON "StockReceipt"("status", "uploadedAt");
CREATE INDEX "StockReceiptItem_receiptId_idx" ON "StockReceiptItem"("receiptId");
CREATE INDEX "StockReceiptItem_matchedMedicineId_idx" ON "StockReceiptItem"("matchedMedicineId");
CREATE INDEX "StockTransaction_medicineId_createdAt_idx" ON "StockTransaction"("medicineId", "createdAt");
CREATE INDEX "StockTransaction_receiptId_idx" ON "StockTransaction"("receiptId");
