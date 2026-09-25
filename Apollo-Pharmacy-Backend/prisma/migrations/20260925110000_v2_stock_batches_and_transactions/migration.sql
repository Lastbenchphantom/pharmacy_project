-- Phase 1 (additive): batches, nullable receiptId, reason, medicine relations, indexes.
-- Does not drop tables or truncate existing stock/appointment data.

-- Medicine: denormalized qty lookup index
CREATE INDEX IF NOT EXISTS "Medicine_availableQty_idx" ON "Medicine"("availableQty");

-- Clear orphan matches before adding FK (safe; match becomes unmatched)
UPDATE "StockReceiptItem"
SET "matchedMedicineId" = NULL
WHERE "matchedMedicineId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Medicine" m WHERE m."id" = "StockReceiptItem"."matchedMedicineId"
  );

-- StockReceiptItem → Medicine (optional match; clear match if medicine deleted)
ALTER TABLE "StockReceiptItem"
  DROP CONSTRAINT IF EXISTS "StockReceiptItem_matchedMedicineId_fkey";

ALTER TABLE "StockReceiptItem"
  ADD CONSTRAINT "StockReceiptItem_matchedMedicineId_fkey"
  FOREIGN KEY ("matchedMedicineId") REFERENCES "Medicine"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- StockTransaction: allow manual adjustments without a receipt
ALTER TABLE "StockTransaction" ALTER COLUMN "receiptId" DROP NOT NULL;

ALTER TABLE "StockTransaction" ADD COLUMN IF NOT EXISTS "reason" TEXT;

CREATE INDEX IF NOT EXISTS "StockTransaction_transactionType_createdAt_idx"
  ON "StockTransaction"("transactionType", "createdAt");

-- StockTransaction → Medicine (audit rows must keep a valid medicine)
-- Remove orphan audit rows that cannot satisfy the new FK (should be rare/empty)
DELETE FROM "StockTransaction" st
WHERE NOT EXISTS (SELECT 1 FROM "Medicine" m WHERE m."id" = st."medicineId");

ALTER TABLE "StockTransaction"
  DROP CONSTRAINT IF EXISTS "StockTransaction_medicineId_fkey";

ALTER TABLE "StockTransaction"
  ADD CONSTRAINT "StockTransaction_medicineId_fkey"
  FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- StockBatch: per-medicine batch qty + expiry
CREATE TABLE IF NOT EXISTS "StockBatch" (
    "id" TEXT NOT NULL,
    "medicineId" TEXT NOT NULL,
    "batchNumber" TEXT,
    "expiryDate" TIMESTAMP(3),
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockBatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StockBatch_medicineId_batchNumber_key"
  ON "StockBatch"("medicineId", "batchNumber");

CREATE INDEX IF NOT EXISTS "StockBatch_expiryDate_idx" ON "StockBatch"("expiryDate");

CREATE INDEX IF NOT EXISTS "StockBatch_medicineId_expiryDate_idx"
  ON "StockBatch"("medicineId", "expiryDate");

ALTER TABLE "StockBatch"
  DROP CONSTRAINT IF EXISTS "StockBatch_medicineId_fkey";

ALTER TABLE "StockBatch"
  ADD CONSTRAINT "StockBatch_medicineId_fkey"
  FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
