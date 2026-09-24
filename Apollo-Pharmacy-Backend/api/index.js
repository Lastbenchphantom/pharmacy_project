require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { Prisma, PrismaClient } = require('@prisma/client');

const app = express();
const DEFAULT_MEDICINE_API_URL = 'https://huggingface.co/datasets/Mahadih534/all-Bangladeshi-medicines/raw/main/medicine.csv';
const serializeDatabaseValue = (value) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? Number(item) : item));

// Reuse one Prisma client during local reloads and warm serverless invocations.
const prisma = globalThis.__pharmacyPrisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') {
	globalThis.__pharmacyPrisma = prisma;
}

const allowedOrigins = process.env.FRONTEND_URL
	? process.env.FRONTEND_URL.split(',').map((origin) => origin.trim())
	: 'http://localhost:5173';

app.use(cors({ origin: allowedOrigins }));
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

const getAdminSecret = () => process.env.ADMIN_LOGIN_PASSWORD || process.env.ADMIN_API_KEY;

const createAdminToken = () => {
	const payload = Buffer.from(JSON.stringify({
		sub: 'admin',
		exp: Date.now() + (8 * 60 * 60 * 1000),
	})).toString('base64url');
	const signature = crypto.createHmac('sha256', getAdminSecret()).update(payload).digest('base64url');
	return `${payload}.${signature}`;
};

const requireAdmin = (req, res, next) => {
	const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
	const [payload, signature] = token?.split('.') || [];
	const secret = getAdminSecret();

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

const sendAppointmentStatusEmail = async (appointment) => {
	if (!mailTransport) return false;
	await mailTransport.sendMail({
		from: mailFrom,
		to: appointment.email,
		subject: `Apollo Pharmacy appointment ${appointment.status.toLowerCase()}`,
		text: [
			`Hello ${appointment.patientName},`,
			'',
			`Your Apollo Pharmacy consultation request with ${appointment.doctorName} for ${appointment.timeSlot} has been ${appointment.status.toLowerCase()}.`,
			'',
			'Please contact the pharmacy if you need to make a change.',
		].join('\n'),
	});
	return true;
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

const receiptJsonSchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		items: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					medicine_name: { type: 'string' },
					brand_name: { type: ['string', 'null'] },
					generic_name: { type: ['string', 'null'] },
					strength: { type: ['string', 'null'] },
					dosage_form: { type: ['string', 'null'] },
					pack_size: { type: ['string', 'null'] },
					quantity: { type: ['integer', 'null'] },
					unit_price: { type: ['number', 'null'] },
					total_price: { type: ['number', 'null'] },
					batch_number: { type: ['string', 'null'] },
					expiry_date: { type: ['string', 'null'] },
					confidence: { type: 'number' },
				},
				required: ['medicine_name', 'brand_name', 'generic_name', 'strength', 'dosage_form', 'pack_size', 'quantity', 'unit_price', 'total_price', 'batch_number', 'expiry_date', 'confidence'],
			},
		},
	},
	required: ['items'],
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

const extractReceiptItems = async (file) => {
	if (!process.env.OPENAI_API_KEY) throw new Error('Receipt AI processing is not configured');
	const encodedFile = file.buffer.toString('base64');
	const instruction = 'Read this pharmacy purchase receipt. Return only JSON matching the requested schema. Extract every medicine line, ignore non-medicine products, never guess unreadable quantities, use null for missing values, and set confidence from 0 to 1 based on legibility. Quantity means the number of packs or units purchased as printed.';
	const isPdf = file.mimetype === 'application/pdf';
	const configuredUrl = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
	const url = isPdf && configuredUrl.endsWith('/chat/completions') ? configuredUrl.replace('/chat/completions', '/responses') : configuredUrl;
	const body = isPdf
		? {
			model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
			input: [{ role: 'user', content: [{ type: 'input_text', text: instruction }, { type: 'input_file', filename: file.originalname, file_data: `data:${file.mimetype};base64,${encodedFile}` }] }],
			text: { format: { type: 'json_schema', name: 'receipt_extraction', strict: true, schema: receiptJsonSchema } },
		}
		: {
			model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
			messages: [{ role: 'user', content: [{ type: 'text', text: instruction }, { type: 'image_url', image_url: { url: `data:${file.mimetype};base64,${encodedFile}`, detail: 'high' } }] }],
			response_format: { type: 'json_schema', json_schema: { name: 'receipt_extraction', strict: true, schema: receiptJsonSchema } },
		};
	const response = await fetch(url, {
		method: 'POST',
		headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error('Receipt AI processing failed');
	const content = isPdf
		? payload.output_text
		: payload.choices?.[0]?.message?.content;
	const parsed = typeof content === 'string' ? JSON.parse(content) : null;
	if (!parsed || !Array.isArray(parsed.items)) throw new Error('Receipt AI returned invalid data');
	return parsed.items;
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
	res.json({ ok: true });
});

app.post('/api/admin/login', (req, res) => {
	const password = typeof req.body?.password === 'string' ? req.body.password : '';
	const secret = getAdminSecret();

	if (!secret || password.length === 0 || password !== secret) {
		return res.status(401).json({ error: 'Invalid admin credentials' });
	}

	res.json({ token: createAdminToken(), expiresIn: 8 * 60 * 60 });
});

app.get('/api/medicines', async (req, res, next) => {
	try {
		const requestedLimit = Number.parseInt(req.query.limit, 10);
		const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : null;
		const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
		let medicines;
		if (limit && req.query.random === 'true' && !search) {
			medicines = await prisma.$queryRaw(Prisma.sql`
				SELECT * FROM "Medicine" ORDER BY RANDOM() LIMIT ${limit}
			`);
		} else if (search && limit) {
			medicines = await prisma.$queryRaw(Prisma.sql`
				SELECT * FROM "Medicine"
				WHERE "brandName" ILIKE ${`${search}%`}
				ORDER BY "brandName" ASC, "genericName" ASC
				LIMIT ${limit}
			`);
		} else if (search) {
			medicines = await prisma.$queryRaw(Prisma.sql`
				SELECT * FROM "Medicine"
				WHERE "brandName" ILIKE ${`${search}%`}
				ORDER BY "brandName" ASC, "genericName" ASC
			`);
		} else {
			medicines = await prisma.$queryRaw(Prisma.sql`
				SELECT * FROM "Medicine"
				ORDER BY "brandName" ASC, "genericName" ASC
			`);
		}
		medicines = medicines.map((medicine) => ({
			...medicine,
			singlePiecePrice: Number(medicine.piece_price ?? medicine.singlePiecePrice ?? 0),
			fullBoxPrice: Number(medicine.box_price ?? medicine.fullBoxPrice ?? 0),
		}));

		res.json(serializeDatabaseValue(medicines));
	} catch (error) {
		next(error);
	}
});

app.post('/api/stock/receipt/upload', requireAdmin, receiveReceipt, async (req, res, next) => {
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

app.post('/api/stock/receipt/process', requireAdmin, async (req, res, next) => {
	const receiptId = typeof req.body?.receiptId === 'string' ? req.body.receiptId : '';
	if (!receiptId) return res.status(400).json({ error: 'receiptId is required' });
	try {
		const receipts = await prisma.$queryRaw(Prisma.sql`SELECT "id", "fileName", "mimeType", "fileData", "status" FROM "StockReceipt" WHERE "id" = ${receiptId}`);
		if (receipts.length === 0) return res.status(404).json({ error: 'Receipt not found' });
		const receipt = receipts[0];
		if (receipt.status === 'CONFIRMED') return res.status(409).json({ error: 'This receipt has already been confirmed' });
		const extractedItems = await extractReceiptItems({ buffer: Buffer.from(receipt.fileData), mimetype: receipt.mimeType, originalname: receipt.fileName });
		const medicines = await prisma.$queryRaw(Prisma.sql`SELECT "id", "brandName", "genericName", "strength", "availableQty" FROM "Medicine"`);
		await prisma.$transaction(async (tx) => {
			await tx.$executeRaw(Prisma.sql`DELETE FROM "StockReceiptItem" WHERE "receiptId" = ${receiptId}`);
			for (const extractedItem of extractedItems) {
				const match = matchReceiptMedicine(extractedItem, medicines);
				const quantity = Number.isInteger(extractedItem.quantity) && extractedItem.quantity >= 0 ? extractedItem.quantity : null;
				const confidence = Number.isFinite(Number(extractedItem.confidence)) ? Math.min(Math.max(Number(extractedItem.confidence), 0), 1) : 0;
				await tx.$executeRaw(Prisma.sql`
					INSERT INTO "StockReceiptItem" ("id", "receiptId", "medicineName", "brandName", "genericName", "strength", "dosageForm", "packSize", "quantity", "unitPrice", "totalPrice", "batchNumber", "expiryDate", "confidence", "matchStatus", "matchedMedicineId")
					VALUES (${crypto.randomUUID()}, ${receiptId}, ${String(extractedItem.medicine_name || 'Unidentified item').trim()}, ${extractedItem.brand_name || null}, ${extractedItem.generic_name || null}, ${extractedItem.strength || null}, ${extractedItem.dosage_form || null}, ${extractedItem.pack_size || null}, ${quantity}, ${Number.isFinite(Number(extractedItem.unit_price)) ? Number(extractedItem.unit_price) : null}, ${Number.isFinite(Number(extractedItem.total_price)) ? Number(extractedItem.total_price) : null}, ${extractedItem.batch_number || null}, ${extractedItem.expiry_date || null}, ${confidence}, ${match.matchStatus}, ${match.matchedMedicineId})
				`);
			}
			await tx.$executeRaw(Prisma.sql`UPDATE "StockReceipt" SET "status" = 'READY_FOR_REVIEW', "processedAt" = NOW(), "errorMessage" = NULL WHERE "id" = ${receiptId}`);
		});
		res.json(await getReceiptDetails(receiptId));
	} catch (error) {
		try {
			await prisma.$executeRaw(Prisma.sql`UPDATE "StockReceipt" SET "status" = 'FAILED', "errorMessage" = ${error.message || 'Receipt processing failed'} WHERE "id" = ${receiptId}`);
		} catch (updateError) {
			console.error('Could not mark receipt processing failure:', updateError);
		}
		next(error);
	}
});

app.get('/api/stock/receipt/:id', requireAdmin, async (req, res, next) => {
	try {
		const receipt = await getReceiptDetails(req.params.id);
		if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
		res.json(receipt);
	} catch (error) {
		next(error);
	}
});

app.post('/api/stock/receipt/confirm', requireAdmin, async (req, res, next) => {
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
			const updated = [];
			for (const reviewItem of reviewItems) {
				const receiptItem = receiptItemMap.get(reviewItem.id);
				if (!receiptItem) throw new Error('Receipt item does not belong to this receipt');
				const medicines = await tx.$queryRaw(Prisma.sql`SELECT "id", "availableQty" FROM "Medicine" WHERE "id" = ${reviewItem.medicineId} FOR UPDATE`);
				if (medicines.length === 0) throw new Error('One selected medicine no longer exists');
				const previousStock = Number(medicines[0].availableQty);
				const newStock = previousStock + reviewItem.quantity;
				if (newStock > 2147483647) throw new Error('Stock quantity is too large');
				await tx.$executeRaw(Prisma.sql`UPDATE "Medicine" SET "availableQty" = ${newStock}, "updatedAt" = NOW() WHERE "id" = ${reviewItem.medicineId}`);
				await tx.$executeRaw(Prisma.sql`UPDATE "StockReceiptItem" SET "medicineName" = ${typeof reviewItem.medicineName === 'string' && reviewItem.medicineName.trim() ? reviewItem.medicineName.trim() : receiptItem.medicineName}, "quantity" = ${reviewItem.quantity}, "matchedMedicineId" = ${reviewItem.medicineId}, "matchStatus" = 'MATCHED' WHERE "id" = ${reviewItem.id}`);
				await tx.$executeRaw(Prisma.sql`INSERT INTO "StockTransaction" ("id", "receiptId", "medicineId", "transactionType", "quantity", "previousStock", "newStock", "batchNumber", "expiryDate", "createdBy") VALUES (${crypto.randomUUID()}, ${receiptId}, ${reviewItem.medicineId}, 'PURCHASE_RECEIPT', ${reviewItem.quantity}, ${previousStock}, ${newStock}, ${receiptItem.batchNumber}, ${receiptItem.expiryDate}, ${req.adminId || 'admin'})`);
				updated.push({ medicineId: reviewItem.medicineId, previousStock, quantityAdded: reviewItem.quantity, newStock });
			}
			const skipped = receiptItems.filter((item) => !itemIds.has(item.id)).map((item) => ({ id: item.id, medicineName: item.medicineName, reason: item.quantity === null ? 'Quantity is missing' : 'Not matched or skipped' }));
			await tx.$executeRaw(Prisma.sql`UPDATE "StockReceipt" SET "status" = 'CONFIRMED', "confirmedBy" = ${req.adminId || 'admin'}, "confirmedAt" = NOW(), "fileData" = ${Buffer.alloc(0)} WHERE "id" = ${receiptId}`);
			return { type: 'confirmed', updated, skipped };
		});
		if (result.type === 'missing') return res.status(404).json({ error: 'Receipt not found' });
		if (result.type === 'not-ready') return res.status(409).json({ error: 'Receipt is not ready for confirmation' });
		if (result.type === 'already-confirmed') return res.json({ status: 'CONFIRMED', alreadyConfirmed: true, updated: result.transactions.map((item) => ({ medicineId: item.medicineId, previousStock: Number(item.previousStock), quantityAdded: Number(item.quantity), newStock: Number(item.newStock) })), skipped: [] });
		res.json({ status: 'CONFIRMED', ...result });
	} catch (error) {
		if (error.message === 'One selected medicine no longer exists' || error.message === 'Receipt item does not belong to this receipt' || error.message === 'Stock quantity is too large') return res.status(400).json({ error: error.message });
		next(error);
	}
});

app.patch('/api/admin/update-stock', requireAdmin, async (req, res, next) => {
	const { medicineId, availableQty, singlePiecePrice, fullBoxPrice } = req.body || {};
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
		const priceColumns = await prisma.$queryRaw(Prisma.sql`
			SELECT "column_name" FROM information_schema.columns
			WHERE "table_schema" = 'public' AND "table_name" = 'Medicine'
			AND "column_name" IN ('piece_price', 'box_price')
		`);
		const pricesSaved = priceColumns.length === 2;
		const medicines = pricesSaved
			? await prisma.$queryRaw(Prisma.sql`
				UPDATE "Medicine"
				SET "availableQty" = ${parsedQty}, "piece_price" = ${parsedPiecePrice}, "box_price" = ${parsedBoxPrice}, "updatedAt" = NOW()
				WHERE "id" = ${String(medicineId)} RETURNING *
			`)
			: await prisma.$queryRaw(Prisma.sql`
				UPDATE "Medicine"
				SET "availableQty" = ${parsedQty}, "updatedAt" = NOW()
				WHERE "id" = ${String(medicineId)} RETURNING *
			`);
		if (medicines.length === 0) return res.status(404).json({ error: 'Medicine not found' });
		const medicine = medicines[0];

		res.json(serializeDatabaseValue({
			...medicine,
			singlePiecePrice: Number(medicine.piece_price ?? medicine.singlePiecePrice ?? 0),
			fullBoxPrice: Number(medicine.box_price ?? medicine.fullBoxPrice ?? 0),
			pricesSaved,
		}));
	} catch (error) {
		if (error.code === 'P2025') {
			return res.status(404).json({ error: 'Medicine not found' });
		}
		next(error);
	}
});

app.get('/api/admin/appointments', requireAdmin, async (_req, res, next) => {
	try {
		const appointmentColumns = await prisma.$queryRaw(Prisma.sql`
			SELECT "column_name" FROM information_schema.columns
			WHERE "table_schema" = 'public' AND "table_name" = 'Appointment'
			AND "column_name" = 'email'
		`);
		const appointments = appointmentColumns.length > 0
			? await prisma.$queryRaw(Prisma.sql`
				SELECT "id", "patientName", "email", "phoneNumber", "doctorName", "timeSlot", "status", "createdAt", "updatedAt"
				FROM "Appointment" ORDER BY "createdAt" DESC LIMIT 50
			`)
			: await prisma.$queryRaw(Prisma.sql`
				SELECT "id", "patientName", "phoneNumber", "doctorName", "timeSlot", "status", "createdAt", "updatedAt"
				FROM "Appointment" ORDER BY "createdAt" DESC LIMIT 50
			`);
		res.json(serializeDatabaseValue(appointments));
	} catch (error) {
		next(error);
	}
});

app.patch('/api/admin/appointments/:id', requireAdmin, async (req, res, next) => {
	const status = typeof req.body?.status === 'string' ? req.body.status.toUpperCase() : '';
	if (!['ACCEPTED', 'REJECTED', 'PENDING'].includes(status)) {
		return res.status(400).json({ error: 'status must be ACCEPTED, REJECTED, or PENDING' });
	}

	try {
		const appointments = await prisma.$queryRaw(Prisma.sql`
			UPDATE "Appointment" SET "status" = ${status}, "updatedAt" = NOW()
			WHERE "id" = ${String(req.params.id)} RETURNING *
		`);
		if (appointments.length === 0) return res.status(404).json({ error: 'Appointment not found' });
		const appointment = appointments[0];
		let notificationSent = false;
		let notificationReason = 'missing-email';
		try {
			if (typeof appointment.email === 'string' && appointment.email.length > 0) {
				notificationSent = await sendAppointmentStatusEmail(appointment);
				notificationReason = notificationSent ? 'sent' : 'smtp-not-configured';
			} else if (!mailTransport || !process.env.MAIL_FROM) {
				notificationReason = 'smtp-not-configured';
			}
		} catch (emailError) {
			console.error('Appointment email failed:', emailError);
			notificationReason = 'delivery-failed';
		}
		res.json(serializeDatabaseValue({ ...appointment, notificationSent, notificationReason }));
	} catch (error) {
		if (error.code === 'P2025') {
			return res.status(404).json({ error: 'Appointment not found' });
		}
		next(error);
	}
});

app.post('/api/admin/medicines/sync', requireAdmin, async (_req, res, next) => {
	const apiUrl = process.env.MEDICINE_API_URL || DEFAULT_MEDICINE_API_URL;

	try {
		const response = await fetch(apiUrl, { headers: { Accept: 'application/json' } });
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
		for (let index = 0; index < records.length; index += 25) {
			const batch = records.slice(index, index + 25);
			const results = await Promise.all(batch.map(async (item) => {
				const brandName = String(item.brandName || item.brand || item.name || '').trim();
				if (!brandName) return 'skipped';
				try {
					const existing = await prisma.$queryRaw(Prisma.sql`SELECT "id" FROM "Medicine" WHERE "brandName" = ${brandName} LIMIT 1`);
					if (existing.length > 0) return 'skipped';
					await prisma.$executeRaw(Prisma.sql`
						INSERT INTO "Medicine" ("id", "brandName", "genericName", "manufacturer", "strength", "availableQty", "createdAt", "updatedAt")
						VALUES (${crypto.randomUUID()}, ${brandName}, ${String(item.genericName || item.generic || 'Generic Formula').trim()}, ${String(item.manufacturer || item.company || 'Bangladeshi Pharma').trim()}, ${String(item.strength || item.dosage || 'Standard').trim()}, 0, NOW(), NOW())
					`);
					return 'imported';
				} catch (rowError) {
					console.error(`Skipping medicine import for ${brandName}:`, rowError.message);
					return 'skipped';
				}
			}));
			imported += results.filter((result) => result === 'imported').length;
			skipped += results.length - results.filter((result) => result === 'imported').length;
		}
		res.json({ imported, skipped, total: records.length });
	} catch (error) {
		next(error);
	}
});

app.post('/api/appointments', async (req, res, next) => {
	const { patientName, email, phoneNumber, doctorName, timeSlot, note } = req.body || {};

	if (![patientName, email, phoneNumber, doctorName, timeSlot].every(
		(value) => typeof value === 'string' && value.trim().length > 0,
	)) {
		return res.status(400).json({
			error: 'patientName, email, phoneNumber, doctorName, and timeSlot are required',
		});
	}
	if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
		return res.status(400).json({ error: 'A valid email address is required' });
	}

	try {
		const columns = await prisma.$queryRaw(Prisma.sql`
			SELECT "column_name" FROM information_schema.columns
			WHERE "table_schema" = 'public' AND "table_name" = 'Appointment'
			AND "column_name" IN ('email', 'note')
		`);
		const hasEmail = columns.some((column) => column.column_name === 'email');
		const hasNote = columns.some((column) => column.column_name === 'note');
		const appointmentId = crypto.randomUUID();
		let appointment;
		if (hasEmail && hasNote) {
			appointment = (await prisma.$queryRaw(Prisma.sql`
				INSERT INTO "Appointment" ("id", "patientName", "email", "phoneNumber", "doctorName", "timeSlot", "note", "status", "createdAt", "updatedAt")
				VALUES (${appointmentId}, ${patientName.trim()}, ${email.trim().toLowerCase()}, ${phoneNumber.trim()}, ${doctorName.trim()}, ${timeSlot.trim()}, ${typeof note === 'string' && note.trim() ? note.trim() : null}, 'PENDING', NOW(), NOW()) RETURNING *
			`))[0];
		} else if (hasEmail) {
			appointment = (await prisma.$queryRaw(Prisma.sql`
				INSERT INTO "Appointment" ("id", "patientName", "email", "phoneNumber", "doctorName", "timeSlot", "status", "createdAt", "updatedAt")
				VALUES (${appointmentId}, ${patientName.trim()}, ${email.trim().toLowerCase()}, ${phoneNumber.trim()}, ${doctorName.trim()}, ${timeSlot.trim()}, 'PENDING', NOW(), NOW()) RETURNING *
			`))[0];
		} else if (hasNote) {
			appointment = (await prisma.$queryRaw(Prisma.sql`
				INSERT INTO "Appointment" ("id", "patientName", "phoneNumber", "doctorName", "timeSlot", "note", "status", "createdAt", "updatedAt")
				VALUES (${appointmentId}, ${patientName.trim()}, ${phoneNumber.trim()}, ${doctorName.trim()}, ${timeSlot.trim()}, ${typeof note === 'string' && note.trim() ? note.trim() : null}, 'PENDING', NOW(), NOW()) RETURNING *
			`))[0];
		} else {
			appointment = (await prisma.$queryRaw(Prisma.sql`
				INSERT INTO "Appointment" ("id", "patientName", "phoneNumber", "doctorName", "timeSlot", "status", "createdAt", "updatedAt")
				VALUES (${appointmentId}, ${patientName.trim()}, ${phoneNumber.trim()}, ${doctorName.trim()}, ${timeSlot.trim()}, 'PENDING', NOW(), NOW()) RETURNING *
			`))[0];
		}

		res.status(201).json(serializeDatabaseValue(appointment));
	} catch (error) {
		next(error);
	}
});

app.post('/api/chat', async (req, res, next) => {
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
		'You can help users check medicine stock and book a doctor appointment.',
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

app.use((error, _req, res, _next) => {
	console.error(error);
	res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
	const port = process.env.PORT || 5000;
	app.listen(port, () => console.log(`Apollo Pharmacy API listening on port ${port}`));
}

module.exports = app;
