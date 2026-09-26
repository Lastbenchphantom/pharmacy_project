-- Admin-controlled inventory redesign (additive columns only).
-- Does NOT truncate medicines — use scripts/reset-medicine-inventory.js for intentional reset.

-- Medicine: dosage form (type/category), description, active flag
ALTER TABLE "Medicine" ADD COLUMN IF NOT EXISTS "dosageForm" TEXT NOT NULL DEFAULT 'Other';
ALTER TABLE "Medicine" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "Medicine" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS "Medicine_dosageForm_idx" ON "Medicine"("dosageForm");
CREATE INDEX IF NOT EXISTS "Medicine_isActive_idx" ON "Medicine"("isActive");

-- StockBatch: optional cost / shelf prices per batch
ALTER TABLE "StockBatch" ADD COLUMN IF NOT EXISTS "purchasePrice" DOUBLE PRECISION;
ALTER TABLE "StockBatch" ADD COLUMN IF NOT EXISTS "sellingPrice" DOUBLE PRECISION;

-- StockReceipt: extracted header fields (OCR extract-only; stock unchanged until confirm)
ALTER TABLE "StockReceipt" ADD COLUMN IF NOT EXISTS "supplierName" TEXT;
ALTER TABLE "StockReceipt" ADD COLUMN IF NOT EXISTS "invoiceNumber" TEXT;
ALTER TABLE "StockReceipt" ADD COLUMN IF NOT EXISTS "purchaseDate" TEXT;
ALTER TABLE "StockReceipt" ADD COLUMN IF NOT EXISTS "subtotal" DOUBLE PRECISION;
ALTER TABLE "StockReceipt" ADD COLUMN IF NOT EXISTS "discount" DOUBLE PRECISION;
ALTER TABLE "StockReceipt" ADD COLUMN IF NOT EXISTS "tax" DOUBLE PRECISION;
ALTER TABLE "StockReceipt" ADD COLUMN IF NOT EXISTS "total" DOUBLE PRECISION;

-- StockReceiptItem: manufacturer from OCR
ALTER TABLE "StockReceiptItem" ADD COLUMN IF NOT EXISTS "manufacturer" TEXT;

-- StockTransaction: optional batch reference for audit
ALTER TABLE "StockTransaction" ADD COLUMN IF NOT EXISTS "batchId" TEXT;
CREATE INDEX IF NOT EXISTS "StockTransaction_batchId_idx" ON "StockTransaction"("batchId");
