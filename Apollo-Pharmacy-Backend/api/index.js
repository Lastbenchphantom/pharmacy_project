require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
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
	} catch {
		return res.status(401).json({ error: 'Invalid admin session' });
	}

	next();
};

const mailTransport = process.env.SMTP_HOST
	? nodemailer.createTransport({
		host: process.env.SMTP_HOST,
		port: Number(process.env.SMTP_PORT || 587),
		secure: process.env.SMTP_SECURE === 'true',
		auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
	})
	: null;

const sendAppointmentStatusEmail = async (appointment) => {
	if (!mailTransport || !process.env.MAIL_FROM) return false;
	await mailTransport.sendMail({
		from: process.env.MAIL_FROM,
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
		const appointment = hasEmail && hasNote
			? (await prisma.$queryRaw(Prisma.sql`
				INSERT INTO "Appointment" ("id", "patientName", "email", "phoneNumber", "doctorName", "timeSlot", "note", "status", "createdAt", "updatedAt")
				VALUES (${appointmentId}, ${patientName.trim()}, ${email.trim().toLowerCase()}, ${phoneNumber.trim()}, ${doctorName.trim()}, ${timeSlot.trim()}, ${typeof note === 'string' && note.trim() ? note.trim() : null}, 'PENDING', NOW(), NOW()) RETURNING *
			`))[0]
			: (await prisma.$queryRaw(Prisma.sql`
				INSERT INTO "Appointment" ("id", "patientName", "phoneNumber", "doctorName", "timeSlot", "status", "createdAt", "updatedAt")
				VALUES (${appointmentId}, ${patientName.trim()}, ${phoneNumber.trim()}, ${doctorName.trim()}, ${timeSlot.trim()}, 'PENDING', NOW(), NOW()) RETURNING *
			`))[0];

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
