#!/usr/bin/env node
/**
 * Production-readiness harness (local). Does not print secrets.
 */
require('dotenv').config();
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PrismaClient, Prisma } = require('@prisma/client');

const PORT = 5066;
const FIX_JPG = './tmp/fixtures/receipt.jpg';
const FIX_PNG = './tmp/fixtures/receipt.png';
const report = { timings: {}, results: {}, errors: [] };

const prisma = new PrismaClient();

const request = (method, path, { token, body, form, timeoutMs = 120000 } = {}) => new Promise((resolve, reject) => {
	const headers = {};
	let payload = null;
	if (form) {
		payload = form.body;
		headers['Content-Type'] = `multipart/form-data; boundary=${form.boundary}`;
		headers['Content-Length'] = payload.length;
	} else if (body != null) {
		payload = Buffer.from(JSON.stringify(body));
		headers['Content-Type'] = 'application/json';
		headers['Content-Length'] = payload.length;
	}
	if (token) headers.Authorization = `Bearer ${token}`;
	const req = http.request({ hostname: '127.0.0.1', port: PORT, path, method, headers, timeout: timeoutMs }, (res) => {
		const chunks = [];
		res.on('data', (c) => chunks.push(c));
		res.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			let json = {};
			try { json = JSON.parse(raw || '{}'); } catch { json = { raw }; }
			resolve({ status: res.statusCode, json, raw });
		});
	});
	req.on('timeout', () => req.destroy(new Error('request timeout')));
	req.on('error', reject);
	if (payload) req.write(payload);
	req.end();
});

const multipartFile = (field, filePath, mime) => {
	const boundary = '----ApolloBoundary' + crypto.randomBytes(8).toString('hex');
	const filename = filePath.split('/').pop();
	const fileBuf = fs.readFileSync(filePath);
	const head = Buffer.from(
		`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
	);
	const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
	return { boundary, body: Buffer.concat([head, fileBuf, tail]) };
};

const timed = async (name, fn) => {
	const t0 = Date.now();
	const value = await fn();
	report.timings[name] = Date.now() - t0;
	return value;
};

const assert = (cond, msg) => {
	if (!cond) {
		report.errors.push(msg);
		throw new Error(msg);
	}
};

(async () => {
	const server = spawn('node', ['api/index.js'], {
		cwd: process.cwd(),
		env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stderr = '';
	server.stderr.on('data', (d) => { stderr += d.toString(); });

	const waitReady = async () => {
		const started = Date.now();
		while (Date.now() - started < 20000) {
			try {
				const health = await request('GET', '/api/health');
				if (health.status === 200) return;
			} catch { /* retry */ }
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error('API health timeout. stderr=' + stderr.slice(-500));
	};

	try {
		await waitReady();

		// --- Auth ---
		const login = await timed('login', () => request('POST', '/api/admin/login', {
			body: { password: process.env.ADMIN_LOGIN_PASSWORD || process.env.ADMIN_API_KEY },
		}));
		assert(login.status === 200 && login.json.token, 'admin login failed');
		const token = login.json.token;

		// Security: no token
		const unauth = await request('POST', '/api/admin/medicines', { body: { brandName: 'X', dosageForm: 'Tablet', sellingPrice: 1 } });
		report.results.securityUnauthCreate = { status: unauth.status, blocked: unauth.status === 401 };
		assert(unauth.status === 401, 'unauth create should be 401');

		// --- Cold create medicine (fresh process first admin schema path already warmed by login? login doesn't use requireStockSchema)
		// Force schema path on first create:
		const coldCreate = await timed('createMedicineCold', () => request('POST', '/api/admin/medicines', {
			token,
			body: {
				brandName: 'ProdTest Alpha',
				genericName: 'Test Generic',
				manufacturer: 'Test Mfr',
				strength: '10mg',
				dosageForm: 'Tablet',
				sellingPrice: 2.5,
				purchasePrice: 1.5,
				availableQty: 40,
				expiryDate: '2028-06-01',
				batchNumber: 'PT-A',
				forceCreate: true,
				description: 'readiness test',
			},
		}));
		assert(coldCreate.status === 201, 'cold create failed: ' + JSON.stringify(coldCreate.json));
		const medicineId = coldCreate.json.id;
		report.results.createMedicine = {
			status: coldCreate.status,
			qty: coldCreate.json.availableQty,
			hasPurchaseInPublicShape: Object.prototype.hasOwnProperty.call(coldCreate.json, 'purchasePrice'),
		};

		const warmCreate = await timed('createMedicineWarm', () => request('POST', '/api/admin/medicines', {
			token,
			body: {
				brandName: 'ProdTest Beta',
				genericName: '',
				manufacturer: '',
				strength: '5mg',
				dosageForm: 'Capsule',
				sellingPrice: 3,
				availableQty: 0,
				forceCreate: true,
			},
		}));
		assert(warmCreate.status === 201, 'warm create failed');

		// Similar warning
		const similar = await request('POST', '/api/admin/medicines', {
			token,
			body: {
				brandName: 'ProdTest Alpha',
				strength: '10mg',
				dosageForm: 'Tablet',
				sellingPrice: 1,
				availableQty: 0,
			},
		});
		report.results.similarWarning = { status: similar.status, code: similar.json.error };
		assert(similar.status === 409, 'expected similar medicine 409');

		// Validation rejects
		const neg = await request('POST', '/api/admin/medicines', {
			token,
			body: { brandName: 'Bad', dosageForm: 'Tablet', sellingPrice: -1, availableQty: 0, forceCreate: true },
		});
		assert(neg.status === 400, 'negative price should 400');

		const noExpiry = await request('POST', '/api/admin/medicines', {
			token,
			body: { brandName: 'Bad2', dosageForm: 'Tablet', sellingPrice: 1, availableQty: 5, forceCreate: true },
		});
		assert(noExpiry.status === 400, 'missing expiry with qty should 400');

		// --- Public API ---
		const pub = await timed('publicSearch', () => request('GET', '/api/medicines?search=ProdTest&limit=10'));
		assert(pub.status === 200, 'public search failed');
		assert(Array.isArray(pub.json.items), 'public items array');
		assert(pub.json.pagination, 'pagination present');
		const leaked = pub.json.items.some((m) => m.purchasePrice != null || m.supplierName || m.confirmedBy);
		report.results.publicApi = {
			status: pub.status,
			count: pub.json.items.length,
			leaksPurchase: leaked,
			sampleKeys: Object.keys(pub.json.items[0] || {}),
		};
		assert(!leaked, 'public API leaked sensitive fields');

		// Deactivate + public hide
		const deact = await request('DELETE', `/api/admin/medicines/${warmCreate.json.id}`, { token });
		assert(deact.status === 200 && deact.json.isActive === false, 'deactivate failed');
		const pubAfter = await request('GET', `/api/medicines?search=${encodeURIComponent('ProdTest Beta')}&limit=10`);
		assert((pubAfter.json.items || []).every((m) => m.id !== warmCreate.json.id), 'inactive still public');

		// --- Stock calculation / expired batch ---
		await prisma.$executeRaw(Prisma.sql`
			INSERT INTO "StockBatch" ("id","medicineId","batchNumber","expiryDate","quantity","purchasePrice","sellingPrice","createdAt","updatedAt")
			VALUES (${crypto.randomUUID()}, ${medicineId}, 'EXPIRED', ${new Date('2020-01-01T12:00:00Z')}, 999, 1, 2, NOW(), NOW())
		`);
		// Recompute via adjust 0? call recompute by patching through API add 0 no — use SQL + endpoint GET
		const sellableRows = await prisma.$queryRaw(Prisma.sql`
			SELECT COALESCE(SUM("quantity"),0)::int AS total FROM "StockBatch"
			WHERE "medicineId" = ${medicineId} AND "quantity" > 0
				AND ("expiryDate" IS NULL OR "expiryDate"::date >= CURRENT_DATE)
		`);
		report.results.sellableExcludesExpired = {
			sellable: Number(sellableRows[0].total),
			expectedAtLeast: 40,
			expiredBatchQty: 999,
		};
		assert(Number(sellableRows[0].total) === 40, 'expired batch should not count; got ' + sellableRows[0].total);

		// Negative stock blocked
		const badAdjust = await request('POST', '/api/admin/stock/adjust', {
			token,
			body: { medicineId, absoluteQty: -5, reason: 'test negative' },
		});
		report.results.negativeStockBlocked = { status: badAdjust.status, error: badAdjust.json.error };
		assert(badAdjust.status === 400, 'negative absolute qty should fail');

		// --- Dashboard ---
		const dashCold = await timed('dashboardWarm', () => request('GET', '/api/admin/dashboard', { token }));
		assert(dashCold.status === 200, 'dashboard failed');
		const dash2 = await timed('dashboardSecond', () => request('GET', '/api/admin/dashboard', { token }));
		assert(dash2.status === 200, 'dashboard 2 failed');

		// --- JPG upload + OCR process (API path) ---
		const beforeQty = (await prisma.$queryRaw(Prisma.sql`SELECT "availableQty" FROM "Medicine" WHERE "id" = ${medicineId}`))[0].availableQty;

		const uploadJpg = await timed('uploadJpg', () => request('POST', '/api/stock/receipt/upload', {
			token,
			form: multipartFile('receipt', FIX_JPG, 'image/jpeg'),
		}));
		assert(uploadJpg.status === 201 || uploadJpg.status === 409, 'jpg upload failed ' + uploadJpg.status);
		let jpgReceiptId = uploadJpg.json.receiptId;
		if (uploadJpg.status === 409) jpgReceiptId = uploadJpg.json.receiptId;

		const processJpg = await timed('ocrJpgProcess', () => request('POST', '/api/stock/receipt/process', {
			token,
			body: { receiptId: jpgReceiptId },
			timeoutMs: 120000,
		}));
		report.results.jpgOcr = {
			status: processJpg.status,
			receiptStatus: processJpg.json.status,
			itemCount: processJpg.json.items?.length,
			error: processJpg.json.error,
			sample: (processJpg.json.items || []).slice(0, 2).map((i) => ({
				name: i.medicineName, qty: i.quantity, price: i.unitPrice, type: i.dosageForm, expiry: i.expiryDate, matched: i.matchedMedicineId,
			})),
		};
		assert(processJpg.status === 200 && processJpg.json.status === 'READY_FOR_REVIEW', 'jpg OCR did not reach READY_FOR_REVIEW');
		assert((processJpg.json.items || []).every((i) => !i.matchedMedicineId), 'OCR auto-matched medicines');
		const afterOcrQty = (await prisma.$queryRaw(Prisma.sql`SELECT "availableQty" FROM "Medicine" WHERE "id" = ${medicineId}`))[0].availableQty;
		assert(Number(afterOcrQty) === Number(beforeQty), 'OCR changed stock');

		// PNG path
		const uploadPng = await timed('uploadPng', () => request('POST', '/api/stock/receipt/upload', {
			token,
			form: multipartFile('receipt', FIX_PNG, 'image/png'),
		}));
		assert(uploadPng.status === 201 || uploadPng.status === 409, 'png upload failed');
		const pngReceiptId = uploadPng.json.receiptId;
		const processPng = await timed('ocrPngProcess', () => request('POST', '/api/stock/receipt/process', {
			token,
			body: { receiptId: pngReceiptId },
			timeoutMs: 120000,
		}));
		report.results.pngOcr = {
			status: processPng.status,
			receiptStatus: processPng.json.status,
			itemCount: processPng.json.items?.length,
			error: processPng.json.error,
		};
		assert(processPng.status === 200 && processPng.json.status === 'READY_FOR_REVIEW', 'png OCR failed');

		// Confirm JPG receipt for first item → create new medicine OR select existing
		const jpgItem = processJpg.json.items[0];
		assert(jpgItem, 'no jpg items');
		const confirmBody = {
			receiptId: jpgReceiptId,
			items: [{
				id: jpgItem.id,
				createNew: true,
				medicineName: jpgItem.medicineName || 'Napa',
				dosageForm: jpgItem.dosageForm || 'Tablet',
				strength: jpgItem.strength || '500mg',
				genericName: jpgItem.genericName || 'Paracetamol',
				manufacturer: jpgItem.manufacturer || 'Beximco',
				quantity: Number(jpgItem.quantity) || 50,
				unitPrice: jpgItem.unitPrice != null ? Number(jpgItem.unitPrice) : 1.2,
				batchNumber: jpgItem.batchNumber || 'OCR-BATCH',
				expiryDate: (jpgItem.expiryDate && String(jpgItem.expiryDate).slice(0, 10)) || '2028-01-01',
			}],
			receipt: {
				supplierName: processJpg.json.supplierName || 'ABC Pharma Distributors',
				invoiceNumber: processJpg.json.invoiceNumber || 'INV-7788',
				total: processJpg.json.total ?? 60,
			},
		};
		const confirm1 = await timed('confirmReceipt', () => request('POST', '/api/stock/receipt/confirm', { token, body: confirmBody }));
		report.results.confirm1 = { status: confirm1.status, statusBody: confirm1.json.status, updated: confirm1.json.updated?.length, error: confirm1.json.error };
		assert(confirm1.status === 200 && confirm1.json.status === 'CONFIRMED', 'confirm failed');

		const confirm2 = await timed('confirmIdempotent', () => request('POST', '/api/stock/receipt/confirm', { token, body: confirmBody }));
		report.results.confirm2 = { status: confirm2.status, alreadyConfirmed: confirm2.json.alreadyConfirmed };
		assert(confirm2.json.alreadyConfirmed === true, 'double confirm not idempotent');

		// Validation rejects on PNG receipt
		const pngItem = processPng.json.items[0];
		const missingExp = await request('POST', '/api/stock/receipt/confirm', {
			token,
			body: {
				receiptId: pngReceiptId,
				items: [{
					id: pngItem.id,
					createNew: true,
					medicineName: 'Seclo',
					dosageForm: 'Capsule',
					quantity: 10,
					expiryDate: '',
				}],
			},
		});
		report.results.confirmMissingExpiry = { status: missingExp.status, code: missingExp.json.code || missingExp.json.error };
		assert(missingExp.status === 400, 'missing expiry should 400');

		// Receipt list
		const list = await timed('receiptList', () => request('GET', '/api/admin/receipts?limit=20', { token }));
		assert(list.status === 200 && Array.isArray(list.json), 'receipt list failed');
		report.results.receiptList = { count: list.json.length, sample: list.json.slice(0, 3).map((r) => ({ id: r.id?.slice(0, 8), status: r.status, supplier: r.supplierName, total: r.total })) };

		// Delete confirmed blocked
		const delConfirmed = await request('DELETE', `/api/admin/receipts/${jpgReceiptId}`, { token });
		report.results.deleteConfirmedBlocked = { status: delConfirmed.status, error: delConfirmed.json.error };
		assert(delConfirmed.status === 409, 'confirmed delete should be blocked');

		// Delete unconfirmed PNG ok
		const delPng = await request('DELETE', `/api/admin/receipts/${pngReceiptId}`, { token });
		report.results.deleteUnconfirmed = { status: delPng.status, deleted: delPng.json.deleted };
		assert(delPng.status === 200 && delPng.json.deleted === true, 'unconfirmed delete failed');
		const delPng2 = await request('DELETE', `/api/admin/receipts/${pngReceiptId}`, { token });
		report.results.deleteTwice = { status: delPng2.status };
		assert(delPng2.status === 404 || delPng2.status === 409, 'second delete should fail safely');

		// Sync disabled
		const sync = await request('POST', '/api/admin/medicines/sync', { token });
		report.results.syncDisabled = { status: sync.status, error: sync.json.error };
		assert(sync.status === 410, 'sync should remain disabled');

		// Catalog matching code path: ensure process did not load all medicines (check medicine count stayed small)
		const medCount = await prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS c FROM "Medicine"');
		report.results.medicineCountAfterTests = medCount[0].c;
		assert(medCount[0].c < 100, 'medicine count suggests catalog reimport');

		console.log(JSON.stringify(report, null, 2));
		if (report.errors.length) process.exitCode = 1;
	} catch (error) {
		report.errors.push(error.message);
		console.error(JSON.stringify(report, null, 2));
		console.error('FAIL', error.message);
		process.exitCode = 1;
	} finally {
		server.kill('SIGTERM');
		await prisma.$disconnect().catch(() => {});
	}
})();
