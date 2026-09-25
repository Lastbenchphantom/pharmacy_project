require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const nodemailer = require('nodemailer');
const webpush = require('web-push');
const { Prisma, PrismaClient } = require('@prisma/client');

const app = express();
const DEFAULT_MEDICINE_API_URL = 'https://huggingface.co/datasets/Mahadih534/all-Bangladeshi-medicines/raw/main/medicine.csv';
const serializeDatabaseValue = (value) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? Number(item) : item));

// Reuse one Prisma client during local reloads and warm serverless invocations.
const prisma = globalThis.__pharmacyPrisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') {
	globalThis.__pharmacyPrisma = prisma;
}

/** Create missing stock/receipt tables when migrations were not applied on the remote DB. */
let stockSchemaPromise = null;
let medicineSearchIndexesPromise = null;

const ensureMedicineSearchIndexes = async () => {
	if (!medicineSearchIndexesPromise) {
		medicineSearchIndexesPromise = (async () => {
			await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`).catch(() => {});
			await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Medicine_availableQty_idx" ON "Medicine"("availableQty")`).catch(() => {});
			await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Medicine_strength_idx" ON "Medicine"("strength")`).catch(() => {});
			await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Medicine_manufacturer_idx" ON "Medicine"("manufacturer")`).catch(() => {});
			await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Medicine_brandName_trgm_idx" ON "Medicine" USING gin ("brandName" gin_trgm_ops)`).catch(() => {});
			await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Medicine_genericName_trgm_idx" ON "Medicine" USING gin ("genericName" gin_trgm_ops)`).catch(() => {});
			await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Medicine_manufacturer_trgm_idx" ON "Medicine" USING gin ("manufacturer" gin_trgm_ops)`).catch(() => {});
		})().catch((error) => {
			medicineSearchIndexesPromise = null;
			throw error;
		});
	}
	return medicineSearchIndexesPromise;
};

const ensureStockSchema = async () => {
	if (!stockSchemaPromise) {
		stockSchemaPromise = (async () => {
			// Fast path: tables already exist — skip heavy DDL (critical on Vercel cold starts).
			try {
				await prisma.$queryRaw`SELECT 1 FROM "StockReceipt" LIMIT 1`;
				await prisma.$queryRaw`SELECT 1 FROM "StockBatch" LIMIT 1`;
				await prisma.$queryRaw`SELECT 1 FROM "StockTransaction" LIMIT 1`;
				await ensureMedicineSearchIndexes();
				return;
			} catch {
				// Fall through and create missing tables.
			}

			await prisma.$executeRawUnsafe(`
				CREATE TABLE IF NOT EXISTS "StockReceipt" (
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
				)
			`);
			await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "StockReceipt_fileHash_key" ON "StockReceipt"("fileHash")`);
			await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "StockReceipt_status_uploadedAt_idx" ON "StockReceipt"("status", "uploadedAt")`);

			await prisma.$executeRawUnsafe(`
				CREATE TABLE IF NOT EXISTS "StockReceiptItem" (
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
					CONSTRAINT "StockReceiptItem_pkey" PRIMARY KEY ("id")
				)
			`);
			await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "StockReceiptItem_receiptId_idx" ON "StockReceiptItem"("receiptId")`);
			await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "StockReceiptItem_matchedMedicineId_idx" ON "StockReceiptItem"("matchedMedicineId")`);

			await prisma.$executeRawUnsafe(`
				CREATE TABLE IF NOT EXISTS "StockTransaction" (
					"id" TEXT NOT NULL,
					"receiptId" TEXT,
					"medicineId" TEXT NOT NULL,
					"transactionType" TEXT NOT NULL,
					"quantity" INTEGER NOT NULL,
					"previousStock" INTEGER NOT NULL,
					"newStock" INTEGER NOT NULL,
					"batchNumber" TEXT,
					"expiryDate" TEXT,
					"reason" TEXT,
					"createdBy" TEXT NOT NULL,
					"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
					CONSTRAINT "StockTransaction_pkey" PRIMARY KEY ("id")
				)
			`);
			await prisma.$executeRawUnsafe(`ALTER TABLE "StockTransaction" ALTER COLUMN "receiptId" DROP NOT NULL`).catch(() => {});
			await prisma.$executeRawUnsafe(`ALTER TABLE "StockTransaction" ADD COLUMN IF NOT EXISTS "reason" TEXT`);
			await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "StockTransaction_medicineId_createdAt_idx" ON "StockTransaction"("medicineId", "createdAt")`);
			await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "StockTransaction_receiptId_idx" ON "StockTransaction"("receiptId")`);
			await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "StockTransaction_transactionType_createdAt_idx" ON "StockTransaction"("transactionType", "createdAt")`);

			await prisma.$executeRawUnsafe(`
				CREATE TABLE IF NOT EXISTS "StockBatch" (
					"id" TEXT NOT NULL,
					"medicineId" TEXT NOT NULL,
					"batchNumber" TEXT,
					"expiryDate" TIMESTAMP(3),
					"quantity" INTEGER NOT NULL DEFAULT 0,
					"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
					"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
					CONSTRAINT "StockBatch_pkey" PRIMARY KEY ("id")
				)
			`);
			await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "StockBatch_medicineId_batchNumber_key" ON "StockBatch"("medicineId", "batchNumber")`);
			await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "StockBatch_expiryDate_idx" ON "StockBatch"("expiryDate")`);
			await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "StockBatch_medicineId_expiryDate_idx" ON "StockBatch"("medicineId", "expiryDate")`);

			await prisma.$executeRawUnsafe(`
				CREATE TABLE IF NOT EXISTS "PushSubscription" (
					"id" TEXT NOT NULL,
					"endpoint" TEXT NOT NULL,
					"p256dh" TEXT NOT NULL,
					"auth" TEXT NOT NULL,
					"userAgent" TEXT,
					"createdBy" TEXT,
					"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
					"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
					CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
				)
			`);
			await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint")`);
			await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "PushSubscription_createdAt_idx" ON "PushSubscription"("createdAt")`);

			// Best-effort FKs (ignore if already present or data conflicts)
			const fkStatements = [
				`ALTER TABLE "StockReceiptItem" DROP CONSTRAINT IF EXISTS "StockReceiptItem_receiptId_fkey"`,
				`ALTER TABLE "StockReceiptItem" ADD CONSTRAINT "StockReceiptItem_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "StockReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
				`ALTER TABLE "StockReceiptItem" DROP CONSTRAINT IF EXISTS "StockReceiptItem_matchedMedicineId_fkey"`,
				`ALTER TABLE "StockReceiptItem" ADD CONSTRAINT "StockReceiptItem_matchedMedicineId_fkey" FOREIGN KEY ("matchedMedicineId") REFERENCES "Medicine"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
				`ALTER TABLE "StockTransaction" DROP CONSTRAINT IF EXISTS "StockTransaction_receiptId_fkey"`,
				`ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "StockReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
				`ALTER TABLE "StockTransaction" DROP CONSTRAINT IF EXISTS "StockTransaction_medicineId_fkey"`,
				`ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
				`ALTER TABLE "StockBatch" DROP CONSTRAINT IF EXISTS "StockBatch_medicineId_fkey"`,
				`ALTER TABLE "StockBatch" ADD CONSTRAINT "StockBatch_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
			];
			for (const statement of fkStatements) {
				await prisma.$executeRawUnsafe(statement).catch(() => {});
			}
			await ensureMedicineSearchIndexes();
		})().catch((error) => {
			stockSchemaPromise = null;
			throw error;
		});
	}
	return stockSchemaPromise;
};

const requireStockSchema = async (_req, _res, next) => {
	try {
		await ensureStockSchema();
		next();
	} catch (error) {
		next(error);
	}
};

const allowedOrigins = (() => {
	const raw = process.env.FRONTEND_URL || 'http://localhost:5173';
	const list = String(raw).split(',').map((origin) => origin.trim()).filter(Boolean);
	const normalized = new Set();
	for (const origin of list) {
		if (/^https?:\/\//i.test(origin)) {
			normalized.add(origin.replace(/\/$/, ''));
		} else {
			normalized.add(`https://${origin.replace(/\/$/, '')}`);
			normalized.add(`http://${origin.replace(/\/$/, '')}`);
		}
	}
	// Always allow local Vite during development.
	normalized.add('http://localhost:5173');
	normalized.add('http://127.0.0.1:5173');
	return [...normalized];
})();

app.use(cors({
	origin(origin, callback) {
		if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
		return callback(null, false);
	},
	credentials: true,
}));
app.use(express.json({ limit: '16kb' }));

const MAX_RECEIPT_SIZE = 10 * 1024 * 1024;
const RECEIPT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const receiptUpload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: MAX_RECEIPT_SIZE, files: 1 },
	fileFilter: (_req, file, callback) => callback(null, RECEIPT_MIME_TYPES.has(file.mimetype)),
});

const receiveReceipt = (req, res, next) => receiptUpload.single('receipt')(req, res, (error) => {
	if (error) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Receipt must be 10 MB or smaller' : 'Upload a JPG, PNG, or PDF receipt' });
	next();
});

const getAdminPassword = () => process.env.ADMIN_LOGIN_PASSWORD || process.env.ADMIN_API_KEY;
// Prefer ADMIN_JWT_SECRET for token HMAC; fall back to login password/API key.
const getAdminSigningSecret = () => process.env.ADMIN_JWT_SECRET || getAdminPassword();
const getAdminSecret = getAdminPassword;

const LOW_STOCK_THRESHOLD = Number.parseInt(process.env.LOW_STOCK_THRESHOLD, 10);
const EXPIRY_WARNING_DAYS = Number.parseInt(process.env.EXPIRY_WARNING_DAYS, 10);
const resolvedLowStockThreshold = Number.isInteger(LOW_STOCK_THRESHOLD) && LOW_STOCK_THRESHOLD >= 0 ? LOW_STOCK_THRESHOLD : 10;
const resolvedExpiryWarningDays = Number.isInteger(EXPIRY_WARNING_DAYS) && EXPIRY_WARNING_DAYS > 0 ? EXPIRY_WARNING_DAYS : 90;

const rateLimitBuckets = globalThis.__pharmacyRateLimits || new Map();
if (process.env.NODE_ENV !== 'production') {
	globalThis.__pharmacyRateLimits = rateLimitBuckets;
}

const rateLimit = (bucketName, maxRequests, windowMs) => (req, res, next) => {
	const forwarded = req.get('x-forwarded-for');
	const ip = (typeof forwarded === 'string' && forwarded.split(',')[0].trim()) || req.ip || req.socket?.remoteAddress || 'unknown';
	const key = `${bucketName}:${ip}`;
	const now = Date.now();
	let bucket = rateLimitBuckets.get(key);
	if (!bucket || bucket.resetAt <= now) {
		bucket = { count: 0, resetAt: now + windowMs };
		rateLimitBuckets.set(key, bucket);
	}
	bucket.count += 1;
	if (bucket.count > maxRequests) {
		return res.status(429).json({ error: 'Too many requests. Please wait and try again.' });
	}
	next();
};

const parseLimitOffset = (query, defaultLimit = 50, maxLimit = 100) => {
	const requestedLimit = Number.parseInt(query.limit, 10);
	const requestedOffset = Number.parseInt(query.offset, 10);
	const requestedPage = Number.parseInt(query.page, 10);
	const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), maxLimit) : defaultLimit;
	if (Number.isInteger(requestedOffset) && requestedOffset >= 0) {
		return { limit, offset: requestedOffset, page: Math.floor(requestedOffset / limit) + 1 };
	}
	const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
	return { limit, offset: (page - 1) * limit, page };
};

const MEDICINE_LIST_SELECT = Prisma.sql`
	"id", "brandName", "genericName", "manufacturer", "strength", "availableQty",
	"piece_price", "box_price", "createdAt", "updatedAt"
`;

const mapMedicineRow = (medicine) => ({
	id: medicine.id,
	brandName: medicine.brandName,
	genericName: medicine.genericName,
	manufacturer: medicine.manufacturer,
	strength: medicine.strength,
	availableQty: Number(medicine.availableQty || 0),
	singlePiecePrice: Number(medicine.piece_price ?? medicine.singlePiecePrice ?? 0),
	fullBoxPrice: Number(medicine.box_price ?? medicine.fullBoxPrice ?? 0),
	createdAt: medicine.createdAt,
	updatedAt: medicine.updatedAt,
});

const escapeIlikePattern = (value) => String(value || '').replace(/[\\%_]/g, '\\$&');

const createAdminToken = () => {
	const payload = Buffer.from(JSON.stringify({
		sub: 'admin',
		exp: Date.now() + (8 * 60 * 60 * 1000),
	})).toString('base64url');
	const signature = crypto.createHmac('sha256', getAdminSigningSecret()).update(payload).digest('base64url');
	return `${payload}.${signature}`;
};

const requireAdmin = (req, res, next) => {
	const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
	const [payload, signature] = token?.split('.') || [];
	const secret = getAdminSigningSecret();

	if (!secret || !payload || !signature) {
		return res.status(401).json({ error: 'Admin login required' });
	}

	const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
	const validSignature = signature.length === expectedSignature.length
		&& crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));

	try {
		const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		if (!validSignature || claims.sub !== 'admin' || claims.exp < Date.now()) {
			return res.status(401).json({ error: 'Admin session expired' });
		}
		req.adminId = claims.sub;
	} catch {
		return res.status(401).json({ error: 'Invalid admin session' });
	}

	next();
};

const mailFrom = process.env.MAIL_FROM || process.env.SMTP_USER;
const mailTransport = process.env.SMTP_HOST && mailFrom
	? nodemailer.createTransport({
		host: process.env.SMTP_HOST,
		port: Number(process.env.SMTP_PORT || 587),
		secure: process.env.SMTP_SECURE === 'true',
		auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
	})
	: null;

const sendAdminAlertEmail = async (subject, text) => {
	if (!mailTransport) return { sent: false, reason: 'smtp-not-configured' };
	const to = process.env.ADMIN_ALERT_EMAIL || mailFrom;
	if (!to) return { sent: false, reason: 'smtp-not-configured' };
	await mailTransport.sendMail({ from: mailFrom, to, subject, text });
	return { sent: true, reason: 'sent', to };
};

const getVapidConfig = () => {
	const publicKey = process.env.VAPID_PUBLIC_KEY;
	const privateKey = process.env.VAPID_PRIVATE_KEY;
	const subject = process.env.VAPID_SUBJECT || process.env.MAIL_FROM || 'mailto:admin@apollo-pharmacy.local';
	if (!publicKey || !privateKey) return null;
	return { publicKey, privateKey, subject };
};

const configureWebPush = () => {
	const vapid = getVapidConfig();
	if (!vapid) return false;
	webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
	return true;
};

const listExpiringBatches = async (days) => {
	const today = new Date();
	const warningDate = new Date(today);
	warningDate.setUTCDate(warningDate.getUTCDate() + days);
	const rows = await prisma.$queryRaw(Prisma.sql`
		SELECT b.*, m."brandName", m."strength"
		FROM "StockBatch" b
		JOIN "Medicine" m ON m."id" = b."medicineId"
		WHERE b."quantity" > 0 AND b."expiryDate" IS NOT NULL AND b."expiryDate" <= ${warningDate}
		ORDER BY b."expiryDate" ASC
		LIMIT 500
	`);
	return { rows, today, days };
};

const sendExpiryPushNotifications = async ({ days, title, body }) => {
	if (!configureWebPush()) return { sent: false, reason: 'vapid-not-configured', delivered: 0, removed: 0 };
	const subscriptions = await prisma.$queryRaw(Prisma.sql`
		SELECT "id", "endpoint", "p256dh", "auth" FROM "PushSubscription"
	`);
	if (subscriptions.length === 0) return { sent: true, reason: 'no-subscribers', delivered: 0, removed: 0 };

	const payload = JSON.stringify({
		title: title || 'Apollo Pharmacy expiry alert',
		body: body || 'Check expiring or expired medicine batches.',
		url: '/admin',
		days,
	});

	let delivered = 0;
	let removed = 0;
	for (const subscription of subscriptions) {
		try {
			await webpush.sendNotification({
				endpoint: subscription.endpoint,
				keys: { p256dh: subscription.p256dh, auth: subscription.auth },
			}, payload);
			delivered += 1;
		} catch (pushError) {
			const statusCode = pushError.statusCode || pushError.status;
			if (statusCode === 404 || statusCode === 410) {
				await prisma.$executeRaw(Prisma.sql`DELETE FROM "PushSubscription" WHERE "id" = ${subscription.id}`);
				removed += 1;
			} else {
				console.error('Push notification failed:', pushError.message || pushError);
			}
		}
	}
	return { sent: delivered > 0, reason: delivered > 0 ? 'sent' : 'delivery-failed', delivered, removed, subscribers: subscriptions.length };
};

const requireCronOrAdmin = (req, res, next) => {
	const cronSecret = process.env.CRON_SECRET;
	const provided = req.get('x-cron-secret') || req.get('authorization')?.replace(/^Bearer\s+/i, '');
	if (cronSecret && provided && provided === cronSecret) {
		req.adminId = 'cron';
		return next();
	}
	return requireAdmin(req, res, next);
};

const monthNameToNumber = {
	jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
	may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
	sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const endOfMonthUtc = (year, month) => new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

/** Parse OCR / admin expiry strings into a Date. Never throws; returns null if unusable. */
const parseExpiryDate = (value) => {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
	if (typeof value === 'number' && Number.isFinite(value)) {
		const fromNumber = new Date(value);
		return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
	}
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed || /^n\/?a$/i.test(trimmed) || /^unknown$/i.test(trimmed)) return null;

	const isoDay = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
	if (isoDay) {
		const date = new Date(Date.UTC(Number(isoDay[1]), Number(isoDay[2]) - 1, Number(isoDay[3]), 12, 0, 0));
		return Number.isNaN(date.getTime()) ? null : date;
	}

	const isoMonth = trimmed.match(/^(\d{4})-(\d{1,2})$/);
	if (isoMonth) return endOfMonthUtc(Number(isoMonth[1]), Number(isoMonth[2]));

	const slash = trimmed.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
	if (slash) {
		let day = Number(slash[1]);
		let month = Number(slash[2]);
		let year = Number(slash[3]);
		if (year < 100) year += 2000;
		// Pharmacy OCR in BD commonly prints DD/MM/YYYY; if first part > 12 treat as day-first.
		if (day > 12 && month <= 12) {
			// day/month already correct
		} else if (month > 12 && day <= 12) {
			[day, month] = [month, day];
		}
		// else keep DD/MM preference
		const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
		return Number.isNaN(date.getTime()) ? null : date;
	}

	const monthYearNum = trimmed.match(/^(\d{1,2})[\/\-. ](\d{4})$/);
	if (monthYearNum) return endOfMonthUtc(Number(monthYearNum[2]), Number(monthYearNum[1]));

	const namedMonth = trimmed.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
	if (namedMonth) {
		const month = monthNameToNumber[namedMonth[1].toLowerCase()];
		if (month) return endOfMonthUtc(Number(namedMonth[2]), month);
	}

	const namedDay = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/);
	if (namedDay) {
		const month = monthNameToNumber[namedDay[2].toLowerCase()];
		if (month) {
			const date = new Date(Date.UTC(Number(namedDay[3]), month - 1, Number(namedDay[1]), 12, 0, 0));
			return Number.isNaN(date.getTime()) ? null : date;
		}
	}

	const fallback = new Date(trimmed);
	return Number.isNaN(fallback.getTime()) ? null : fallback;
};

const normalizeBatchNumber = (value) => {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
};

const expiryDateToStorageString = (date) => date.toISOString().slice(0, 10);

/**
 * Batch identity policy:
 * - Non-empty batchNumber → unique per (medicineId, batchNumber); expiry updated on add.
 * - Empty/null batchNumber → one row per medicineId + calendar expiry day (batchNumber stays NULL).
 *   Postgres unique(medicineId, NULL) allows multiple NULL batch rows, so we match by expiry date.
 */
const findStockBatch = async (tx, medicineId, batchNumber, expiryDate) => {
	if (batchNumber) {
		const rows = await tx.$queryRaw(Prisma.sql`
			SELECT * FROM "StockBatch" WHERE "medicineId" = ${medicineId} AND "batchNumber" = ${batchNumber} LIMIT 1
		`);
		return rows[0] || null;
	}
	const rows = await tx.$queryRaw(Prisma.sql`
		SELECT * FROM "StockBatch"
		WHERE "medicineId" = ${medicineId} AND "batchNumber" IS NULL
		AND (("expiryDate" IS NULL AND ${expiryDate}::timestamp IS NULL)
			OR ("expiryDate" IS NOT NULL AND ${expiryDate}::timestamp IS NOT NULL AND ("expiryDate")::date = (${expiryDate}::timestamp)::date))
		LIMIT 1
	`);
	return rows[0] || null;
};

const recomputeMedicineQty = async (tx, medicineId) => {
	const rows = await tx.$queryRaw(Prisma.sql`
		SELECT COALESCE(SUM("quantity"), 0)::int AS "total" FROM "StockBatch" WHERE "medicineId" = ${medicineId}
	`);
	const total = Number(rows[0]?.total || 0);
	await tx.$executeRaw(Prisma.sql`
		UPDATE "Medicine" SET "availableQty" = ${total}, "updatedAt" = NOW() WHERE "id" = ${medicineId}
	`);
	return total;
};

/** If Medicine.availableQty exists but no StockBatch rows yet, seed one row so recompute cannot wipe legacy stock. */
const seedLegacyStockBatchIfNeeded = async (tx, medicineId) => {
	const medicines = await tx.$queryRaw(Prisma.sql`SELECT "availableQty" FROM "Medicine" WHERE "id" = ${medicineId}`);
	if (medicines.length === 0) return;
	const availableQty = Number(medicines[0].availableQty || 0);
	const sumRows = await tx.$queryRaw(Prisma.sql`
		SELECT COALESCE(SUM("quantity"), 0)::int AS "total" FROM "StockBatch" WHERE "medicineId" = ${medicineId}
	`);
	const batchTotal = Number(sumRows[0]?.total || 0);
	if (availableQty > 0 && batchTotal === 0) {
		await tx.$executeRaw(Prisma.sql`
			INSERT INTO "StockBatch" ("id", "medicineId", "batchNumber", "expiryDate", "quantity", "createdAt", "updatedAt")
			VALUES (${crypto.randomUUID()}, ${medicineId}, NULL, NULL, ${availableQty}, NOW(), NOW())
		`);
	}
};

const addToStockBatch = async (tx, { medicineId, batchNumber, expiryDate, quantityDelta }) => {
	const existing = await findStockBatch(tx, medicineId, batchNumber, expiryDate);
	if (existing) {
		const nextQty = Number(existing.quantity) + quantityDelta;
		if (nextQty < 0) throw Object.assign(new Error('Batch quantity cannot go below zero'), { statusCode: 400 });
		await tx.$executeRaw(Prisma.sql`
			UPDATE "StockBatch"
			SET "quantity" = ${nextQty},
				"expiryDate" = ${expiryDate || existing.expiryDate},
				"updatedAt" = NOW()
			WHERE "id" = ${existing.id}
		`);
		return { ...existing, quantity: nextQty, expiryDate: expiryDate || existing.expiryDate };
	}
	if (quantityDelta < 0) throw Object.assign(new Error('No matching batch to reduce'), { statusCode: 400 });
	const id = crypto.randomUUID();
	await tx.$executeRaw(Prisma.sql`
		INSERT INTO "StockBatch" ("id", "medicineId", "batchNumber", "expiryDate", "quantity", "createdAt", "updatedAt")
		VALUES (${id}, ${medicineId}, ${batchNumber}, ${expiryDate}, ${quantityDelta}, NOW(), NOW())
	`);
	return { id, medicineId, batchNumber, expiryDate, quantity: quantityDelta };
};

const reduceStockAcrossBatches = async (tx, medicineId, amount) => {
	let remaining = amount;
	const batches = await tx.$queryRaw(Prisma.sql`
		SELECT * FROM "StockBatch"
		WHERE "medicineId" = ${medicineId} AND "quantity" > 0
		ORDER BY CASE WHEN "expiryDate" IS NULL THEN 1 ELSE 0 END, "expiryDate" ASC, "createdAt" ASC
		FOR UPDATE
	`);
	for (const batch of batches) {
		if (remaining <= 0) break;
		const take = Math.min(Number(batch.quantity), remaining);
		await tx.$executeRaw(Prisma.sql`
			UPDATE "StockBatch" SET "quantity" = ${Number(batch.quantity) - take}, "updatedAt" = NOW() WHERE "id" = ${batch.id}
		`);
		remaining -= take;
	}
	if (remaining > 0) throw Object.assign(new Error('Not enough batch quantity to reduce stock'), { statusCode: 400 });
};

const writeStockTransaction = async (tx, {
	receiptId = null,
	medicineId,
	transactionType,
	quantity,
	previousStock,
	newStock,
	batchNumber = null,
	expiryDate = null,
	reason = null,
	createdBy,
}) => {
	const expiryStored = expiryDate instanceof Date ? expiryDateToStorageString(expiryDate) : (expiryDate || null);
	await tx.$executeRaw(Prisma.sql`
		INSERT INTO "StockTransaction" (
			"id", "receiptId", "medicineId", "transactionType", "quantity", "previousStock", "newStock",
			"batchNumber", "expiryDate", "reason", "createdBy", "createdAt"
		) VALUES (
			${crypto.randomUUID()}, ${receiptId}, ${medicineId}, ${transactionType}, ${quantity},
			${previousStock}, ${newStock}, ${batchNumber}, ${expiryStored}, ${reason}, ${createdBy}, NOW()
		)
	`);
};

const parseCsvLine = (line) => {
	const values = [];
	const pattern = /("(?:[^"]|"")*"|[^,]*)(?:,|$)/g;
	let match;
	while ((match = pattern.exec(line)) && match[0] !== '') {
		const value = match[1].trim();
		values.push(value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/""/g, '"') : value);
		if (pattern.lastIndex >= line.length) break;
	}
	return values;
};

const normalizeMedicineText = (value) => String(value || '').toLowerCase()
	.replace(/milligrams?/g, 'mg')
	.replace(/tablets?/g, 'tablet')
	.replace(/capsules?/g, 'capsule')
	.replace(/[^a-z0-9]+/g, ' ')
	.trim();

const levenshtein = (left, right) => {
	const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
	for (let row = 1; row <= left.length; row += 1) {
		const current = [row];
		for (let column = 1; column <= right.length; column += 1) {
			current[column] = Math.min(
				current[column - 1] + 1,
				previous[column] + 1,
				previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
			);
		}
		previous.splice(0, previous.length, ...current);
	}
	return previous[right.length];
};

const textSimilarity = (left, right) => {
	const normalizedLeft = normalizeMedicineText(left);
	const normalizedRight = normalizeMedicineText(right);
	if (!normalizedLeft || !normalizedRight) return 0;
	if (normalizedLeft === normalizedRight) return 1;
	if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return 0.9;
	return 1 - (levenshtein(normalizedLeft, normalizedRight) / Math.max(normalizedLeft.length, normalizedRight.length));
};

const matchReceiptMedicine = (item, medicines) => {
	const receiptText = [item.medicine_name, item.brand_name, item.generic_name, item.strength, item.dosage_form].filter(Boolean).join(' ');
	const ranked = medicines.map((medicine) => {
		const nameScore = Math.max(textSimilarity(item.medicine_name, medicine.brandName), textSimilarity(item.brand_name, medicine.brandName));
		const genericScore = textSimilarity(item.generic_name, medicine.genericName);
		const strengthScore = item.strength ? textSimilarity(item.strength, medicine.strength) : 0.5;
		const fullScore = textSimilarity(receiptText, [medicine.brandName, medicine.genericName, medicine.strength].join(' '));
		return { medicine, score: (nameScore * 0.5) + (genericScore * 0.2) + (strengthScore * 0.15) + (fullScore * 0.15) };
	}).sort((left, right) => right.score - left.score);
	const best = ranked[0];
	const second = ranked[1];
	if (!best || best.score < 0.62 || (second && best.score - second.score < 0.06 && best.score < 0.86)) {
		return { matchStatus: 'NEEDS_MANUAL', matchedMedicineId: null, matchScore: best?.score || 0 };
	}
	return { matchStatus: 'MATCHED', matchedMedicineId: best.medicine.id, matchScore: best.score };
};

/** Pull a small candidate set from Postgres instead of scoring against all ~21k medicines. */
const findMedicineMatchCandidates = async (item, limit = 40) => {
	const rawTokens = [item.brand_name, item.medicine_name, item.generic_name]
		.filter(Boolean)
		.flatMap((value) => normalizeMedicineText(value).split(' '))
		.filter((token) => token.length >= 3 && !/^\d+$/.test(token));
	const uniqueTokens = [...new Set(rawTokens)].slice(0, 4);
	if (uniqueTokens.length === 0) {
		const fallback = normalizeMedicineText(item.medicine_name || item.brand_name || '').slice(0, 24);
		if (fallback.length < 2) return [];
		uniqueTokens.push(fallback);
	}

	const conditions = uniqueTokens.map((token) => {
		const pattern = `%${escapeIlikePattern(token)}%`;
		return Prisma.sql`(
			"brandName" ILIKE ${pattern} ESCAPE '\\'
			OR "genericName" ILIKE ${pattern} ESCAPE '\\'
			OR "manufacturer" ILIKE ${pattern} ESCAPE '\\'
			OR "strength" ILIKE ${pattern} ESCAPE '\\'
		)`;
	});

	const strength = typeof item.strength === 'string' ? item.strength.trim() : '';
	if (strength) {
		const strengthPattern = `%${escapeIlikePattern(strength)}%`;
		conditions.push(Prisma.sql`"strength" ILIKE ${strengthPattern} ESCAPE '\\'`);
	}

	return prisma.$queryRaw(Prisma.sql`
		SELECT "id", "brandName", "genericName", "strength", "availableQty"
		FROM "Medicine"
		WHERE ${Prisma.join(conditions, ' OR ')}
		ORDER BY "brandName" ASC
		LIMIT ${limit}
	`);
};

const matchReceiptItemAgainstDatabase = async (item) => {
	const candidates = await findMedicineMatchCandidates(item, 40);
	if (candidates.length === 0) {
		return { matchStatus: 'NEEDS_MANUAL', matchedMedicineId: null, matchScore: 0 };
	}
	return matchReceiptMedicine(item, candidates);
};

const extractReceiptItems = async (file) => {
	// Lazy-load OCR so public medicine routes do not pull tesseract.js on cold start.
	const { extractReceiptItemsWithTesseract } = require('../receiptOcr');
	return extractReceiptItemsWithTesseract(file);
};

/** In-flight process locks for this serverless isolate (prevents duplicate simultaneous OCR). */
const receiptProcessingLocks = globalThis.__pharmacyReceiptProcessingLocks || new Set();
if (process.env.NODE_ENV !== 'production') {
	globalThis.__pharmacyReceiptProcessingLocks = receiptProcessingLocks;
}

const MAX_RECEIPT_PROCESS_RETRIES = Number.parseInt(process.env.RECEIPT_MAX_PROCESS_RETRIES, 10) || 5;

const sanitizeReceiptErrorMessage = (message) => {
	const text = String(message || 'Receipt processing failed. Please try again.').replace(/\s+/g, ' ').trim();
	if (/timeout|RECEIPT_OCR_TIMEOUT|504/i.test(text)) return 'Receipt processing timed out. Please retry.';
	if (/scanned\/image-only pdf|little readable text/i.test(text)) {
		return 'Scanned/image-only PDF is not currently supported. Please upload the receipt as JPG or PNG.';
	}
	if (/could not read|empty|corrupt|invalid pdf|unreadable|clearer/i.test(text)) {
		return 'Could not read this receipt. Please upload a clearer JPG or PNG.';
	}
	if (/OCR|tesseract|AI processing|DOMMatrix|pdf-parse|pdfjs/i.test(text)) {
		return 'AI processing failed. Please retry.';
	}
	return text.slice(0, 280);
};

const logReceiptProcessStep = (step, startedAt, extra = {}) => {
	console.info('[receipt-process]', { step, elapsedMs: Date.now() - startedAt, ...extra });
};

const markReceiptFailed = async (receiptId, message) => {
	const adminMessage = sanitizeReceiptErrorMessage(message);
	await prisma.$executeRaw(Prisma.sql`
		UPDATE "StockReceipt"
		SET "status" = 'FAILED', "errorMessage" = ${adminMessage}
		WHERE "id" = ${receiptId} AND "status" <> 'CONFIRMED'
	`);
	return adminMessage;
};

const getReceiptDetails = async (receiptId) => {
	const receipts = await prisma.$queryRaw(Prisma.sql`SELECT "id", "fileName", "mimeType", "status", "uploadedBy", "uploadedAt", "processedAt", "confirmedBy", "confirmedAt", "errorMessage" FROM "StockReceipt" WHERE "id" = ${receiptId}`);
	if (receipts.length === 0) return null;
	const items = await prisma.$queryRaw(Prisma.sql`
		SELECT i.*, m."brandName" AS "matchedBrandName", m."genericName" AS "matchedGenericName", m."strength" AS "matchedStrength", m."availableQty" AS "currentStock"
		FROM "StockReceiptItem" i LEFT JOIN "Medicine" m ON m."id" = i."matchedMedicineId"
		WHERE i."receiptId" = ${receiptId} ORDER BY i."id"
	`);
	return serializeDatabaseValue({ ...receipts[0], items });
};

app.get('/api/health', (_req, res) => {
	res.json({ ok: true, service: 'pharmacy-api' });
});

app.post('/api/admin/login', rateLimit('admin-login', 5, 60_000), (req, res) => {
	const password = typeof req.body?.password === 'string' ? req.body.password : '';
	const secret = getAdminPassword();

	if (!secret || password.length === 0 || password !== secret) {
		return res.status(401).json({ error: 'Invalid admin credentials' });
	}

	res.json({ token: createAdminToken(), expiresIn: 8 * 60 * 60 });
});

app.get('/api/medicines', async (req, res, next) => {
	try {
		const { limit, offset, page } = parseLimitOffset(req.query, 25, 100);
		const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
		const searchPattern = search ? `%${escapeIlikePattern(search)}%` : null;
		const wantFeatured = req.query.random === 'true' && !searchPattern;

		let medicines;
		let total;

		if (wantFeatured) {
			// Avoid ORDER BY RANDOM() full-table sort on 21k rows.
			medicines = await prisma.$queryRaw(Prisma.sql`
				SELECT ${MEDICINE_LIST_SELECT} FROM "Medicine"
				WHERE "availableQty" > 0
				ORDER BY "updatedAt" DESC
				LIMIT ${limit}
			`);
			if (medicines.length < limit) {
				const remaining = limit - medicines.length;
				const extras = await prisma.$queryRaw(Prisma.sql`
					SELECT ${MEDICINE_LIST_SELECT} FROM "Medicine"
					ORDER BY "brandName" ASC
					LIMIT ${remaining}
				`);
				const seen = new Set(medicines.map((row) => row.id));
				for (const row of extras) {
					if (!seen.has(row.id)) medicines.push(row);
				}
			}
			total = medicines.length;
		} else if (searchPattern) {
			const whereSql = Prisma.sql`
				"brandName" ILIKE ${searchPattern} ESCAPE '\\'
				OR "genericName" ILIKE ${searchPattern} ESCAPE '\\'
				OR "manufacturer" ILIKE ${searchPattern} ESCAPE '\\'
				OR "strength" ILIKE ${searchPattern} ESCAPE '\\'
			`;
			const [countRow] = await prisma.$queryRaw(Prisma.sql`
				SELECT COUNT(*)::int AS "count" FROM "Medicine" WHERE ${whereSql}
			`);
			total = Number(countRow?.count || 0);
			medicines = await prisma.$queryRaw(Prisma.sql`
				SELECT ${MEDICINE_LIST_SELECT} FROM "Medicine"
				WHERE ${whereSql}
				ORDER BY
					CASE
						WHEN "brandName" ILIKE ${`${escapeIlikePattern(search)}%`} ESCAPE '\\' THEN 0
						WHEN "brandName" ILIKE ${searchPattern} ESCAPE '\\' THEN 1
						WHEN "genericName" ILIKE ${searchPattern} ESCAPE '\\' THEN 2
						ELSE 3
					END,
					"brandName" ASC, "genericName" ASC
				LIMIT ${limit} OFFSET ${offset}
			`);
		} else {
			const [countRow] = await prisma.$queryRaw(Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "Medicine"`);
			total = Number(countRow?.count || 0);
			medicines = await prisma.$queryRaw(Prisma.sql`
				SELECT ${MEDICINE_LIST_SELECT} FROM "Medicine"
				ORDER BY "brandName" ASC, "genericName" ASC
				LIMIT ${limit} OFFSET ${offset}
			`);
		}

		const items = medicines.map(mapMedicineRow);
		const totalPages = Math.max(1, Math.ceil(total / limit));
		res.json(serializeDatabaseValue({
			items,
			pagination: {
				page,
				limit,
				offset,
				total,
				totalPages,
			},
		}));
	} catch (error) {
		next(error);
	}
});

app.post('/api/stock/receipt/upload', requireAdmin, requireStockSchema, receiveReceipt, async (req, res, next) => {
	if (!req.file) return res.status(400).json({ error: 'A JPG, PNG, or PDF receipt is required' });
	const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
	try {
		const existing = await prisma.$queryRaw(Prisma.sql`SELECT "id", "status" FROM "StockReceipt" WHERE "fileHash" = ${fileHash}`);
		if (existing.length > 0) return res.status(409).json({ error: 'This receipt has already been uploaded', receiptId: existing[0].id, status: existing[0].status });
		const receiptId = crypto.randomUUID();
		await prisma.$executeRaw(Prisma.sql`
			INSERT INTO "StockReceipt" ("id", "fileName", "mimeType", "fileHash", "fileData", "status", "uploadedBy", "uploadedAt")
			VALUES (${receiptId}, ${req.file.originalname}, ${req.file.mimetype}, ${fileHash}, ${req.file.buffer}, 'PROCESSING', ${req.adminId || 'admin'}, NOW())
		`);
		res.status(201).json({ receiptId, status: 'PROCESSING', fileName: req.file.originalname });
	} catch (error) {
		next(error);
	}
});

const runReceiptProcessing = async (receiptId, { allowReadyPassthrough = true } = {}) => {
	if (receiptProcessingLocks.has(receiptId)) {
		const error = new Error('This receipt is already being processed. Please wait.');
		error.statusCode = 409;
		error.receiptStatus = 'PROCESSING';
		throw error;
	}

	const startedAt = Date.now();
	receiptProcessingLocks.add(receiptId);
	logReceiptProcessStep('request_received', startedAt, { receiptId });

	try {
		const retrieveStartedAt = Date.now();
		const receipts = await prisma.$queryRaw(Prisma.sql`
			SELECT "id", "fileName", "mimeType", "fileData", "status", "errorMessage"
			FROM "StockReceipt" WHERE "id" = ${receiptId}
		`);
		logReceiptProcessStep('receipt_retrieval', retrieveStartedAt, { receiptId, found: receipts.length > 0 });
		if (receipts.length === 0) {
			const error = new Error('Receipt not found');
			error.statusCode = 404;
			throw error;
		}

		const receipt = receipts[0];
		if (receipt.status === 'CONFIRMED') {
			const error = new Error('This receipt has already been confirmed');
			error.statusCode = 409;
			error.receiptStatus = 'CONFIRMED';
			throw error;
		}
		if (receipt.status === 'READY_FOR_REVIEW') {
			if (allowReadyPassthrough) {
				logReceiptProcessStep('already_ready', startedAt, { receiptId });
				return getReceiptDetails(receiptId);
			}
			const error = new Error('Receipt is already ready for review');
			error.statusCode = 409;
			error.receiptStatus = 'READY_FOR_REVIEW';
			throw error;
		}
		if (!['PROCESSING', 'FAILED'].includes(receipt.status)) {
			const error = new Error(`Receipt cannot be processed from status ${receipt.status}`);
			error.statusCode = 409;
			error.receiptStatus = receipt.status;
			throw error;
		}

		await prisma.$executeRaw(Prisma.sql`
			UPDATE "StockReceipt"
			SET "status" = 'PROCESSING', "errorMessage" = NULL
			WHERE "id" = ${receiptId} AND "status" IN ('PROCESSING', 'FAILED')
		`);
		logReceiptProcessStep('status_claimed', startedAt, { receiptId, previousStatus: receipt.status });

		const fileRetrieveStartedAt = Date.now();
		const fileData = receipt.fileData;
		const fileBuffer = Buffer.isBuffer(fileData) ? fileData : Buffer.from(fileData || []);
		logReceiptProcessStep('file_retrieval', fileRetrieveStartedAt, {
			receiptId,
			mimeType: receipt.mimeType,
			byteLength: fileBuffer.length,
		});
		if (!fileBuffer.length) {
			const adminMessage = await markReceiptFailed(receiptId, 'Could not read this receipt. Please upload a clearer JPG or PNG.');
			const error = new Error(adminMessage);
			error.statusCode = 422;
			error.receiptStatus = 'FAILED';
			throw error;
		}

		const typeDetectStartedAt = Date.now();
		const isPdf = receipt.mimeType === 'application/pdf';
		const isImage = receipt.mimeType === 'image/jpeg' || receipt.mimeType === 'image/png';
		logReceiptProcessStep('file_type_detection', typeDetectStartedAt, {
			receiptId,
			mimeType: receipt.mimeType,
			path: isPdf ? 'pdf' : isImage ? 'image_ocr' : 'unknown',
		});
		if (!isPdf && !isImage) {
			const adminMessage = await markReceiptFailed(receiptId, 'Could not read this receipt. Please upload a clearer JPG or PNG.');
			const error = new Error(adminMessage);
			error.statusCode = 422;
			error.receiptStatus = 'FAILED';
			throw error;
		}

		const ocrStartedAt = Date.now();
		const extractedItems = await extractReceiptItems({
			buffer: fileBuffer,
			mimetype: receipt.mimeType,
			originalname: receipt.fileName,
		});
		logReceiptProcessStep(isPdf ? 'pdf_parsing' : 'image_ocr_ai', ocrStartedAt, {
			receiptId,
			itemCount: extractedItems.length,
		});

		const matchStartedAt = Date.now();
		const matchedItems = [];
		for (const extractedItem of extractedItems) {
			const match = await matchReceiptItemAgainstDatabase(extractedItem);
			matchedItems.push({ extractedItem, match });
		}
		logReceiptProcessStep('medicine_candidate_matching', matchStartedAt, {
			receiptId,
			itemCount: matchedItems.length,
		});

		const dbUpdateStartedAt = Date.now();
		await prisma.$transaction(async (tx) => {
			await tx.$executeRaw(Prisma.sql`DELETE FROM "StockReceiptItem" WHERE "receiptId" = ${receiptId}`);
			for (const { extractedItem, match } of matchedItems) {
				const quantity = Number.isInteger(extractedItem.quantity) && extractedItem.quantity >= 0 ? extractedItem.quantity : null;
				const confidence = Number.isFinite(Number(extractedItem.confidence)) ? Math.min(Math.max(Number(extractedItem.confidence), 0), 1) : 0;
				await tx.$executeRaw(Prisma.sql`
					INSERT INTO "StockReceiptItem" ("id", "receiptId", "medicineName", "brandName", "genericName", "strength", "dosageForm", "packSize", "quantity", "unitPrice", "totalPrice", "batchNumber", "expiryDate", "confidence", "matchStatus", "matchedMedicineId")
					VALUES (${crypto.randomUUID()}, ${receiptId}, ${String(extractedItem.medicine_name || 'Unidentified item').trim()}, ${extractedItem.brand_name || null}, ${extractedItem.generic_name || null}, ${extractedItem.strength || null}, ${extractedItem.dosage_form || null}, ${extractedItem.pack_size || null}, ${quantity}, ${Number.isFinite(Number(extractedItem.unit_price)) ? Number(extractedItem.unit_price) : null}, ${Number.isFinite(Number(extractedItem.total_price)) ? Number(extractedItem.total_price) : null}, ${extractedItem.batch_number || null}, ${extractedItem.expiry_date || null}, ${confidence}, ${match.matchStatus}, ${match.matchedMedicineId})
				`);
			}
			await tx.$executeRaw(Prisma.sql`
				UPDATE "StockReceipt"
				SET "status" = 'READY_FOR_REVIEW', "processedAt" = NOW(), "errorMessage" = NULL
				WHERE "id" = ${receiptId} AND "status" = 'PROCESSING'
			`);
		});
		logReceiptProcessStep('database_update', dbUpdateStartedAt, { receiptId, status: 'READY_FOR_REVIEW' });
		logReceiptProcessStep('final_response', startedAt, { receiptId, status: 'READY_FOR_REVIEW' });
		return getReceiptDetails(receiptId);
	} catch (error) {
		const alreadyFailed = error.receiptStatus === 'FAILED' && error.statusCode && error.statusCode !== 500;
		const shouldPersistFailure = !['CONFIRMED', 'READY_FOR_REVIEW'].includes(error.receiptStatus)
			&& error.statusCode !== 404
			&& error.statusCode !== 409;
		if (shouldPersistFailure && !alreadyFailed) {
			try {
				await markReceiptFailed(receiptId, error.message || 'Receipt processing failed. Please try again.');
				error.receiptStatus = 'FAILED';
			} catch (updateError) {
				console.error('Could not mark receipt processing failure:', updateError);
			}
		}
		if (!error.statusCode || error.statusCode === 500) {
			logReceiptProcessStep('failed', startedAt, {
				receiptId,
				statusCode: error.statusCode || 500,
				code: error.code || null,
			});
		}
		throw error;
	} finally {
		receiptProcessingLocks.delete(receiptId);
	}
};

const sendReceiptProcessError = (res, receiptId, error) => {
	const adminMessage = sanitizeReceiptErrorMessage(error.message || 'Receipt processing failed. Please try again.');
	const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
	const status = error.receiptStatus || (statusCode === 409 ? undefined : 'FAILED');
	if (statusCode >= 400 && statusCode < 600 && statusCode !== 500) {
		return res.status(statusCode).json({ error: adminMessage, receiptId, status });
	}
	console.error('Receipt process failed:', error.code || error.message || error);
	return res.status(500).json({ error: adminMessage, receiptId, status: 'FAILED' });
};

app.post('/api/stock/receipt/process', requireAdmin, requireStockSchema, rateLimit('receipt-process', MAX_RECEIPT_PROCESS_RETRIES, 60_000), async (req, res) => {
	const receiptId = typeof req.body?.receiptId === 'string' ? req.body.receiptId.trim() : '';
	if (!receiptId) return res.status(400).json({ error: 'receiptId is required' });
	try {
		res.json(await runReceiptProcessing(receiptId, { allowReadyPassthrough: true }));
	} catch (error) {
		return sendReceiptProcessError(res, receiptId, error);
	}
});

app.post('/api/stock/receipt/retry', requireAdmin, requireStockSchema, rateLimit('receipt-retry', MAX_RECEIPT_PROCESS_RETRIES, 60_000), async (req, res) => {
	const receiptId = typeof req.body?.receiptId === 'string' ? req.body.receiptId.trim() : '';
	if (!receiptId) return res.status(400).json({ error: 'receiptId is required' });
	try {
		const receipts = await prisma.$queryRaw(Prisma.sql`
			SELECT "id", "status" FROM "StockReceipt" WHERE "id" = ${receiptId}
		`);
		if (receipts.length === 0) return res.status(404).json({ error: 'Receipt not found' });
		const receipt = receipts[0];
		if (receipt.status === 'CONFIRMED') {
			return res.status(409).json({ error: 'Confirmed receipts cannot be reprocessed', receiptId, status: 'CONFIRMED' });
		}
		if (receipt.status !== 'FAILED') {
			return res.status(409).json({
				error: 'Only failed receipts can be retried',
				receiptId,
				status: receipt.status,
			});
		}
		res.json(await runReceiptProcessing(receiptId, { allowReadyPassthrough: false }));
	} catch (error) {
		return sendReceiptProcessError(res, receiptId, error);
	}
});

app.get('/api/stock/receipt/:id', requireAdmin, requireStockSchema, async (req, res, next) => {
	try {
		const receipt = await getReceiptDetails(req.params.id);
		if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
		res.json(receipt);
	} catch (error) {
		next(error);
	}
});

app.post('/api/stock/receipt/confirm', requireAdmin, requireStockSchema, async (req, res, next) => {
	const receiptId = typeof req.body?.receiptId === 'string' ? req.body.receiptId : '';
	const reviewItems = Array.isArray(req.body?.items) ? req.body.items : null;
	if (!receiptId || !reviewItems) return res.status(400).json({ error: 'receiptId and review items are required' });
	if (reviewItems.length > 100) return res.status(400).json({ error: 'A receipt cannot contain more than 100 items' });
	const itemIds = new Set();
	for (const item of reviewItems) {
		if (!item || typeof item.id !== 'string' || itemIds.has(item.id) || typeof item.medicineId !== 'string' || !Number.isInteger(item.quantity) || item.quantity <= 0 || item.quantity > 1000000) {
			return res.status(400).json({ error: 'Each confirmed item needs a unique id, medicine, and positive quantity' });
		}
		itemIds.add(item.id);
	}

	try {
		const result = await prisma.$transaction(async (tx) => {
			const receipts = await tx.$queryRaw(Prisma.sql`SELECT "id", "status" FROM "StockReceipt" WHERE "id" = ${receiptId} FOR UPDATE`);
			if (receipts.length === 0) return { type: 'missing' };
			if (receipts[0].status === 'CONFIRMED') {
				const transactions = await tx.$queryRaw(Prisma.sql`SELECT "medicineId", "previousStock", "quantity", "newStock" FROM "StockTransaction" WHERE "receiptId" = ${receiptId} ORDER BY "createdAt" ASC`);
				return { type: 'already-confirmed', transactions };
			}
			if (receipts[0].status !== 'READY_FOR_REVIEW') return { type: 'not-ready' };

			const receiptItems = await tx.$queryRaw(Prisma.sql`SELECT "id", "medicineName", "quantity", "matchedMedicineId", "batchNumber", "expiryDate" FROM "StockReceiptItem" WHERE "receiptId" = ${receiptId} FOR UPDATE`);
			const receiptItemMap = new Map(receiptItems.map((item) => [item.id, item]));

			const missingExpiryRows = [];
			const prepared = [];
			for (const reviewItem of reviewItems) {
				const receiptItem = receiptItemMap.get(reviewItem.id);
				if (!receiptItem) throw Object.assign(new Error('Receipt item does not belong to this receipt'), { statusCode: 400 });
				const expiryRaw = reviewItem.expiryDate ?? receiptItem.expiryDate;
				const parsedExpiry = parseExpiryDate(expiryRaw);
				if (!parsedExpiry) {
					missingExpiryRows.push(typeof reviewItem.medicineName === 'string' && reviewItem.medicineName.trim()
						? reviewItem.medicineName.trim()
						: receiptItem.medicineName);
					continue;
				}
				prepared.push({
					reviewItem,
					receiptItem,
					batchNumber: normalizeBatchNumber(reviewItem.batchNumber ?? receiptItem.batchNumber),
					expiryDate: parsedExpiry,
				});
			}
			if (missingExpiryRows.length > 0) {
				throw Object.assign(new Error(`Expiry date required for: ${missingExpiryRows.join(', ')}`), { statusCode: 400 });
			}

			const updated = [];
			const warningCutoff = new Date();
			warningCutoff.setUTCDate(warningCutoff.getUTCDate() + resolvedExpiryWarningDays);
			let expiringItemCount = 0;

			for (const { reviewItem, receiptItem, batchNumber, expiryDate } of prepared) {
				const medicines = await tx.$queryRaw(Prisma.sql`SELECT "id", "availableQty" FROM "Medicine" WHERE "id" = ${reviewItem.medicineId} FOR UPDATE`);
				if (medicines.length === 0) throw Object.assign(new Error('One selected medicine no longer exists'), { statusCode: 400 });
				await seedLegacyStockBatchIfNeeded(tx, reviewItem.medicineId);
				const seeded = await tx.$queryRaw(Prisma.sql`SELECT "availableQty" FROM "Medicine" WHERE "id" = ${reviewItem.medicineId}`);
				const previousStock = Number(seeded[0].availableQty);
				await addToStockBatch(tx, {
					medicineId: reviewItem.medicineId,
					batchNumber,
					expiryDate,
					quantityDelta: reviewItem.quantity,
				});
				const newStock = await recomputeMedicineQty(tx, reviewItem.medicineId);
				if (newStock > 2147483647) throw Object.assign(new Error('Stock quantity is too large'), { statusCode: 400 });
				const medicineName = typeof reviewItem.medicineName === 'string' && reviewItem.medicineName.trim()
					? reviewItem.medicineName.trim()
					: receiptItem.medicineName;
				const expiryStored = expiryDateToStorageString(expiryDate);
				await tx.$executeRaw(Prisma.sql`
					UPDATE "StockReceiptItem"
					SET "medicineName" = ${medicineName},
						"quantity" = ${reviewItem.quantity},
						"matchedMedicineId" = ${reviewItem.medicineId},
						"matchStatus" = 'MATCHED',
						"batchNumber" = ${batchNumber},
						"expiryDate" = ${expiryStored}
					WHERE "id" = ${reviewItem.id}
				`);
				await writeStockTransaction(tx, {
					receiptId,
					medicineId: reviewItem.medicineId,
					transactionType: 'PURCHASE_RECEIPT',
					quantity: reviewItem.quantity,
					previousStock,
					newStock,
					batchNumber,
					expiryDate,
					createdBy: req.adminId || 'admin',
				});
				if (expiryDate <= warningCutoff) expiringItemCount += 1;
				updated.push({
					medicineId: reviewItem.medicineId,
					previousStock,
					quantityAdded: reviewItem.quantity,
					newStock,
					batchNumber,
					expiryDate: expiryStored,
				});
			}
			const skipped = receiptItems.filter((item) => !itemIds.has(item.id)).map((item) => ({
				id: item.id,
				medicineName: item.medicineName,
				reason: item.quantity === null ? 'Quantity is missing' : 'Not matched or skipped',
			}));
			await tx.$executeRaw(Prisma.sql`UPDATE "StockReceipt" SET "status" = 'CONFIRMED', "confirmedBy" = ${req.adminId || 'admin'}, "confirmedAt" = NOW(), "fileData" = ${Buffer.alloc(0)} WHERE "id" = ${receiptId}`);
			return { type: 'confirmed', updated, skipped, expiringItemCount };
		});
		if (result.type === 'missing') return res.status(404).json({ error: 'Receipt not found' });
		if (result.type === 'not-ready') return res.status(409).json({ error: 'Receipt is not ready for confirmation' });
		if (result.type === 'already-confirmed') {
			return res.json({
				status: 'CONFIRMED',
				alreadyConfirmed: true,
				updated: result.transactions.map((item) => ({
					medicineId: item.medicineId,
					previousStock: Number(item.previousStock),
					quantityAdded: Number(item.quantity),
					newStock: Number(item.newStock),
				})),
				skipped: [],
			});
		}
		res.json({ status: 'CONFIRMED', updated: result.updated, skipped: result.skipped, expiringItemCount: result.expiringItemCount });
	} catch (error) {
		if (error.statusCode === 400 || error.message === 'One selected medicine no longer exists' || error.message === 'Receipt item does not belong to this receipt' || error.message === 'Stock quantity is too large' || error.message?.startsWith('Expiry date required')) {
			return res.status(400).json({ error: error.message });
		}
		next(error);
	}
});

app.patch('/api/admin/update-stock', requireAdmin, requireStockSchema, async (req, res, next) => {
	const { medicineId, availableQty, singlePiecePrice, fullBoxPrice, expiryDate, batchNumber, reason } = req.body || {};
	const parsedQty = Number(availableQty);
	const parsedPiecePrice = Number(singlePiecePrice);
	const parsedBoxPrice = Number(fullBoxPrice);

	if (!medicineId || !Number.isInteger(parsedQty) || parsedQty < 0
		|| !Number.isFinite(parsedPiecePrice) || parsedPiecePrice < 0
		|| !Number.isFinite(parsedBoxPrice) || parsedBoxPrice < 0) {
		return res.status(400).json({
			error: 'medicineId, availableQty, singlePiecePrice, and fullBoxPrice are required with non-negative values',
		});
	}

	try {
		const result = await prisma.$transaction(async (tx) => {
			const medicines = await tx.$queryRaw(Prisma.sql`
				SELECT "id", "availableQty", "piece_price", "box_price", "brandName", "genericName", "manufacturer", "strength", "createdAt", "updatedAt"
				FROM "Medicine" WHERE "id" = ${String(medicineId)} FOR UPDATE
			`);
			if (medicines.length === 0) return { type: 'missing' };
			await seedLegacyStockBatchIfNeeded(tx, String(medicineId));
			const refreshed = await tx.$queryRaw(Prisma.sql`
				SELECT "id", "availableQty", "piece_price", "box_price", "brandName", "genericName", "manufacturer", "strength", "createdAt", "updatedAt"
				FROM "Medicine" WHERE "id" = ${String(medicineId)}
			`);
			const medicine = refreshed[0];
			const previousStock = Number(medicine.availableQty);
			const qtyDelta = parsedQty - previousStock;
			let parsedExpiry = null;

			if (qtyDelta > 0) {
				parsedExpiry = parseExpiryDate(expiryDate);
				if (!parsedExpiry) {
					throw Object.assign(new Error('expiryDate is required when increasing availableQty'), { statusCode: 400 });
				}
				await addToStockBatch(tx, {
					medicineId: String(medicineId),
					batchNumber: normalizeBatchNumber(batchNumber),
					expiryDate: parsedExpiry,
					quantityDelta: qtyDelta,
				});
			} else if (qtyDelta < 0) {
				parsedExpiry = parseExpiryDate(expiryDate);
				const normalizedBatch = normalizeBatchNumber(batchNumber);
				if (normalizedBatch || parsedExpiry) {
					const batch = await findStockBatch(tx, String(medicineId), normalizedBatch, parsedExpiry);
					if (!batch || Number(batch.quantity) < Math.abs(qtyDelta)) {
						throw Object.assign(new Error('Not enough quantity on the specified batch to reduce stock'), { statusCode: 400 });
					}
					await tx.$executeRaw(Prisma.sql`
						UPDATE "StockBatch" SET "quantity" = ${Number(batch.quantity) + qtyDelta}, "updatedAt" = NOW() WHERE "id" = ${batch.id}
					`);
				} else {
					await reduceStockAcrossBatches(tx, String(medicineId), Math.abs(qtyDelta));
				}
			}

			if (qtyDelta !== 0) {
				const newStock = await recomputeMedicineQty(tx, String(medicineId));
				await writeStockTransaction(tx, {
					medicineId: String(medicineId),
					transactionType: 'MANUAL_ADJUSTMENT',
					quantity: Math.abs(qtyDelta),
					previousStock,
					newStock,
					batchNumber: normalizeBatchNumber(batchNumber),
					expiryDate: parsedExpiry,
					reason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : 'Legacy update-stock',
					createdBy: req.adminId || 'admin',
				});
			}

			// Schema is controlled by Prisma — piece_price / box_price always exist. No information_schema probe.
			const updatedRows = await tx.$queryRaw(Prisma.sql`
				UPDATE "Medicine"
				SET "piece_price" = ${parsedPiecePrice}, "box_price" = ${parsedBoxPrice}, "updatedAt" = NOW()
				WHERE "id" = ${String(medicineId)}
				RETURNING "id", "availableQty", "piece_price", "box_price", "brandName", "genericName", "manufacturer", "strength", "createdAt", "updatedAt"
			`);
			return { type: 'ok', medicine: updatedRows[0], pricesSaved: true };
		});

		if (result.type === 'missing') return res.status(404).json({ error: 'Medicine not found' });
		const medicine = result.medicine;
		res.json(serializeDatabaseValue({
			...mapMedicineRow(medicine),
			pricesSaved: result.pricesSaved,
		}));
	} catch (error) {
		if (error.statusCode === 400) return res.status(400).json({ error: error.message });
		if (error.code === 'P2025') return res.status(404).json({ error: 'Medicine not found' });
		next(error);
	}
});

app.post('/api/admin/stock/adjust', requireAdmin, requireStockSchema, async (req, res, next) => {
	const medicineId = typeof req.body?.medicineId === 'string' ? req.body.medicineId : '';
	const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
	const hasAbsolute = req.body?.absoluteQty !== undefined && req.body?.absoluteQty !== null && req.body?.absoluteQty !== '';
	const hasDelta = req.body?.delta !== undefined && req.body?.delta !== null && req.body?.delta !== '';
	const absoluteQty = hasAbsolute ? Number(req.body.absoluteQty) : null;
	const delta = hasDelta ? Number(req.body.delta) : null;
	const batchNumber = normalizeBatchNumber(req.body?.batchNumber);
	const batchId = typeof req.body?.batchId === 'string' ? req.body.batchId : null;
	const parsedExpiry = parseExpiryDate(req.body?.expiryDate);

	if (!medicineId) return res.status(400).json({ error: 'medicineId is required' });
	if (!reason || reason.length > 200) return res.status(400).json({ error: 'reason is required (max 200 characters)' });
	if (hasAbsolute === hasDelta) return res.status(400).json({ error: 'Provide exactly one of absoluteQty or delta' });
	if (hasAbsolute && (!Number.isInteger(absoluteQty) || absoluteQty < 0)) {
		return res.status(400).json({ error: 'absoluteQty must be a non-negative integer' });
	}
	if (hasDelta && (!Number.isInteger(delta) || delta === 0)) {
		return res.status(400).json({ error: 'delta must be a non-zero integer' });
	}

	try {
		const result = await prisma.$transaction(async (tx) => {
			const medicines = await tx.$queryRaw(Prisma.sql`SELECT * FROM "Medicine" WHERE "id" = ${medicineId} FOR UPDATE`);
			if (medicines.length === 0) return { type: 'missing' };
			await seedLegacyStockBatchIfNeeded(tx, medicineId);
			const refreshed = await tx.$queryRaw(Prisma.sql`SELECT * FROM "Medicine" WHERE "id" = ${medicineId}`);
			const previousStock = Number(refreshed[0].availableQty);
			const targetDelta = hasAbsolute ? absoluteQty - previousStock : delta;
			if (targetDelta === 0) return { type: 'noop', medicine: refreshed[0], previousStock, newStock: previousStock };

			if (targetDelta > 0 && !parsedExpiry) {
				throw Object.assign(new Error('expiryDate is required when adding stock'), { statusCode: 400 });
			}

			if (batchId) {
				const batches = await tx.$queryRaw(Prisma.sql`SELECT * FROM "StockBatch" WHERE "id" = ${batchId} AND "medicineId" = ${medicineId} FOR UPDATE`);
				if (batches.length === 0) throw Object.assign(new Error('Batch not found for this medicine'), { statusCode: 404 });
				const batch = batches[0];
				const nextQty = Number(batch.quantity) + targetDelta;
				if (nextQty < 0) throw Object.assign(new Error('Batch quantity cannot go below zero'), { statusCode: 400 });
				if (targetDelta > 0 && !parseExpiryDate(batch.expiryDate) && !parsedExpiry) {
					throw Object.assign(new Error('expiryDate is required when adding stock'), { statusCode: 400 });
				}
				await tx.$executeRaw(Prisma.sql`
					UPDATE "StockBatch"
					SET "quantity" = ${nextQty},
						"expiryDate" = ${parsedExpiry || batch.expiryDate},
						"batchNumber" = ${batchNumber ?? batch.batchNumber},
						"updatedAt" = NOW()
					WHERE "id" = ${batch.id}
				`);
			} else if (targetDelta > 0) {
				await addToStockBatch(tx, {
					medicineId,
					batchNumber,
					expiryDate: parsedExpiry,
					quantityDelta: targetDelta,
				});
			} else if (batchNumber || parsedExpiry) {
				const batch = await findStockBatch(tx, medicineId, batchNumber, parsedExpiry);
				if (!batch || Number(batch.quantity) < Math.abs(targetDelta)) {
					throw Object.assign(new Error('Not enough quantity on the specified batch'), { statusCode: 400 });
				}
				await tx.$executeRaw(Prisma.sql`
					UPDATE "StockBatch" SET "quantity" = ${Number(batch.quantity) + targetDelta}, "updatedAt" = NOW() WHERE "id" = ${batch.id}
				`);
			} else {
				await reduceStockAcrossBatches(tx, medicineId, Math.abs(targetDelta));
			}

			const newStock = await recomputeMedicineQty(tx, medicineId);
			await writeStockTransaction(tx, {
				medicineId,
				transactionType: 'MANUAL_ADJUSTMENT',
				quantity: Math.abs(targetDelta),
				previousStock,
				newStock,
				batchNumber,
				expiryDate: parsedExpiry,
				reason,
				createdBy: req.adminId || 'admin',
			});
			const updated = await tx.$queryRaw(Prisma.sql`SELECT * FROM "Medicine" WHERE "id" = ${medicineId}`);
			return { type: 'ok', medicine: updated[0], previousStock, newStock, delta: targetDelta };
		});

		if (result.type === 'missing') return res.status(404).json({ error: 'Medicine not found' });
		res.json(serializeDatabaseValue({
			...result.medicine,
			singlePiecePrice: Number(result.medicine.piece_price ?? result.medicine.singlePiecePrice ?? 0),
			fullBoxPrice: Number(result.medicine.box_price ?? result.medicine.fullBoxPrice ?? 0),
			previousStock: result.previousStock,
			newStock: result.newStock,
			delta: result.delta || 0,
		}));
	} catch (error) {
		if (error.statusCode === 400 || error.statusCode === 404) return res.status(error.statusCode).json({ error: error.message });
		next(error);
	}
});

app.get('/api/admin/dashboard', requireAdmin, requireStockSchema, async (_req, res, next) => {
	try {
		const today = new Date();
		const warningDate = new Date(today);
		warningDate.setUTCDate(warningDate.getUTCDate() + resolvedExpiryWarningDays);

		const [
			[medicineCount],
			[lowStock],
			[expiringSoon],
			[expired],
			[pendingReceipts],
			recentTransactions,
		] = await Promise.all([
			prisma.$queryRaw(Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "Medicine"`),
			prisma.$queryRaw(Prisma.sql`
				SELECT COUNT(*)::int AS "count" FROM "Medicine" WHERE "availableQty" <= ${resolvedLowStockThreshold}
			`),
			prisma.$queryRaw(Prisma.sql`
				SELECT COUNT(*)::int AS "count" FROM "StockBatch"
				WHERE "quantity" > 0 AND "expiryDate" IS NOT NULL
					AND "expiryDate" >= ${today} AND "expiryDate" <= ${warningDate}
			`),
			prisma.$queryRaw(Prisma.sql`
				SELECT COUNT(*)::int AS "count" FROM "StockBatch"
				WHERE "quantity" > 0 AND "expiryDate" IS NOT NULL AND "expiryDate" < ${today}
			`),
			prisma.$queryRaw(Prisma.sql`
				SELECT COUNT(*)::int AS "count" FROM "StockReceipt"
				WHERE "status" IN ('PROCESSING', 'READY_FOR_REVIEW', 'FAILED')
			`),
			prisma.$queryRaw(Prisma.sql`
				SELECT t."id", t."medicineId", t."transactionType", t."quantity", t."previousStock", t."newStock",
					t."batchNumber", t."expiryDate", t."reason", t."createdBy", t."createdAt",
					m."brandName", m."strength"
				FROM "StockTransaction" t
				LEFT JOIN "Medicine" m ON m."id" = t."medicineId"
				ORDER BY t."createdAt" DESC
				LIMIT 10
			`),
		]);

		res.json(serializeDatabaseValue({
			totalMedicines: Number(medicineCount.count || 0),
			lowStockCount: Number(lowStock.count || 0),
			expiringSoonCount: Number(expiringSoon.count || 0),
			expiredCount: Number(expired.count || 0),
			pendingReceipts: Number(pendingReceipts.count || 0),
			lowStockThreshold: resolvedLowStockThreshold,
			expiryWarningDays: resolvedExpiryWarningDays,
			recentTransactions,
		}));
	} catch (error) {
		next(error);
	}
});

app.get('/api/admin/stock/low', requireAdmin, requireStockSchema, async (req, res, next) => {
	try {
		const thresholdRaw = Number.parseInt(req.query.threshold, 10);
		const threshold = Number.isInteger(thresholdRaw) && thresholdRaw >= 0 ? thresholdRaw : resolvedLowStockThreshold;
		const { limit, offset } = parseLimitOffset(req.query, 50, 200);
		const rows = await prisma.$queryRaw(Prisma.sql`
			SELECT ${MEDICINE_LIST_SELECT} FROM "Medicine"
			WHERE "availableQty" <= ${threshold}
			ORDER BY "availableQty" ASC, "brandName" ASC
			LIMIT ${limit} OFFSET ${offset}
		`);
		res.json(serializeDatabaseValue(rows.map(mapMedicineRow)));
	} catch (error) {
		next(error);
	}
});

app.get('/api/admin/stock/expiring', requireAdmin, requireStockSchema, async (req, res, next) => {
	try {
		const daysRaw = Number.parseInt(req.query.days, 10);
		const days = Number.isInteger(daysRaw) && daysRaw > 0 ? daysRaw : resolvedExpiryWarningDays;
		const includeExpired = req.query.includeExpired !== 'false';
		const { limit, offset } = parseLimitOffset(req.query, 50, 200);
		const today = new Date();
		const warningDate = new Date(today);
		warningDate.setUTCDate(warningDate.getUTCDate() + days);

		const rows = includeExpired
			? await prisma.$queryRaw(Prisma.sql`
				SELECT b.*, m."brandName", m."genericName", m."strength", m."availableQty"
				FROM "StockBatch" b
				JOIN "Medicine" m ON m."id" = b."medicineId"
				WHERE b."quantity" > 0 AND b."expiryDate" IS NOT NULL AND b."expiryDate" <= ${warningDate}
				ORDER BY b."expiryDate" ASC
				LIMIT ${limit} OFFSET ${offset}
			`)
			: await prisma.$queryRaw(Prisma.sql`
				SELECT b.*, m."brandName", m."genericName", m."strength", m."availableQty"
				FROM "StockBatch" b
				JOIN "Medicine" m ON m."id" = b."medicineId"
				WHERE b."quantity" > 0 AND b."expiryDate" IS NOT NULL
					AND b."expiryDate" >= ${today} AND b."expiryDate" <= ${warningDate}
				ORDER BY b."expiryDate" ASC
				LIMIT ${limit} OFFSET ${offset}
			`);
		res.json(serializeDatabaseValue(rows));
	} catch (error) {
		next(error);
	}
});

app.get('/api/admin/batches', requireAdmin, requireStockSchema, async (req, res, next) => {
	try {
		const medicineId = typeof req.query.medicineId === 'string' ? req.query.medicineId : '';
		if (!medicineId) return res.status(400).json({ error: 'medicineId is required' });
		const rows = await prisma.$queryRaw(Prisma.sql`
			SELECT b.*, m."brandName", m."strength"
			FROM "StockBatch" b
			JOIN "Medicine" m ON m."id" = b."medicineId"
			WHERE b."medicineId" = ${medicineId}
			ORDER BY b."expiryDate" ASC NULLS LAST, b."createdAt" ASC
		`);
		res.json(serializeDatabaseValue(rows));
	} catch (error) {
		next(error);
	}
});

app.patch('/api/admin/batches/:id', requireAdmin, requireStockSchema, async (req, res, next) => {
	const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
	if (!reason || reason.length > 200) return res.status(400).json({ error: 'reason is required (max 200 characters)' });
	const hasQuantity = req.body?.quantity !== undefined && req.body?.quantity !== null && req.body?.quantity !== '';
	const quantity = hasQuantity ? Number(req.body.quantity) : null;
	const batchNumber = req.body?.batchNumber !== undefined ? normalizeBatchNumber(req.body.batchNumber) : undefined;
	const parsedExpiry = req.body?.expiryDate !== undefined ? parseExpiryDate(req.body.expiryDate) : undefined;
	if (hasQuantity && (!Number.isInteger(quantity) || quantity < 0)) {
		return res.status(400).json({ error: 'quantity must be a non-negative integer' });
	}
	if (req.body?.expiryDate !== undefined && req.body?.expiryDate !== null && req.body?.expiryDate !== '' && !parsedExpiry) {
		return res.status(400).json({ error: 'expiryDate is invalid' });
	}

	try {
		const result = await prisma.$transaction(async (tx) => {
			const batches = await tx.$queryRaw(Prisma.sql`SELECT * FROM "StockBatch" WHERE "id" = ${String(req.params.id)} FOR UPDATE`);
			if (batches.length === 0) return { type: 'missing' };
			const batch = batches[0];
			const nextQuantity = hasQuantity ? quantity : Number(batch.quantity);
			const qtyDelta = nextQuantity - Number(batch.quantity);
			const nextExpiry = parsedExpiry !== undefined ? parsedExpiry : batch.expiryDate;
			if (qtyDelta > 0 && !parseExpiryDate(nextExpiry)) {
				throw Object.assign(new Error('expiryDate is required when increasing batch quantity'), { statusCode: 400 });
			}
			const nextBatchNumber = batchNumber !== undefined ? batchNumber : batch.batchNumber;
			await tx.$executeRaw(Prisma.sql`
				UPDATE "StockBatch"
				SET "quantity" = ${nextQuantity},
					"expiryDate" = ${nextExpiry},
					"batchNumber" = ${nextBatchNumber},
					"updatedAt" = NOW()
				WHERE "id" = ${batch.id}
			`);
			const medicines = await tx.$queryRaw(Prisma.sql`SELECT "availableQty" FROM "Medicine" WHERE "id" = ${batch.medicineId} FOR UPDATE`);
			const previousStock = Number(medicines[0]?.availableQty || 0);
			const newStock = await recomputeMedicineQty(tx, batch.medicineId);
			if (qtyDelta !== 0) {
				await writeStockTransaction(tx, {
					medicineId: batch.medicineId,
					transactionType: 'MANUAL_ADJUSTMENT',
					quantity: Math.abs(qtyDelta),
					previousStock,
					newStock,
					batchNumber: nextBatchNumber,
					expiryDate: nextExpiry,
					reason,
					createdBy: req.adminId || 'admin',
				});
			}
			const updated = await tx.$queryRaw(Prisma.sql`SELECT * FROM "StockBatch" WHERE "id" = ${batch.id}`);
			return { type: 'ok', batch: updated[0], previousStock, newStock };
		});
		if (result.type === 'missing') return res.status(404).json({ error: 'Batch not found' });
		res.json(serializeDatabaseValue(result));
	} catch (error) {
		if (error.statusCode === 400) return res.status(400).json({ error: error.message });
		next(error);
	}
});

app.get('/api/admin/stock/transactions', requireAdmin, requireStockSchema, async (req, res, next) => {
	try {
		const { limit, offset } = parseLimitOffset(req.query, 50, 200);
		const medicineId = typeof req.query.medicineId === 'string' && req.query.medicineId ? req.query.medicineId : null;
		const transactionType = typeof req.query.type === 'string' && req.query.type.trim()
			? req.query.type.trim().toUpperCase()
			: null;
		const from = parseExpiryDate(req.query.from) || (typeof req.query.from === 'string' && req.query.from ? new Date(req.query.from) : null);
		const to = parseExpiryDate(req.query.to) || (typeof req.query.to === 'string' && req.query.to ? new Date(req.query.to) : null);
		const fromDate = from && !Number.isNaN(from.getTime()) ? from : null;
		let toDate = to && !Number.isNaN(to.getTime()) ? to : null;
		if (toDate && typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to.trim())) {
			toDate = new Date(toDate);
			toDate.setUTCHours(23, 59, 59, 999);
		}

		const conditions = [];
		if (medicineId) conditions.push(Prisma.sql`t."medicineId" = ${medicineId}`);
		if (transactionType) conditions.push(Prisma.sql`t."transactionType" = ${transactionType}`);
		if (fromDate) conditions.push(Prisma.sql`t."createdAt" >= ${fromDate}`);
		if (toDate) conditions.push(Prisma.sql`t."createdAt" <= ${toDate}`);
		const whereSql = conditions.length > 0
			? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
			: Prisma.empty;

		const rows = await prisma.$queryRaw(Prisma.sql`
			SELECT t.*, m."brandName", m."strength" FROM "StockTransaction" t
			LEFT JOIN "Medicine" m ON m."id" = t."medicineId"
			${whereSql}
			ORDER BY t."createdAt" DESC LIMIT ${limit} OFFSET ${offset}
		`);
		res.json(serializeDatabaseValue(rows));
	} catch (error) {
		next(error);
	}
});

app.get('/api/admin/receipts', requireAdmin, requireStockSchema, async (req, res, next) => {
	try {
		const { limit, offset } = parseLimitOffset(req.query, 50, 200);
		const status = typeof req.query.status === 'string' && req.query.status.trim() ? req.query.status.trim().toUpperCase() : null;
		const rows = status
			? await prisma.$queryRaw(Prisma.sql`
				SELECT "id", "fileName", "mimeType", "fileHash", "status", "uploadedBy", "uploadedAt", "processedAt", "confirmedBy", "confirmedAt", "errorMessage"
				FROM "StockReceipt" WHERE "status" = ${status}
				ORDER BY "uploadedAt" DESC LIMIT ${limit} OFFSET ${offset}
			`)
			: await prisma.$queryRaw(Prisma.sql`
				SELECT "id", "fileName", "mimeType", "fileHash", "status", "uploadedBy", "uploadedAt", "processedAt", "confirmedBy", "confirmedAt", "errorMessage"
				FROM "StockReceipt"
				ORDER BY "uploadedAt" DESC LIMIT ${limit} OFFSET ${offset}
			`);
		res.json(serializeDatabaseValue(rows));
	} catch (error) {
		next(error);
	}
});

/**
 * Delete a non-confirmed receipt.
 * File bytes live in StockReceipt.fileData (no external blob). Cascade removes items.
 * CONFIRMED receipts are retained for audit/history (StockTransaction FK is RESTRICT).
 */
app.delete('/api/admin/receipts/:id', requireAdmin, requireStockSchema, async (req, res, next) => {
	const receiptId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
	if (!receiptId) return res.status(400).json({ error: 'Receipt id is required' });
	if (receiptProcessingLocks.has(receiptId)) {
		return res.status(409).json({ error: 'This receipt is being processed and cannot be deleted right now.', receiptId });
	}
	try {
		const receipts = await prisma.$queryRaw(Prisma.sql`
			SELECT "id", "fileName", "status" FROM "StockReceipt" WHERE "id" = ${receiptId}
		`);
		if (receipts.length === 0) {
			return res.status(404).json({ error: 'Receipt not found or already deleted' });
		}
		const receipt = receipts[0];
		if (receipt.status === 'CONFIRMED') {
			return res.status(409).json({
				error: 'Confirmed receipts are retained for audit/history and cannot be deleted.',
				receiptId,
				status: 'CONFIRMED',
			});
		}

		// fileData is stored in-row; deleting the row removes the uploaded bytes.
		await prisma.$executeRaw(Prisma.sql`DELETE FROM "StockReceipt" WHERE "id" = ${receiptId} AND "status" <> 'CONFIRMED'`);
		const stillThere = await prisma.$queryRaw(Prisma.sql`SELECT "id" FROM "StockReceipt" WHERE "id" = ${receiptId}`);
		if (stillThere.length > 0) {
			return res.status(409).json({ error: 'Receipt could not be deleted. It may have been confirmed.', receiptId });
		}
		res.json({
			ok: true,
			deleted: true,
			receiptId,
			fileName: receipt.fileName,
			previousStatus: receipt.status,
		});
	} catch (error) {
		next(error);
	}
});

app.post('/api/admin/medicines', requireAdmin, requireStockSchema, async (req, res, next) => {
	const brandName = typeof req.body?.brandName === 'string' ? req.body.brandName.trim() : '';
	const genericName = typeof req.body?.genericName === 'string' ? req.body.genericName.trim() : '';
	const manufacturer = typeof req.body?.manufacturer === 'string' ? req.body.manufacturer.trim() : '';
	const strength = typeof req.body?.strength === 'string' ? req.body.strength.trim() : '';
	const singlePiecePrice = req.body?.singlePiecePrice === undefined ? 0 : Number(req.body.singlePiecePrice);
	const fullBoxPrice = req.body?.fullBoxPrice === undefined ? 0 : Number(req.body.fullBoxPrice);
	const hasInitialQty = req.body?.availableQty !== undefined && req.body?.availableQty !== null && req.body?.availableQty !== '';
	const availableQty = hasInitialQty ? Number(req.body.availableQty) : 0;
	const batchNumber = normalizeBatchNumber(req.body?.batchNumber);
	const parsedExpiry = parseExpiryDate(req.body?.expiryDate);
	const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
		? req.body.reason.trim().slice(0, 200)
		: 'Initial stock on create';

	if (!brandName || !genericName || !manufacturer || !strength) {
		return res.status(400).json({ error: 'brandName, genericName, manufacturer, and strength are required' });
	}
	if (!Number.isFinite(singlePiecePrice) || singlePiecePrice < 0 || !Number.isFinite(fullBoxPrice) || fullBoxPrice < 0) {
		return res.status(400).json({ error: 'Prices must be non-negative numbers' });
	}
	if (!Number.isInteger(availableQty) || availableQty < 0) {
		return res.status(400).json({ error: 'availableQty must be a non-negative integer' });
	}
	if (availableQty > 0 && !parsedExpiry) {
		return res.status(400).json({ error: 'expiryDate is required when adding initial stock' });
	}

	try {
		const existing = await prisma.$queryRaw(Prisma.sql`
			SELECT "id", "brandName", "strength" FROM "Medicine"
			WHERE "brandName" = ${brandName} AND "strength" = ${strength}
			LIMIT 1
		`);
		if (existing.length > 0) {
			return res.status(409).json({ error: 'A medicine with this brandName and strength already exists' });
		}

		const medicine = await prisma.$transaction(async (tx) => {
			const id = crypto.randomUUID();
			const rows = await tx.$queryRaw(Prisma.sql`
				INSERT INTO "Medicine" ("id", "brandName", "genericName", "manufacturer", "strength", "availableQty", "piece_price", "box_price", "createdAt", "updatedAt")
				VALUES (${id}, ${brandName}, ${genericName}, ${manufacturer}, ${strength}, 0, ${singlePiecePrice}, ${fullBoxPrice}, NOW(), NOW())
				RETURNING *
			`);
			let created = rows[0];
			if (availableQty > 0) {
				await addToStockBatch(tx, {
					medicineId: id,
					batchNumber,
					expiryDate: parsedExpiry,
					quantityDelta: availableQty,
				});
				const newStock = await recomputeMedicineQty(tx, id);
				await writeStockTransaction(tx, {
					medicineId: id,
					transactionType: 'MANUAL_ADJUSTMENT',
					quantity: availableQty,
					previousStock: 0,
					newStock,
					batchNumber,
					expiryDate: parsedExpiry,
					reason,
					createdBy: req.adminId || 'admin',
				});
				const refreshed = await tx.$queryRaw(Prisma.sql`SELECT * FROM "Medicine" WHERE "id" = ${id}`);
				created = refreshed[0];
			}
			return created;
		});

		res.status(201).json(serializeDatabaseValue({
			...medicine,
			singlePiecePrice: Number(medicine.piece_price ?? 0),
			fullBoxPrice: Number(medicine.box_price ?? 0),
		}));
	} catch (error) {
		if (error.statusCode === 400) return res.status(400).json({ error: error.message });
		next(error);
	}
});

app.patch('/api/admin/medicines/:id', requireAdmin, async (req, res, next) => {
	try {
		const medicines = await prisma.$queryRaw(Prisma.sql`SELECT * FROM "Medicine" WHERE "id" = ${String(req.params.id)}`);
		if (medicines.length === 0) return res.status(404).json({ error: 'Medicine not found' });
		const current = medicines[0];
		const brandName = typeof req.body?.brandName === 'string' ? req.body.brandName.trim() : current.brandName;
		const genericName = typeof req.body?.genericName === 'string' ? req.body.genericName.trim() : current.genericName;
		const manufacturer = typeof req.body?.manufacturer === 'string' ? req.body.manufacturer.trim() : current.manufacturer;
		const strength = typeof req.body?.strength === 'string' ? req.body.strength.trim() : current.strength;
		const singlePiecePrice = req.body?.singlePiecePrice !== undefined ? Number(req.body.singlePiecePrice) : Number(current.piece_price ?? current.singlePiecePrice ?? 0);
		const fullBoxPrice = req.body?.fullBoxPrice !== undefined ? Number(req.body.fullBoxPrice) : Number(current.box_price ?? current.fullBoxPrice ?? 0);
		if (!brandName || !genericName || !manufacturer || !strength) {
			return res.status(400).json({ error: 'Medicine fields cannot be empty' });
		}
		if (!Number.isFinite(singlePiecePrice) || singlePiecePrice < 0 || !Number.isFinite(fullBoxPrice) || fullBoxPrice < 0) {
			return res.status(400).json({ error: 'Prices must be non-negative numbers' });
		}
		const rows = await prisma.$queryRaw(Prisma.sql`
			UPDATE "Medicine"
			SET "brandName" = ${brandName}, "genericName" = ${genericName}, "manufacturer" = ${manufacturer},
				"strength" = ${strength}, "piece_price" = ${singlePiecePrice}, "box_price" = ${fullBoxPrice}, "updatedAt" = NOW()
			WHERE "id" = ${String(req.params.id)} RETURNING *
		`);
		const medicine = rows[0];
		res.json(serializeDatabaseValue({
			...medicine,
			singlePiecePrice: Number(medicine.piece_price ?? 0),
			fullBoxPrice: Number(medicine.box_price ?? 0),
		}));
	} catch (error) {
		next(error);
	}
});

app.post('/api/admin/alerts/expiry/send', requireAdmin, requireStockSchema, async (req, res, next) => {
	try {
		const daysRaw = Number.parseInt(req.body?.days, 10);
		const days = Number.isInteger(daysRaw) && daysRaw > 0 ? daysRaw : resolvedExpiryWarningDays;
		const { rows, today } = await listExpiringBatches(days);
		if (!mailTransport) return res.json({ sent: false, reason: 'smtp-not-configured', count: rows.length });
		const lines = rows.map((row) => {
			const expiry = row.expiryDate ? new Date(row.expiryDate).toISOString().slice(0, 10) : 'unknown';
			const status = row.expiryDate && new Date(row.expiryDate) < today ? 'EXPIRED' : 'EXPIRING';
			return `${status} | ${row.brandName} ${row.strength} | batch ${row.batchNumber || '—'} | qty ${row.quantity} | expiry ${expiry}`;
		});
		const text = [
			`Apollo Pharmacy expiry report (${days} day window)`,
			`Generated: ${today.toISOString()}`,
			`Items: ${rows.length}`,
			'',
			...(lines.length ? lines : ['No expiring or expired batches.']),
		].join('\n');
		const result = await sendAdminAlertEmail(`Apollo Pharmacy expiry alert (${rows.length} items)`, text);
		res.json({ ...result, count: rows.length, days });
	} catch (error) {
		next(error);
	}
});

app.get('/api/admin/push/status', requireAdmin, requireStockSchema, async (_req, res) => {
	const vapid = getVapidConfig();
	if (!vapid) return res.json({ enabled: false, reason: 'vapid-not-configured' });
	res.json({ enabled: true, publicKey: vapid.publicKey });
});

app.post('/api/admin/push/subscribe', requireAdmin, requireStockSchema, async (req, res, next) => {
	try {
		if (!getVapidConfig()) return res.status(503).json({ error: 'Push notifications are not configured (missing VAPID keys)', reason: 'vapid-not-configured' });
		const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : '';
		const p256dh = typeof req.body?.keys?.p256dh === 'string' ? req.body.keys.p256dh : '';
		const auth = typeof req.body?.keys?.auth === 'string' ? req.body.keys.auth : '';
		if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'endpoint and keys.p256dh / keys.auth are required' });
		const userAgent = typeof req.get('user-agent') === 'string' ? req.get('user-agent').slice(0, 300) : null;
		const existing = await prisma.$queryRaw(Prisma.sql`SELECT "id" FROM "PushSubscription" WHERE "endpoint" = ${endpoint} LIMIT 1`);
		if (existing.length > 0) {
			await prisma.$executeRaw(Prisma.sql`
				UPDATE "PushSubscription"
				SET "p256dh" = ${p256dh}, "auth" = ${auth}, "userAgent" = ${userAgent}, "createdBy" = ${req.adminId || 'admin'}, "updatedAt" = NOW()
				WHERE "endpoint" = ${endpoint}
			`);
		} else {
			await prisma.$executeRaw(Prisma.sql`
				INSERT INTO "PushSubscription" ("id", "endpoint", "p256dh", "auth", "userAgent", "createdBy", "createdAt", "updatedAt")
				VALUES (${crypto.randomUUID()}, ${endpoint}, ${p256dh}, ${auth}, ${userAgent}, ${req.adminId || 'admin'}, NOW(), NOW())
			`);
		}
		res.status(201).json({ subscribed: true });
	} catch (error) {
		next(error);
	}
});

app.delete('/api/admin/push/subscribe', requireAdmin, requireStockSchema, async (req, res, next) => {
	try {
		const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : '';
		if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
		await prisma.$executeRaw(Prisma.sql`DELETE FROM "PushSubscription" WHERE "endpoint" = ${endpoint}`);
		res.json({ subscribed: false });
	} catch (error) {
		next(error);
	}
});

app.post('/api/admin/push/cron/expiry', requireCronOrAdmin, requireStockSchema, async (req, res, next) => {
	try {
		if (!getVapidConfig()) {
			return res.json({ sent: false, reason: 'vapid-not-configured', count: 0 });
		}
		const daysRaw = Number.parseInt(req.body?.days ?? req.query?.days, 10);
		const days = Number.isInteger(daysRaw) && daysRaw > 0 ? daysRaw : resolvedExpiryWarningDays;
		const { rows } = await listExpiringBatches(days);
		const body = rows.length > 0
			? `${rows.length} batch(es) expired or expiring within ${days} days. Open admin to review.`
			: `No expired/expiring batches within ${days} days.`;
		const pushResult = await sendExpiryPushNotifications({
			days,
			title: 'Apollo Pharmacy expiry alert',
			body,
		});
		res.json({ ...pushResult, count: rows.length, days });
	} catch (error) {
		next(error);
	}
});

app.post('/api/appointments', (_req, res) => {
	res.status(410).json({ error: 'Appointments have been removed from this pharmacy.' });
});

app.get('/api/admin/appointments', requireAdmin, (_req, res) => {
	res.status(410).json({ error: 'Appointments have been removed from this pharmacy.' });
});

app.patch('/api/admin/appointments/:id', requireAdmin, (_req, res) => {
	res.status(410).json({ error: 'Appointments have been removed from this pharmacy.' });
});

app.post('/api/admin/medicines/sync', requireAdmin, async (_req, res, next) => {
	const apiUrl = process.env.MEDICINE_API_URL || DEFAULT_MEDICINE_API_URL;

	try {
		const response = await fetch(apiUrl, {
			headers: { Accept: 'text/csv, application/json;q=0.9, */*;q=0.8' },
			signal: AbortSignal.timeout(25_000),
		});
		if (!response.ok) return res.status(502).json({ error: 'Medicine API request failed' });
		const contentType = response.headers.get('content-type') || '';
		const payload = contentType.includes('json') ? await response.json() : await response.text();
		let records;
		if (typeof payload === 'string') {
			const rows = payload.split(/\r?\n/).filter((row) => row.trim());
			const headers = parseCsvLine(rows.shift() || '').map((header) => header.toLowerCase());
			const getColumn = (columns, names, fallback) => {
				const index = names.map((name) => headers.indexOf(name)).find((index) => index >= 0);
				return index === undefined ? fallback : columns[index] || fallback;
			};
			records = rows.map((row) => {
				const columns = parseCsvLine(row);
				return {
					brandName: getColumn(columns, ['brand name', 'brand', 'name'], ''),
					genericName: getColumn(columns, ['generic', 'generic name'], 'Generic Formula'),
					manufacturer: getColumn(columns, ['manufacturer', 'company'], 'Bangladeshi Pharma'),
					strength: getColumn(columns, ['strength', 'dosage'], 'Standard'),
				};
			});
		} else {
			records = Array.isArray(payload) ? payload : payload.data || payload.medicines || payload.results;
		}
		if (!Array.isArray(records)) return res.status(502).json({ error: 'Medicine API returned an unsupported format' });

		let imported = 0;
		let skipped = 0;
		const prepared = [];
		for (const item of records) {
			const brandName = String(item.brandName || item.brand || item.name || '').trim();
			const strength = String(item.strength || item.dosage || 'Standard').trim();
			if (!brandName) {
				skipped += 1;
				continue;
			}
			prepared.push({
				brandName,
				genericName: String(item.genericName || item.generic || 'Generic Formula').trim() || 'Generic Formula',
				manufacturer: String(item.manufacturer || item.company || 'Bangladeshi Pharma').trim() || 'Bangladeshi Pharma',
				strength,
			});
		}

		// One round-trip for existing keys instead of per-row SELECT.
		const existingRows = await prisma.$queryRaw(Prisma.sql`SELECT "brandName", "strength" FROM "Medicine"`);
		const existingKeys = new Set(existingRows.map((row) => `${row.brandName}::${row.strength}`));
		const toInsert = [];
		for (const item of prepared) {
			const key = `${item.brandName}::${item.strength}`;
			if (existingKeys.has(key)) {
				skipped += 1;
				continue;
			}
			existingKeys.add(key);
			toInsert.push(item);
		}

		const BATCH_SIZE = 100;
		for (let index = 0; index < toInsert.length; index += BATCH_SIZE) {
			const batch = toInsert.slice(index, index + BATCH_SIZE);
			const values = batch.map((item) => Prisma.sql`(
				${crypto.randomUUID()}, ${item.brandName}, ${item.genericName}, ${item.manufacturer}, ${item.strength},
				0, 0, 0, NOW(), NOW()
			)`);
			try {
				await prisma.$executeRaw(Prisma.sql`
					INSERT INTO "Medicine" ("id", "brandName", "genericName", "manufacturer", "strength", "availableQty", "piece_price", "box_price", "createdAt", "updatedAt")
					VALUES ${Prisma.join(values)}
				`);
				imported += batch.length;
			} catch (batchError) {
				console.error('Batch medicine import failed, falling back to row inserts:', batchError.message);
				for (const item of batch) {
					try {
						await prisma.$executeRaw(Prisma.sql`
							INSERT INTO "Medicine" ("id", "brandName", "genericName", "manufacturer", "strength", "availableQty", "piece_price", "box_price", "createdAt", "updatedAt")
							VALUES (${crypto.randomUUID()}, ${item.brandName}, ${item.genericName}, ${item.manufacturer}, ${item.strength}, 0, 0, 0, NOW(), NOW())
						`);
						imported += 1;
					} catch (rowError) {
						console.error(`Skipping medicine import for ${item.brandName}:`, rowError.message);
						skipped += 1;
					}
				}
			}
		}
		res.json({ imported, skipped, total: records.length });
	} catch (error) {
		if (error.name === 'TimeoutError' || error.name === 'AbortError') {
			return res.status(504).json({ error: 'Medicine catalog sync timed out. Try again later.' });
		}
		next(error);
	}
});

app.post('/api/chat', rateLimit('chat', 15, 60_000), async (req, res, next) => {
	const { prompt } = req.body || {};

	if (typeof prompt !== 'string' || prompt.trim().length === 0) {
		return res.status(400).json({ error: 'A non-empty prompt is required' });
	}

	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		return res.status(503).json({ error: 'Chat service is not configured' });
	}

	const systemPrompt = [
		'You are the helpful assistant for a local pharmacy in Bangladesh.',
		'You can help users with medicine catalog questions, wellness tips, and pharmacy services.',
		'You must not diagnose conditions, prescribe medicine, or recommend a dosage.',
		'For medical emergencies, advise the user to contact local emergency services or a qualified doctor.',
		'Keep responses clear and concise. Do not claim to have completed an action unless the application confirms it.',
	].join(' ');

	try {
		const response = await fetch(
			process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
					messages: [
						{ role: 'system', content: systemPrompt },
						{ role: 'user', content: prompt.trim() },
					],
					temperature: 0.2,
				}),
			},
		);

		const payload = await response.json();
		if (!response.ok) {
			console.error('AI provider error:', payload);
			return res.status(502).json({ error: 'AI service request failed' });
		}

		const message = payload.choices?.[0]?.message?.content;
		if (typeof message !== 'string') {
			return res.status(502).json({ error: 'AI service returned an invalid response' });
		}

		res.json({ response: message });
	} catch (error) {
		next(error);
	}
});

const escapeCsvCell = (value) => {
	const text = value == null ? '' : String(value);
	if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
	return text;
};

const sendCsv = (res, filename, headers, rows) => {
	const lines = [headers.join(',')];
	for (const row of rows) {
		lines.push(headers.map((header) => escapeCsvCell(row[header])).join(','));
	}
	res.setHeader('Content-Type', 'text/csv; charset=utf-8');
	res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
	res.send(lines.join('\n'));
};

app.get('/api/admin/export/stock.csv', requireAdmin, requireStockSchema, async (_req, res, next) => {
	try {
		const rows = await prisma.$queryRaw(Prisma.sql`
			SELECT "brandName", "genericName", "manufacturer", "strength", "availableQty",
				"piece_price" AS "singlePiecePrice", "box_price" AS "fullBoxPrice"
			FROM "Medicine"
			ORDER BY "brandName" ASC, "strength" ASC
		`);
		sendCsv(res, 'apollo-stock.csv', [
			'brandName', 'genericName', 'manufacturer', 'strength', 'availableQty', 'singlePiecePrice', 'fullBoxPrice',
		], rows.map((row) => ({
			...row,
			singlePiecePrice: Number(row.singlePiecePrice ?? 0),
			fullBoxPrice: Number(row.fullBoxPrice ?? 0),
		})));
	} catch (error) {
		next(error);
	}
});

app.get('/api/admin/export/transactions.csv', requireAdmin, requireStockSchema, async (req, res, next) => {
	try {
		const from = parseExpiryDate(req.query.from) || (typeof req.query.from === 'string' && req.query.from ? new Date(req.query.from) : null);
		const to = parseExpiryDate(req.query.to) || (typeof req.query.to === 'string' && req.query.to ? new Date(req.query.to) : null);
		const fromDate = from && !Number.isNaN(from.getTime()) ? from : null;
		let toDate = to && !Number.isNaN(to.getTime()) ? to : null;
		if (toDate && typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to.trim())) {
			toDate = new Date(toDate);
			toDate.setUTCHours(23, 59, 59, 999);
		}
		const conditions = [];
		if (fromDate) conditions.push(Prisma.sql`t."createdAt" >= ${fromDate}`);
		if (toDate) conditions.push(Prisma.sql`t."createdAt" <= ${toDate}`);
		const whereSql = conditions.length > 0
			? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
			: Prisma.empty;
		const rows = await prisma.$queryRaw(Prisma.sql`
			SELECT t."createdAt", m."brandName", m."strength", t."transactionType", t."quantity",
				t."previousStock", t."newStock", t."batchNumber", t."expiryDate", t."reason", t."createdBy"
			FROM "StockTransaction" t
			LEFT JOIN "Medicine" m ON m."id" = t."medicineId"
			${whereSql}
			ORDER BY t."createdAt" DESC
			LIMIT 5000
		`);
		sendCsv(res, 'apollo-transactions.csv', [
			'createdAt', 'brandName', 'strength', 'transactionType', 'quantity',
			'previousStock', 'newStock', 'batchNumber', 'expiryDate', 'reason', 'createdBy',
		], rows.map((row) => ({
			...row,
			createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : '',
		})));
	} catch (error) {
		next(error);
	}
});

app.use((error, _req, res, _next) => {
	console.error(error);
	const message = typeof error?.message === 'string' && error.message.trim()
		? error.message.trim()
		: 'Internal server error';
	const expose = process.env.NODE_ENV !== 'production' || Boolean(error?.expose);
	res.status(Number.isInteger(error?.statusCode) ? error.statusCode : 500).json({
		error: expose ? message : 'Internal server error',
	});
});

if (require.main === module) {
	const port = process.env.PORT || 5000;
	app.listen(port, () => console.log(`Apollo Pharmacy API listening on port ${port}`));
}

module.exports = app;
