ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "note" TEXT;

UPDATE "Appointment"
SET "email" = 'missing@example.invalid'
WHERE "email" IS NULL;

ALTER TABLE "Appointment" ALTER COLUMN "email" SET NOT NULL;
