'use strict';

/**
 * Unit tests for the pure parts of the receipt pipeline.
 *
 * These run without loading any ONNX model, so they stay fast and can assert the
 * anti-hallucination and geometry rules directly. The model-backed pipeline is
 * covered separately in ocr-pipeline.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
	buildReceiptTable,
	groupIntoRows,
	isTotalLabel,
	normalizeLabel,
} = require('../ocr/receiptTable');
const {
	extractFromTable,
	parseMoney,
	parseQuantity,
	parseReceiptDate,
	dosageFormOf,
	learnCodePattern,
} = require('../ocr/receiptExtract');
const {
	buildStructuredOutput,
	validateItem,
	normalizeExpiry,
	moneyMatches,
	safeNumber,
} = require('../ocr/structuredOutput');

const cell = (text, x0, y0, x1, y1, confidence = 0.95) => ({
	text,
	confidence,
	box: { x0, y0, x1, y1 },
});

/** A synthetic ruled receipt: one header row, N body rows, 4 totals rows. */
const fakeOcr = ({
	headers = ['PRODUCT', 'CODE', 'QTY', 'PRICE', 'TOTAL'],
	rows = [['Napa Extra 500mg', 'A-1001', '2', '62.50', '136.25']],
	above = [['APOLLO PHARMACY'], ['PURCHASE RECEIPT INV-2026-0912 2026-03-12']],
	footers = [
		['SUB TOTAL', '125.00'],
		['DISCOUNT', '5.00'],
		['VAT', '11.25'],
		['GRAND TOTAL', '136.25'],
	],
	columns = 5,
	pitch = 200,
	startX = 50,
	startY = 50,
	rowGap = 40,
} = {}) => {
	const lines = [];
	const place = (values, rowIndex) => {
		values.forEach((value, index) => {
			if (value == null || value === '') return;
			const x0 = startX + index * pitch;
			lines.push(cell(String(value), x0, startY + rowIndex * rowGap, x0 + pitch * 0.8, startY + rowIndex * rowGap + 24));
		});
	};
	above.forEach((values, index) => place(values, index));
	place(headers, above.length);
	rows.forEach((values, index) => place(values, above.length + 1 + index));
	footers.forEach((values, index) => place(values, above.length + 1 + rows.length + index));
	return { width: 1200, height: 900, lines, columnCount: columns };
};

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

test('groupIntoRows puts cells on one printed line into one row', () => {
	const rows = groupIntoRows([
		cell('A', 10, 100, 80, 124),
		cell('B', 300, 104, 360, 126),
		cell('C', 10, 300, 80, 324),
	]);
	assert.equal(rows.length, 2);
	assert.equal(rows[0].cells.length, 2);
	assert.equal(rows[1].cells.length, 1);
});

test('groupIntoRows keeps far-apart rows apart even when x ranges match', () => {
	const rows = groupIntoRows([
		cell('A', 10, 100, 80, 124),
		cell('A', 10, 104, 80, 128),
		cell('B', 10, 500, 80, 524),
	]);
	assert.equal(rows.length, 2);
});

test('buildReceiptTable anchors columns from the header row', () => {
	const table = buildReceiptTable(fakeOcr());
	assert.ok(table, 'expected a table');
	const keys = table.columns.map((column) => column.key);
	assert.deepEqual(keys, ['product', 'code', 'quantity', 'unit_price', 'total']);
});

test('buildReceiptTable returns null when there is no header row', () => {
	const ocr = {
		width: 100,
		height: 100,
		lines: [cell('some shopping list', 10, 10, 200, 34)],
	};
	assert.equal(buildReceiptTable(ocr), null);
});

test('buildReceiptTable flags metadata rows above the header', () => {
	const table = buildReceiptTable(fakeOcr());
	const meta = table.rows.filter((row) => row.aboveHeader);
	assert.equal(meta.length, 2);
	assert.match(meta[0].values.product.text, /APOLLO PHARMACY/);
});

test('buildReceiptTable separates item rows from totals rows', () => {
	const table = buildReceiptTable(fakeOcr());
	const items = table.rows.filter((row) => !row.aboveHeader && !row.isTotalRow);
	const totals = table.rows.filter((row) => row.isTotalRow);
	assert.equal(items.length, 1);
	assert.equal(totals.length, 4);
});

test('buildReceiptTable attaches a wide cell to the column it starts in', () => {
	// A product name overrunning CODE/PACK must stay in the product column
	// rather than being split across columns.
	const table = buildReceiptTable(fakeOcr({
		rows: [['Napa Suspension 250mg/5ml that overruns', 'C-3003', '1', '55.00', '59.95']],
	}));
	const [row] = table.rows.filter((entry) => !entry.aboveHeader && !entry.isTotalRow);
	assert.match(row.values.product.text, /Napa Suspension/);
	assert.equal(row.values.code.text, 'C-3003');
});

/* ------------------------------------------------------------------ */
/* Label matching                                                      */
/* ------------------------------------------------------------------ */

test('normalizeLabel reads O-for-zero swaps in totals labels', () => {
	assert.equal(normalizeLabel('GRAND T0TAL 1573.25'), 'grandtotal');
	assert.equal(normalizeLabel('SUB TOTAL'), 'subtotal');
	assert.equal(normalizeLabel('25.00'), '');
	assert.equal(normalizeLabel('Napa Extra 500mg'), 'napaextrasoomg');
});

test('isTotalLabel accepts totals rows and rejects products', () => {
	assert.equal(isTotalLabel('SUB TOTAL'), true);
	assert.equal(isTotalLabel('GRAND T0TAL 366.96'), true);
	assert.equal(isTotalLabel('DISCOUNT'), true);
	assert.equal(isTotalLabel('VAT'), true);
	assert.equal(isTotalLabel('Napa Extra 500mg'), false);
	assert.equal(isTotalLabel('Total Care 500mg'), false);
	assert.equal(isTotalLabel('Seclo 20mg'), false);
});

/* ------------------------------------------------------------------ */
/* Value parsing                                                       */
/* ------------------------------------------------------------------ */

test('parseMoney reads printed amounts and rejects prose', () => {
	assert.equal(parseMoney('136.25'), 136.25);
	assert.equal(parseMoney('Rs. 1,250.50'), 1250.5);
	assert.equal(parseMoney('12,50'), 12.5);
	assert.equal(parseMoney('abc'), null);
	assert.equal(parseMoney(''), null);
	assert.equal(parseMoney(null), null);
});

test('parseQuantity rejects zero, negatives and non-numbers', () => {
	assert.equal(parseQuantity('20'), 20);
	assert.equal(parseQuantity('1,200'), 1200);
	assert.equal(parseQuantity('0'), null);
	assert.equal(parseQuantity('-5'), null);
	assert.equal(parseQuantity('abc'), null);
	assert.equal(parseQuantity(''), null);
});

test('parseReceiptDate normalises an unambiguous date', () => {
	assert.deepEqual(parseReceiptDate('2026-03-12'), { iso: '2026-03-12', raw: '2026-03-12', ambiguous: false });
	// 25 cannot be a month, so the order is pinned by the receipt itself.
	assert.deepEqual(parseReceiptDate('25/03/2026'), { iso: '2026-03-25', raw: '25/03/2026', ambiguous: false });
	assert.equal(parseReceiptDate('no date here').iso, null);
});

test('parseReceiptDate reports a day/month swap as ambiguous rather than guessing', () => {
	// Both 05/06 and 06/05 are valid dates and nothing on the receipt says which.
	assert.equal(parseReceiptDate('05/06/2026').ambiguous, true);
	assert.equal(parseReceiptDate('12/03/2026').ambiguous, true);
	assert.equal(parseReceiptDate('05/05/2026').ambiguous, false);
	assert.equal(parseReceiptDate('2026-03-12').ambiguous, false);
});

test('dosageFormOf only matches printed forms', () => {
	assert.equal(dosageFormOf('Napa Suspension 250mg/5ml'), 'suspension');
	assert.equal(dosageFormOf('Seclo 20mg'), null);
	assert.equal(dosageFormOf('Cough Syrup'), 'syrup');
});

test('learnCodePattern requires a consistent shape across rows', () => {
	const rows = [
		{ aboveHeader: false, isTotalRow: false, values: { code: { text: 'A-1001' } } },
		{ aboveHeader: false, isTotalRow: false, values: { code: { text: 'A-1002' } } },
	];
	// The learned rule is the shape (one letter, four digits), not the literal
	// prefix, so a different letter still matches but a different shape does not.
	const matches = learnCodePattern(rows, 'code');
	assert.equal(typeof matches, 'function');
	assert.equal(matches('B-1001'), true);
	assert.equal(matches('A-1002'), true);
	assert.equal(matches('A-10'), false);
	assert.equal(matches('Seclo 20mg'), false);
	assert.equal(learnCodePattern(rows.slice(0, 1), 'code'), null);
});

/* ------------------------------------------------------------------ */
/* Structured output and anti-hallucination                            */
/* ------------------------------------------------------------------ */

test('safeNumber nulls out values it cannot trust', () => {
	assert.equal(safeNumber('12.5'), 12.5);
	assert.equal(safeNumber('abc'), null);
	assert.equal(safeNumber(undefined), null);
	assert.equal(safeNumber('-3', { min: 0 }), null);
	assert.equal(safeNumber('7.8', { integer: true }), 8);
});

test('normalizeExpiry rejects an impossible date instead of storing it', () => {
	const reasons = [];
	assert.equal(normalizeExpiry('2026-13-45', reasons), null);
	assert.equal(reasons.length, 1);
	assert.equal(normalizeExpiry('2027-01-31', []), '2027-01-31');
});

test('validateItem never invents a missing expiry and forces review', () => {
	const item = validateItem({
		product_name: 'Napa Extra 500mg',
		quantity: 2,
		unit_price: 62.5,
		total_price: 125,
		confidence: 0.99,
		expiry_date: null,
	});
	assert.equal(item.expiry_date, null);
	assert.equal(item.needs_review, true);
	assert.ok(item.review_reasons.some((reason) => /expiry/i.test(reason)));
});

test('validateItem flags a line total that contradicts qty x price', () => {
	const item = validateItem({
		product_name: 'Napa Extra 500mg',
		quantity: 2,
		unit_price: 62.5,
		total_price: 999,
		expiry_date: '2027-01-31',
		confidence: 0.99,
	});
	assert.ok(item.review_reasons.some((reason) => /does not match/i.test(reason)));
});

test('validateItem accepts a consistent item with an expiry', () => {
	const item = validateItem({
		product_name: 'Napa Extra 500mg',
		quantity: 2,
		unit_price: 62.5,
		total_price: 125,
		expiry_date: '2027-01-31',
		confidence: 0.95,
	});
	assert.equal(item.needs_review, false);
	assert.deepEqual(item.review_reasons, []);
});

test('validateItem clamps confidence into 0..1', () => {
	assert.equal(validateItem({ confidence: 5 }).confidence, 1);
	assert.equal(validateItem({ confidence: -3 }).confidence, 0);
});

test('validateItem reports missing confidence as unknown, not zero', () => {
	// Zero would silently condemn every item; null means "not measured".
	assert.equal(validateItem({}).confidence, null);

	const complete = {
		product_name: 'Napa Extra 500mg',
		article_code: 'A-1001',
		quantity: 1,
		unit_price: 10,
		total_price: 10,
		expiry_date: '2027-12-31',
		confidence: 0.94,
	};
	assert.equal(validateItem(complete).needs_review, false);

	// Nothing measured means nothing verified, but the reviewer still has to be
	// told why rather than being shown a bare warning.
	const unchecked = validateItem({ ...complete, confidence: undefined });
	assert.equal(unchecked.needs_review, true);
	assert.deepEqual(unchecked.review_reasons, ['Item could not be fully verified']);
});

test('validateItem drops a product row with no name at all', () => {
	const item = validateItem({ quantity: 1 });
	assert.equal(item.product_name, null);
	assert.equal(item.needs_review, true);
});

test('moneyMatches allows rounding but not a real difference', () => {
	assert.equal(moneyMatches(125, 125.0), true);
	assert.equal(moneyMatches(341.25, 341.26), true);
	assert.equal(moneyMatches(341.25, 400), false);
	assert.equal(moneyMatches(null, 10), null);
});

test('buildStructuredOutput keeps the legacy field aliases the API reads', () => {
	const out = buildStructuredOutput({
		header: { supplierName: 'APOLLO PHARMACY', invoiceNumber: 'INV-1', purchaseDate: '2026-03-12', total: 125 },
		items: [{
			product_name: 'Napa Extra 500mg',
			strength: '500mg',
			quantity: 2,
			unit_price: 62.5,
			total_price: 125,
			expiry_date: '2027-01-31',
			confidence: 0.95,
		}],
	});
	assert.equal(out.supplierName, 'APOLLO PHARMACY');
	assert.equal(out.invoiceNumber, 'INV-1');
	assert.equal(out.purchaseDate, '2026-03-12');
	assert.equal(out.header.supplier_name, 'APOLLO PHARMACY');
	assert.equal(out.items[0].productName, 'Napa Extra 500mg');
	assert.equal(out.items[0].medicine_name, 'Napa Extra 500mg');
	assert.equal(out.summary.item_count, 1);
});

test('buildStructuredOutput raises review when subtotal disagrees with the lines', () => {
	const out = buildStructuredOutput({
		header: { supplierName: 'X', invoiceNumber: '1', purchaseDate: '2026-03-12', subtotal: 9999, total: 1 },
		items: [{
			product_name: 'A', quantity: 1, unit_price: 1, total_price: 1, expiry_date: '2027-01-31', confidence: 0.9,
		}],
	});
	assert.equal(out.needs_review, true);
	assert.ok(out.review_reasons.some((reason) => /subtotal/i.test(reason)));
});

test('buildStructuredOutput flags a receipt whose printed totals do not add up', () => {
	const out = buildStructuredOutput({
		header: {
			supplierName: 'X', invoiceNumber: '1', purchaseDate: '2026-03-12',
			subtotal: 100, discount: 10, tax: 5, total: 200,
		},
		items: [{
			product_name: 'A', quantity: 1, unit_price: 100, total_price: 100, expiry_date: '2027-01-31', confidence: 0.9,
		}],
	});
	assert.ok(out.review_reasons.some((reason) => /Grand total/i.test(reason)));
});

test('buildStructuredOutput reports an empty receipt rather than inventing items', () => {
	const out = buildStructuredOutput({ header: {}, items: [] });
	assert.equal(out.items.length, 0);
	assert.equal(out.needs_review, true);
	assert.ok(out.review_reasons.includes('No line items were found'));
});

/* ------------------------------------------------------------------ */
/* End-to-end over the pure layers                                    */
/* ------------------------------------------------------------------ */

test('extractFromTable produces validated items with real column values', () => {
	const ocr = fakeOcr({
		rows: [
			['Napa Extra 500mg', 'A-1001', '2', '62.50', '136.25'],
			['Seclo 20mg', 'B-2002', '1', '41.25', '44.96'],
		],
	});
	const out = extractFromTable(ocr, buildReceiptTable(ocr));
	assert.equal(out.items.length, 2);
	assert.equal(out.items[0].product_name, 'Napa Extra 500mg');
	assert.equal(out.items[0].quantity, 2);
	assert.equal(out.items[0].unit_price, 62.5);
	assert.equal(out.items[0].total_price, 136.25);
	assert.equal(out.items[0].strength, '500mg');
	assert.equal(out.items[1].article_code, 'B-2002');
	assert.equal(out.header.supplierName, 'APOLLO PHARMACY');
	assert.equal(out.header.invoiceNumber, '2026-0912');
	assert.equal(out.header.purchaseDate, '2026-03-12');
	assert.equal(out.header.subtotal, 125);
	assert.equal(out.header.discount, 5);
	assert.equal(out.header.tax, 11.25);
	assert.equal(out.header.total, 136.25);
});

test('extractFromTable returns null without a table instead of guessing', () => {
	assert.equal(extractFromTable({ lines: [] }, null), null);
});

/* ------------------------------------------------------------------ */
/* Orientation and merged headers                                      */
/* ------------------------------------------------------------------ */

test('groupIntoRows reverses row and cell order for an upside down receipt', () => {
	const upright = groupIntoRows([
		cell('TITLE', 10, 10, 200, 34),
		cell('LEFT', 10, 60, 90, 84),
		cell('RIGHT', 400, 60, 480, 84),
	]);
	const flipped = groupIntoRows([
		cell('TITLE', 10, 10, 200, 34),
		cell('LEFT', 10, 60, 90, 84),
		cell('RIGHT', 400, 60, 480, 84),
	], { reversed: true });

	assert.deepEqual(upright.map((row) => row.cells.map((c) => c.text)), [['TITLE'], ['LEFT', 'RIGHT']]);
	assert.deepEqual(flipped.map((row) => row.cells.map((c) => c.text)), [['RIGHT', 'LEFT'], ['TITLE']]);
});

test('buildReceiptTable reads an upside down receipt in reading order', () => {
	const upright = fakeOcr({ rows: [['Napa Extra 500mg', 'A-1001', '2', '62.50', '136.25']] });
	// Simulate the same receipt photographed the wrong way up: every line needed
	// a 180 degree turn, which mirrors both axes.
	const flipped = {
		...upright,
		lines: upright.lines.map((line) => ({
			...line,
			angle: 180,
			box: {
				x0: 1200 - line.box.x1,
				y0: 900 - line.box.y1,
				x1: 1200 - line.box.x0,
				y1: 900 - line.box.y0,
			},
		})),
	};

	const fromUpright = buildReceiptTable(upright);
	const fromFlipped = buildReceiptTable(flipped);
	assert.ok(fromUpright && fromFlipped);

	// A row's name lives in its first column in reading order, which is the
	// printed left edge whichever way up the receipt is.
	const nameOf = (table, row) => row.values[table.columns[0].key].text;
	const supplierOf = (table) => nameOf(table, table.rows.find((row) => row.aboveHeader));
	assert.equal(supplierOf(fromFlipped), supplierOf(fromUpright));

	// The header must still be the header, and the item must still read
	// left to right, rather than the columns swapping places.
	const firstRowOf = (table) => table.rows.filter((row) => !row.aboveHeader && !row.isTotalRow)[0];
	assert.equal(nameOf(fromFlipped, firstRowOf(fromFlipped)), nameOf(fromUpright, firstRowOf(fromUpright)));
	assert.deepEqual(
		firstRowOf(fromFlipped).values.code.text,
		firstRowOf(fromUpright).values.code.text,
	);
	// Totals rows must still be recognised as totals after the flip.
	assert.ok(fromFlipped.rows.some((row) => row.isTotalRow));
	assert.ok(fromUpright.rows.some((row) => row.isTotalRow));
});

test('buildReceiptTable splits a header that merged several column names', () => {
	// Narrow thermal paper runs these together and the detector returns one box.
	const lines = [
		cell('APOLLO PHARMACY', 40, 10, 600, 34),
		cell('PRODUCT CODE BATCH EXPIRY QTY PRICE TOTAL', 40, 60, 1000, 84),
		cell('Napa Extra 500mg', 40, 110, 260, 134),
		cell('A-1001', 280, 110, 380, 134),
		cell('BT-77', 400, 110, 500, 134),
		cell('31/12/2027', 520, 110, 660, 134),
		cell('2', 680, 110, 720, 134),
		cell('62.50', 740, 110, 840, 134),
		cell('125.00', 860, 110, 1000, 134),
		cell('SUB TOTAL', 40, 160, 300, 184),
		cell('166.25', 860, 160, 1000, 184),
	];
	const table = buildReceiptTable({ width: 1200, height: 900, lines });
	assert.ok(table);
	assert.deepEqual(
		table.columns.map((column) => column.key),
		['product', 'code', 'batch', 'expiry', 'quantity', 'unit_price', 'total'],
	);

	const item = table.rows.find((row) => !row.aboveHeader && !row.isTotalRow);
	assert.equal(item.values.code.text, 'A-1001');
	assert.equal(item.values.batch.text, 'BT-77');
	assert.equal(item.values.expiry.text, '31/12/2027');
	assert.equal(item.values.quantity.text, '2');
});

/* ------------------------------------------------------------------ */
/* Taxed receipts and column bleed                                     */
/* ------------------------------------------------------------------ */

test('a printed VAT line total is checked against price plus VAT', () => {
	const item = validateItem({
		product_name: 'Napa Extra 500mg',
		article_code: 'A-1001',
		strength: '500mg',
		quantity: 2,
		unit_price: 62.5,
		vat_amount: 11.25,
		total_price: 136.25,
		expiry_date: '2027-12-31',
		confidence: 0.95,
	}, []);
	// 2 x 62.50 + 11.25 line VAT = 136.25
	assert.deepEqual(item.review_reasons, []);
	assert.equal(item.needs_review, false);
});

test('a real line total error is still caught on a taxed receipt', () => {
	const item = validateItem({
		product_name: 'Napa Extra 500mg',
		article_code: 'A-1001',
		quantity: 2,
		unit_price: 62.5,
		vat_amount: 11.25,
		total_price: 150,
		expiry_date: '2027-12-31',
		confidence: 0.95,
	}, []);
	assert.ok(item.review_reasons.some((reason) => /does not match/.test(reason)));
	assert.equal(item.needs_review, true);
});

test('line totals are not derived when a VAT column exists but is unreadable', () => {
	const extracted = extractFromTable(fakeOcr({
		headers: ['PRODUCT', 'CODE', 'QTY', 'PRICE', 'VAT', 'TOTAL'],
		rows: [['Napa Extra 500mg', 'A-1001', '2', '62.50', '??', '136.25']],
		columns: 6,
	}), buildReceiptTable(fakeOcr({
		headers: ['PRODUCT', 'CODE', 'QTY', 'PRICE', 'VAT', 'TOTAL'],
		rows: [['Napa Extra 500mg', 'A-1001', '2', '62.50', '??', '136.25']],
		columns: 6,
	})));
	const [item] = extracted.items;
	// The printed total is kept, and the unreadable VAT is reported rather than
	// being quietly treated as zero.
	assert.equal(item.total_price, 136.25);
	assert.equal(item.vat_amount, null);
	assert.equal(item.vat_column, true);
	assert.equal(item.needsReview, true);
	assert.ok(item.reviewReasons.some((reason) => /VAT/.test(reason)));
});

test('a date that lands in a numeric column is never read as a quantity or price', () => {
	assert.equal(parseQuantity('31/12/2027'), null);
	assert.equal(parseMoney('30/06/2028'), null);
	assert.equal(parseQuantity('2'), 2);
	assert.equal(parseMoney('62.50'), 62.5);
});
