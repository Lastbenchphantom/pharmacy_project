'use strict';

/**
 * Diagnostic view of the receipt pipeline.
 *
 * Usage:
 *   node scripts/debug-ocr.js <receipt-image> [--prep] [--detect] [--lines] [--fixtures]
 *
 * With no arguments it renders the built in fixtures, which is usually faster
 * than hunting for a real photo. This exists because "the numbers came out in
 * the wrong columns" is almost always either a detection geometry problem or a
 * table structure problem, and both are obvious once the boxes are printed.
 */

const fs = require('fs');

const { prepareReceiptImage } = require('../ocr/imagePreprocess');
const { recognizeImage, detectTextRegions } = require('../ocr/paddleOcr');
const { buildReceiptTable } = require('../ocr/receiptTable');
const { extractFromTable } = require('../ocr/receiptExtract');
const { buildStructuredOutput } = require('../ocr/structuredOutput');
const { buildStandardReceipt, buildBatchReceipt } = require('../ocr/fixtures');

const showPrep = (prepared) => {
	console.log('size', `${prepared.width}x${prepared.height}`, 'transforms', JSON.stringify(prepared.transforms));
	if (prepared.tone) console.log('tone', JSON.stringify(prepared.tone));
};

const showDetection = async (imageBuffer) => {
	const regions = await detectTextRegions(imageBuffer);
	console.log('regions', regions.length);
	for (const region of regions) {
		console.log(
			'y=' + String(Math.round(region.box.y0)).padStart(5),
			'h=' + String(Math.round(region.box.y1 - region.box.y0)).padStart(3),
			'x=' + String(Math.round(region.box.x0)).padStart(5) + '-' + String(Math.round(region.box.x1)).padStart(5),
			'angle=' + String(Math.round(region.angle ?? 0)).padStart(3),
			'score=' + region.score.toFixed(3),
		);
	}
};

const showLines = (ocr) => {
	for (const line of ocr.lines) {
		console.log(
			'y=' + String(Math.round(line.box.y0)).padStart(5),
			'x=' + String(Math.round(line.box.x0)).padStart(5) + '-' + String(Math.round(line.box.x1)).padStart(5),
			'c=' + line.confidence.toFixed(3),
			'rot=' + line.angle,
			JSON.stringify(line.text),
		);
	}
};

const showTable = (table) => {
	if (!table) {
		console.log('no table header found, the caller falls back to a flat text parse');
		return;
	}
	console.log('columns', table.columns.map((column) => `${column.key}[${Math.round(column.x0)}-${Math.round(column.x1)}]`).join(' '));
	for (const row of table.rows) {
		const kind = row.aboveHeader ? 'META' : (row.isTotalRow ? 'TOTL' : 'ITEM');
		const cells = Object.entries(row.values)
			.map(([key, value]) => `${key}=${JSON.stringify(value.text)}`)
			.join(' ');
		const loose = row.tight === false ? ' loose' : '';
		console.log(kind.padEnd(5), cells + loose);
	}
};

const showStructured = (result) => {
	console.log('header', JSON.stringify(result.header));
	console.log('summary', JSON.stringify(result.summary));
	console.log('review_reasons', JSON.stringify(result.review_reasons));
	for (const item of result.items) {
		console.log('  item', JSON.stringify({
			product_name: item.product_name,
			article_code: item.article_code,
			quantity: item.quantity,
			unit_price: item.unit_price,
			vat_amount: item.vat_amount,
			total_price: item.total_price,
			batch_number: item.batch_number,
			expiry_date: item.expiry_date,
			needs_review: item.needs_review,
			review_reasons: item.review_reasons,
		}));
	}
};

const main = async () => {
	const args = process.argv.slice(2);
	const wants = (flag) => args.includes(flag);
	const target = args.find((arg) => !arg.startsWith('--'));

	// No image given, so exercise the known good renders instead.
	const sources = target
		? [{ name: target, buffer: fs.readFileSync(target) }]
		: [
			{ name: 'standard fixture', buffer: await buildStandardReceipt({ scale: 2.2 }) },
			{ name: 'batch/expiry fixture', buffer: await buildBatchReceipt({ scale: 2.2 }) },
		];

	const stages = wants('--prep') || wants('--detect') || wants('--lines') || wants('--table') || !target;

	for (const source of sources) {
		console.log(`\n===== ${source.name}`);
		const started = Date.now();
		const prepared = await prepareReceiptImage(source.buffer);
		const image = prepared.buffer || source.buffer;
		if (wants('--prep')) showPrep(prepared);
		if (wants('--detect')) await showDetection(image);
		if (wants('--lines')) {
			const ocr = await recognizeImage(image);
			showLines(ocr);
		}
		if (stages && (wants('--table') || wants('--detect') === false)) {
			const ocr = await recognizeImage(image);
			const table = buildReceiptTable(ocr);
			showTable(table);
			showStructured(buildStructuredOutput(extractFromTable(ocr, table)));
		}
		console.log('total', Date.now() - started + 'ms');
	}
};

main().catch((error) => {
	console.error('ERR', error.stack);
	process.exitCode = 1;
});
