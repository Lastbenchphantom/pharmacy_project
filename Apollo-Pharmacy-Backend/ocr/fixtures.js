const fs = require('fs');
const os = require('os');
const path = require('path');

const sharp = require('sharp');

const HEADER_FONT = 'font-family="DejaVu Sans Mono, monospace" font-weight="bold"';
const BODY_FONT = 'font-family="DejaVu Sans Mono, monospace"';

const escapeXml = (value) => String(value)
	.replace(/&/g, '&amp;')
	.replace(/</g, '&lt;')
	.replace(/>/g, '&gt;');

/**
 * Renders a monospaced table receipt as a PNG.
 *
 * @param {object} options
 * @param {Array<{cells: string[]}>} options.rows rows of column cells (same width)
 * @param {number} [options.fontSize]
 * @param {number} [options.rotate] rotation applied to the rendered page
 * @param {number} [options.contrast] 1 = normal, <1 = washed out
 * @param {number} [options.noise] 0..1 additive noise amount
 * @param {number} [options.margin]
 * @returns {Promise<Buffer>} PNG bytes
 */
const renderReceipt = async ({
	title = 'APOLLO PHARMACY',
	subtitle = 'PURCHASE RECEIPT',
	headers = [],
	rows = [],
	footer = [],
	fontSize = 22,
	rotate = 0,
	contrast = 1,
	noise = 0,
	margin = 40,
	background = '#ffffff',
	foreground = '#000000',
	scale = 1,
}) => {
	const columns = Math.max(headers.length, ...rows.map((row) => row.cells.length), 1);
	const charWidth = fontSize * 0.6;
	const lineHeight = fontSize * 1.7;
	// Real receipts print each cell at a fixed column pitch regardless of font
	// size, so cells are positioned individually instead of relying on
	// monospace padding. Each column is as wide as its widest value, the way a
	// table auto-lays-out; a fixed pitch would let a long product name run over
	// the CODE column, which no real till produces.
	// A real till leaves a visible gutter between columns; too tight a gap and
	// the detector merges neighbouring headers into a single box.
	const columnGap = 3;
	const columnWidths = Array.from({ length: columns }, (_, index) => {
		const lengths = [String(headers[index] || '').length];
		for (const row of rows) {
			if (row.blank) continue;
			lengths.push(String((row.cells || [])[index] || '').length);
		}
		return Math.max(1, ...lengths);
	});
	const columnOffsets = [];
	let runningWidth = 0;
	for (let index = 0; index < columns; index += 1) {
		columnOffsets.push(runningWidth);
		runningWidth += (columnWidths[index] + columnGap) * charWidth;
	}
	const tableWidth = runningWidth;
	const columnX = (index) => margin + columnOffsets[index];

	const parts = [];
	let y = margin + fontSize;

	parts.push(`<text x="${margin}" y="${y}" ${HEADER_FONT} font-size="${fontSize * 1.2}" fill="${foreground}">${escapeXml(title)}</text>`);
	y += lineHeight;
	if (subtitle) {
		parts.push(`<text x="${margin}" y="${y}" ${BODY_FONT} font-size="${fontSize * 0.8}" fill="${foreground}">${escapeXml(subtitle)}</text>`);
		y += lineHeight;
	}
	y += lineHeight * 0.4;

	const renderCells = (cells, font, size) => cells
		.map((cell, index) => (String(cell).trim() === '' ? '' : `<text x="${columnX(index)}" y="${y}" ${font} font-size="${size}" fill="${foreground}" xml:space="preserve">${escapeXml(cell)}</text>`))
		.join('');

	if (headers.length) {
		parts.push(renderCells(headers, HEADER_FONT, fontSize));
		y += lineHeight * 0.5;
		// Separator rule sits in the gap between the header and the first row.
		parts.push(`<line x1="${margin}" y1="${y}" x2="${margin + tableWidth}" y2="${y}" stroke="${foreground}" stroke-width="1.5"/>`);
		y += lineHeight * 0.5;
	}

	for (const row of rows) {
		if (row.blank) {
			y += lineHeight * 0.6;
			continue;
		}
		parts.push(renderCells(row.cells, BODY_FONT, fontSize));
		y += lineHeight;
	}

	for (const line of footer) {
		y += lineHeight * 0.3;
		if (line && typeof line === 'object' && line.value !== undefined) {
			// Totals lines print a left label and a right-aligned figure, the
			// way a till does, so the value sits under the TOTAL column.
			parts.push(`<text x="${margin}" y="${y}" ${BODY_FONT} font-size="${fontSize}" fill="${foreground}">${escapeXml(line.label || '')}</text>`);
			parts.push(`<text x="${margin + tableWidth}" y="${y}" text-anchor="end" ${BODY_FONT} font-size="${fontSize}" fill="${foreground}">${escapeXml(line.value)}</text>`);
		} else {
			parts.push(`<text x="${margin}" y="${y}" ${BODY_FONT} font-size="${fontSize * 0.8}" fill="${foreground}" xml:space="preserve">${escapeXml(line)}</text>`);
		}
		y += lineHeight;
	}

	const width = Math.ceil(tableWidth + margin * 2);
	const height = Math.ceil(y + margin);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${background}"/>${parts.join('')}</svg>`;

	let pipeline = sharp(Buffer.from(svg)).png();
	if (scale !== 1) {
		pipeline = pipeline.resize({
			width: Math.round(width * scale),
			height: Math.round(height * scale),
			kernel: 'lanczos3',
		});
	}
	let output = await pipeline.toBuffer();

	if (contrast !== 1 || noise > 0) {
		output = await degrade(output, { contrast, noise });
	}
	if (rotate) {
		output = await sharp(output).rotate(rotate, { background: '#f0f0f0' }).png().toBuffer();
	}
	return output;
};

/** Simulates a phone photo: reduced contrast, slight blur and sensor noise. */
const degrade = async (buffer, { contrast, noise }) => {
	const image = sharp(buffer).removeAlpha().toColourspace('srgb');
	const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
	const channels = info.channels;
	const amount = 1 / Math.max(0.05, contrast);
	for (let i = 0; i < data.length; i += channels) {
		for (let c = 0; c < 3; c += 1) {
			let value = 255 - (255 - data[i + c]) * amount;
			if (noise > 0) {
				// Deterministic pseudo-noise keeps fixtures reproducible.
				const n = Math.sin(i * 12.9898 + c * 78.233) * 43758.5453;
				value += (n - Math.floor(n) - 0.5) * 255 * noise;
			}
			data[i + c] = Math.max(0, Math.min(255, Math.round(value)));
		}
	}
	return sharp(data, { raw: { width: info.width, height: info.height, channels } })
		.blur(0.4)
		.png()
		.toBuffer();
};

const writeFixture = async (name, buffer) => {
	const directory = path.join(__dirname, '..', 'tests', 'fixtures');
	fs.mkdirSync(directory, { recursive: true });
	const target = path.join(directory, `${name}.png`);
	fs.writeFileSync(target, buffer);
	return target;
};

/* ------------------------------------------------------------------ */
/* Canonical fixtures                                                   */
/* ------------------------------------------------------------------ */

const STANDARD_HEADERS = [
	'PRODUCT', 'CODE', 'PACK', 'QTY', 'PRICE', 'VAT', 'VALUE', 'DISC', 'TOTAL',
];

/**
 * Internally consistent on purpose: VALUE = QTY x PRICE, VAT = 9% of VALUE and
 * TOTAL = VALUE - DISC + VAT, so tests can assert the arithmetic rather than
 * just checking that some text came back.
 */
// Line TOTAL is VAT-inclusive, SUB TOTAL is the net (pre-VAT) sum, and the
// till applies the discount after VAT:
//   net  125.00 + 120.00 + 41.25 + 55.00      = 341.25 (SUB TOTAL)
//   vat   11.25 +  10.80 +  3.71 +  4.95      =  30.71 (VAT)
//   341.25 + 30.71 - 5.00                     = 366.96 (GRAND TOTAL)
const STANDARD_ROWS = [
	{ cells: [' Napa Extra 500mg', 'A-1001', '10', '2', '62.50', '11.25', '136.25', '0.00', '136.25'] },
	{ cells: [' Napa Extra 500mg', 'A-1002', '10', '1', '120.00', '10.80', '130.80', '5.00', '130.80'] },
	{ cells: [' Seclo 20mg', 'B-2002', '10', '1', '41.25', '3.71', '44.96', '0.00', '44.96'] },
	{ cells: [' Napa Suspension 250mg/5ml', 'C-3003', '1', '1', '55.00', '4.95', '59.95', '0.00', '59.95'] },
];

const STANDARD_FOOTER = [
	{ label: 'SUB TOTAL', value: '341.25' },
	{ label: 'DISCOUNT', value: '5.00' },
	{ label: 'VAT', value: '30.71' },
	{ label: 'GRAND TOTAL', value: '366.96' },
];

/** A receipt that prints batch and expiry columns, as wholesalers do. */
const BATCH_HEADERS = [
	'PRODUCT', 'CODE', 'BATCH', 'EXPIRY', 'QTY', 'PRICE', 'TOTAL',
];
const BATCH_ROWS = [
	{ cells: [' Napa Extra 500mg', 'A-1001', 'BT-77', '31/12/2027', '2', '62.50', '125.00'] },
	{ cells: [' Seclo 20mg', 'B-2002', 'BT-12', '30/06/2028', '1', '41.25', '41.25'] },
];
const BATCH_FOOTER = [
	{ label: 'SUB TOTAL', value: '166.25' },
	{ label: 'GRAND TOTAL', value: '166.25' },
];

/** A till slip with no ruled table at all, to exercise the flat-text fallback. */
const buildFreeTextReceipt = async (variant = {}) => renderReceipt({
	title: 'APOLLO PHARMACY',
	subtitle: 'SALES RECEIPT INV-9001 2026-04-02',
	headers: [],
	rows: [],
	footer: [
		'Napa Extra 500mg qty 4',
		'Seclo 20mg qty 2',
		'TOTAL 320.00',
	],
	...variant,
});

/** Renders the canonical pharmacy table receipt in a given capture style. */
const buildStandardReceipt = async (variant = {}) => renderReceipt({
	title: 'APOLLO PHARMACY',
	subtitle: 'PURCHASE RECEIPT  INV-2026-0912   2026-03-12',
	headers: STANDARD_HEADERS,
	rows: STANDARD_ROWS,
	footer: STANDARD_FOOTER,
	...variant,
});

/** Same table, but with the batch/expiry columns a wholesaler prints. */
const buildBatchReceipt = async (variant = {}) => renderReceipt({
	title: 'APOLLO PHARMACY',
	subtitle: 'PURCHASE RECEIPT  INV-2026-0913   2026-03-13',
	headers: BATCH_HEADERS,
	rows: BATCH_ROWS,
	footer: BATCH_FOOTER,
	...variant,
});

module.exports = {
	renderReceipt,
	buildStandardReceipt,
	buildBatchReceipt,
	buildFreeTextReceipt,
	writeFixture,
	STANDARD_HEADERS,
	STANDARD_ROWS,
	STANDARD_FOOTER,
	BATCH_HEADERS,
	BATCH_ROWS,
	STANDARD_FOOTER,
};
