'use strict';

/**
 * Model backed tests for the whole receipt pipeline.
 *
 * These load the real ONNX models, so they are slower than the unit tests and
 * are kept to the cases that have actually broken before: upside down
 * photographs, receipts that print batch and expiry, low contrast paper, and
 * images with no receipt on them at all. The rule they all enforce is the same:
 * read what is printed, flag what is missing, and never invent a value.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sharp = require('sharp');

const {
	buildStandardReceipt,
	buildBatchReceipt,
} = require('../ocr/fixtures');
const { recognizeImage } = require('../ocr/paddleOcr');
const { buildReceiptTable } = require('../ocr/receiptTable');
const { extractFromTable } = require('../ocr/receiptExtract');
const { buildStructuredOutput } = require('../ocr/structuredOutput');

const TIMEOUT = 180000;

/** Runs the same path the upload route uses and returns the structured result. */
const readReceipt = async (imageBuffer) => {
	const ocr = await recognizeImage(imageBuffer);
	const table = buildReceiptTable(ocr);
	return buildStructuredOutput(extractFromTable(ocr, table));
};

test('reads a clean pharmacy receipt end to end', { timeout: TIMEOUT }, async () => {
	const result = await readReceipt(await buildStandardReceipt({ scale: 2.2 }));

	assert.equal(result.header.supplier_name, 'APOLLO PHARMACY');
	assert.equal(result.header.invoice_number, '2026-0912');
	assert.equal(result.header.purchase_date, '2026-03-12');
	assert.equal(result.header.subtotal, 341.25);
	assert.equal(result.header.discount, 5);
	assert.equal(result.header.tax, 30.71);
	assert.equal(result.header.total, 366.96);
	assert.equal(result.items.length, 4);

	const [first] = result.items;
	assert.equal(first.product_name, 'Napa Extra 500mg');
	assert.equal(first.strength, '500mg');
	assert.equal(first.article_code, 'A-1001');
	assert.equal(first.quantity, 2);
	assert.equal(first.unit_price, 62.5);
	assert.equal(first.total_price, 136.25);

	// Printed subtotal is net, so it is checked against quantity x unit price.
	assert.equal(result.summary.line_totals_match_subtotal, true);
});

test('reads a receipt photographed upside down the same way up', { timeout: TIMEOUT }, async () => {
	const upright = await readReceipt(await buildStandardReceipt({ scale: 2.2 }));
	const flipped = await readReceipt(await sharp(await buildStandardReceipt({ scale: 2.2 }))
		.rotate(180)
		.toBuffer());

	assert.equal(flipped.header.invoice_number, upright.header.invoice_number);
	assert.equal(flipped.header.purchase_date, upright.header.purchase_date);
	assert.equal(flipped.header.total, upright.header.total);
	assert.equal(flipped.items.length, upright.items.length);

	flipped.items.forEach((item, index) => {
		assert.equal(item.article_code, upright.items[index].article_code);
		assert.equal(item.quantity, upright.items[index].quantity);
		assert.equal(item.total_price, upright.items[index].total_price);
	});
});

test('reads the batch and expiry columns a wholesaler prints', { timeout: TIMEOUT }, async () => {
	const result = await readReceipt(await buildBatchReceipt({ scale: 2.2 }));

	assert.equal(result.header.invoice_number, '2026-0913');
	assert.equal(result.items.length, 2);

	const [first, second] = result.items;
	assert.equal(first.batch_number, 'BT-77');
	assert.equal(first.expiry_date, '2027-12-31');
	assert.equal(second.batch_number, 'BT-12');
	assert.equal(second.expiry_date, '2028-06-30');

	// Expiry and batch are both present, so nothing should be held for review.
	assert.equal(first.needs_review, false);
	assert.equal(second.needs_review, false);
});

test('flags a receipt that prints no expiry instead of inventing one', { timeout: TIMEOUT }, async () => {
	const result = await readReceipt(await buildStandardReceipt({ scale: 2.2 }));

	assert.equal(result.items.length, 4);
	for (const item of result.items) {
		assert.equal(item.expiry_date, null);
		assert.equal(item.needs_review, true);
		assert.ok(
			item.review_reasons.some((reason) => /expiry/i.test(reason)),
			`expected an expiry reason, got ${JSON.stringify(item.review_reasons)}`,
		);
	}
	assert.ok(result.needs_review);
});

test('reads a faded receipt without turning the ink into numbers', { timeout: TIMEOUT }, async () => {
	const result = await readReceipt(await buildStandardReceipt({
		scale: 2.2,
		contrast: 0.32,
		noise: 6,
	}));

	// Whatever survives, nothing may be silently upgraded to a usable value.
	for (const item of result.items) {
		if (item.quantity != null) assert.ok(item.quantity > 0);
		if (item.total_price != null) assert.ok(item.total_price >= 0);
		if (item.needs_review) assert.ok(item.review_reasons.length > 0);
	}
	assert.equal(result.items.every((item) => item.product_name == null), false);
});

test('an image with no receipt produces no items and asks for review', { timeout: TIMEOUT }, async () => {
	const blank = await sharp({
		create: {
			width: 900,
			height: 700,
			channels: 3,
			background: { r: 250, g: 250, b: 248 },
		},
	}).png().toBuffer();

	const result = await readReceipt(blank);

	assert.equal(result.items.length, 0);
	assert.equal(result.needs_review, true);
	assert.ok(result.review_reasons.length > 0);
});

test('every recognised line keeps its geometry and confidence', { timeout: TIMEOUT }, async () => {
	const ocr = await recognizeImage(await buildStandardReceipt({ scale: 2.2 }));

	assert.ok(ocr.lines.length > 10);
	for (const line of ocr.lines) {
		assert.ok(line.text.length > 0);
		assert.ok(line.confidence >= 0 && line.confidence <= 1);
		assert.ok(line.box.x1 > line.box.x0);
		assert.ok(line.box.y1 > line.box.y0);
		assert.equal(line.points.length, 4);
		assert.ok(line.angle === 0 || line.angle === 180);
	}
});
