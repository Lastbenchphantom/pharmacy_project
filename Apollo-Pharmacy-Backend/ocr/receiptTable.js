'use strict';

/**
 * Turns geometry-aware OCR lines into an actual receipt table.
 *
 * The recogniser hands back individual cells with pixel boxes, which is far more
 * reliable than re-parsing a flat text blob: a ruled receipt is a grid, and the
 * grid is right there in the coordinates. This module recovers it.
 *
 * Two steps:
 *   1. Group cells into visual rows by vertical overlap.
 *   2. Anchor columns to the header row and assign each body cell to the column
 *      it overlaps most, allowing a cell to span several columns (a long
 *      product name happily covers the CODE and PACK columns on narrow receipts).
 */

const COLUMN_KEYWORDS = [
	{ key: 'product', match: /\b(prod(uct)?|item|description|medicine|drug)\b/i },
	{ key: 'code', match: /\b(code|sku|item\s*no|article)\b/i },
	{ key: 'batch', match: /\b(batch|batch\s*no\.?|lot|lot\s*no\.?)\b/i },
	{ key: 'expiry', match: /\b(expiry|expiration|exp\.?|exp\s*date|use\s*by|best\s*before)\b/i },
	{ key: 'pack', match: /\b(pack|size|pack\s*size)\b/i },
	{ key: 'quantity', match: /\b(qty|quantity|units?|qty\s*on\s*hand)\b/i },
	{ key: 'unit_price', match: /\b(price|unit\s*price|rate|mrp|rate\s*per)\b/i },
	{ key: 'vat', match: /\b(vat|tax|gst|stamp)\b/i },
	{ key: 'net_value', match: /\b(value|amount|net|net\s*value|basic)\b/i },
	{ key: 'discount', match: /\b(disc(ount)?|less|rebate)\b/i },
	{ key: 'total', match: /\b(total|grand\s*total|net\s*payable|amount\s*payable)\b/i },
];

/**
 * Labels that end a table; their rows are totals, never line items.
 *
 * Compared against letters only, so "GRAND T0TAL 1573.25" still matches even
 * when the recogniser swaps O for 0.
 */
const TOTAL_ROW_LABELS = /^(subtotal|total|grandtotal|netpayable|amountpayable|roundoff|discount|vat|tax|gst|cash)$/i;

/**
 * Letter-only, confusion-tolerant form of a label, for keyword matching.
 *
 * PP-OCRv5 likes to trade O for 0, I for 1, S for 5 and B for 8 in caps runs.
 * Folding those back before comparing means "GRAND T0TAL 1573.25" still
 * matches the totals keywords. Only ever used to test a label — the emitted
 * text is never rewritten.
 */
const normalizeLabel = (text) => String(text || '')
	// Drop standalone trailing numbers first ("... 1573.25" -> "..."), otherwise
	// the confusion map below would turn those digits into letters.
	.replace(/[\s\-:(]*\d[\d.,]*\s*$/, '')
	.replace(/0/g, 'o')
	.replace(/1/g, 'i')
	.replace(/5/g, 's')
	.replace(/8/g, 'b')
	.replace(/[^a-z\s]/gi, ' ')
	.replace(/\s+/g, '')
	.toLowerCase();

const isTotalLabel = (text) => TOTAL_ROW_LABELS.test(normalizeLabel(text));

const NUMERIC_RE = /^[-(]?\s*[₹$€£]?\s*\d[\d\s,]*(\.\d{1,2})?\s*\)?%?$/;

const centreX = (box) => (box.x0 + box.x1) / 2;
const centreY = (box) => (box.y0 + box.y1) / 2;
const widthOf = (box) => Math.max(0, box.x1 - box.x0);
const isNumeric = (text) => NUMERIC_RE.test(String(text || '').trim());

const median = (values) => {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[sorted.length >> 1];
};

/**
 * Groups cells into visual rows.
 *
 * Cells on one printed line share vertical overlap; a small vertical offset
 * between a tall product name and short numbers still overlaps heavily. A cell
 * starts a new row when it overlaps the current band by less than half of its
 * own height.
 */
const groupIntoRows = (cells, { reversed = false } = {}) => {
	const sorted = [...cells].sort((a, b) => centreY(a.box) - centreY(b.box));
	const rows = [];
	for (const cell of sorted) {
		const height = Math.max(1, cell.box.y1 - cell.box.y0);
		const current = rows[rows.length - 1];
		if (current) {
			const overlap = Math.min(current.y1, cell.box.y1) - Math.max(current.y0, cell.box.y0);
			if (overlap > height * 0.5) {
				current.y0 = Math.min(current.y0, cell.box.y0);
				current.y1 = Math.max(current.y1, cell.box.y1);
				current.cells.push(cell);
				continue;
			}
		}
		rows.push({ y0: cell.box.y0, y1: cell.box.y1, cells: [cell] });
	}
	for (const row of rows) {
		row.cells.sort((a, b) => centreX(a.box) - centreX(b.box));
	}
	// An upside down receipt is read from the bottom of the image upwards, so
	// both the order of the rows and the order of the cells inside each row are
	// reversed. Everything downstream then works in reading order regardless of
	// how the receipt was photographed.
	if (reversed) {
		rows.reverse();
		for (const row of rows) row.cells.reverse();
	}
	return rows;
};

/** Scores how strongly a row of cell labels reads as a table header. */
const scoreHeaderRow = (row) => {
	const keys = new Set();
	for (const cell of row.cells) {
		// A cell can carry more than one column name when the detector merged
		// adjacent headers, so every keyword in the cell counts.
		for (const column of COLUMN_KEYWORDS) {
			if (column.match.test(cell.text)) keys.add(column.key);
		}
	}
	// A header needs at least a name column plus one more, otherwise a single
	// cell that happens to say "total" would promote a totals row.
	return { keys, score: keys.size };
};

const findHeaderRow = (rows) => {
	let best = null;
	rows.forEach((row, index) => {
		const { score } = scoreHeaderRow(row);
		if (score < 2) return;
		if (!best || score > best.score) best = { index, score, row };
	});
	return best;
};

/**
 * Builds column anchors from the header row.
 *
 * On narrow thermal paper two or three headers run together and the detector
 * returns one box covering all of them ("CODE BATCH EXPIRY"). Silently keeping
 * only the first match would drop columns and shift every number after it, so a
 * multi-keyword label is split into one column per keyword.
 *
 * The split boundaries start out evenly spaced, which is only a guess: printed
 * columns are not the same width as each other. Whenever the body rows show
 * clear gaps in exactly the right number of places, those gaps are used instead,
 * because they are where the receipt actually puts its column breaks.
 */
const buildColumns = (headerRow, bodyRows = []) => {
	const columns = [];
	for (const cell of headerRow.cells) {
		const label = cell.text.trim();
		const matches = COLUMN_KEYWORDS.filter((column) => column.match.test(label));

		if (matches.length > 1) {
			const span = (cell.box.x1 - cell.box.x0) / matches.length;
			matches.forEach((matched, index) => {
				columns.push({
					key: matched.key,
					label,
					x0: cell.box.x0 + span * index,
					x1: cell.box.x0 + span * (index + 1),
					numeric: false,
				});
			});
			continue;
		}

		const matched = matches[0];
		columns.push({
			key: matched ? matched.key : `column_${columns.length + 1}`,
			label,
			x0: cell.box.x0,
			x1: cell.box.x1,
			numeric: isNumeric(label),
		});
	}
	return snapSplitColumns(columns, bodyRows);
};

/**
 * Replaces the guessed boundaries of split columns with the real ones.
 *
 * The body of the receipt prints its values in columns, and the whitespace
 * between them marks the column breaks. When the number of gaps matches the
 * number of columns that were split out of one merged header, those gaps are
 * used as the boundaries. If the counts disagree the guess is kept, because a
 * wrong number of boundaries would move every value into the wrong column.
 */
const snapSplitColumns = (columns, bodyRows) => {
	const splits = [];
	for (let index = 0; index < columns.length - 1; index += 1) {
		if (columns[index].label === columns[index + 1].label) splits.push(index);
	}
	if (!splits.length || !bodyRows.length) return columns;

	// Gaps are measured one printed line at a time. Pooling every row would let
	// a wide product name bridge over the code and batch columns and hide the
	// very breaks being looked for.
	const wanted = splits.length + 1;
	const gapsOf = (row) => {
		const intervals = row.cells.map((cell) => [cell.box.x0, cell.box.x1]).sort((a, b) => a[0] - b[0]);
		const heights = row.cells.map((cell) => cell.box.y1 - cell.box.y0).sort((a, b) => a - b);
		const minGap = Math.max(4, (heights[Math.floor(heights.length / 2)] || 1) * 0.35);
		const runs = [];
		for (const [x0, x1] of intervals) {
			const last = runs[runs.length - 1];
			if (last && x0 <= last.x1) last.x1 = Math.max(last.x1, x1);
			else runs.push({ x0, x1 });
		}
		if (runs.length !== wanted) return null;
		const gaps = [];
		for (let index = 0; index < runs.length - 1; index += 1) {
			if (runs[index + 1].x0 - runs[index].x1 < minGap) return null;
			gaps.push((runs[index].x1 + runs[index + 1].x0) / 2);
		}
		return gaps;
	};

	// Prefer the fullest line that breaks into exactly the expected number of
	// columns; the busiest row is the most reliable witness.
	const candidates = bodyRows
		.filter((row) => row.cells.length >= wanted)
		.sort((a, b) => b.cells.length - a.cells.length);
	const gaps = candidates.map(gapsOf).find(Boolean);
	if (!gaps) return columns;

	for (const [position, splitIndex] of splits.entries()) {
		const value = gaps[position];
		columns[splitIndex].x1 = value;
		columns[splitIndex + 1].x0 = value;
	}
	return columns;
};

const assignToColumn = (cell, columns) => {
	let best = null;
	let bestOverlap = 0;
	for (const column of columns) {
		const overlap = Math.min(cell.box.x1, column.x1) - Math.max(cell.box.x0, column.x0);
		if (overlap > bestOverlap) {
			bestOverlap = overlap;
			best = column;
		}
	}
	if (!best) {
		// Cell sits in a gutter between printed labels: fall back to the
		// nearest column by centre distance.
		let nearest = null;
		let nearestDistance = Infinity;
		for (const column of columns) {
			const distance = Math.abs(centreX(cell.box) - centreX(column));
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearest = column;
			}
		}
		return { column: nearest, overlap: 0 };
	}
	return { column: best, overlap: bestOverlap };
};

/**
 * Builds the receipt table from OCR output.
 *
 * Returns null when no header row could be identified, which tells the caller
 * to fall back to a flat-text parse rather than guess at a grid.
 */

/**
 * True when most lines were read after a 180 degree turn, meaning the image is
 * upside down and reading order runs backwards.
 */
const isUpsideDown = (ocr) => {
	const lines = ocr && Array.isArray(ocr.lines) ? ocr.lines : [];
	const angled = lines.filter((line) => line && (line.angle === 180 || line.angle === 90 || line.angle === 270));
	return angled.length > lines.length / 2;
};

const buildReceiptTable = (ocr) => {
	const cells = (ocr && Array.isArray(ocr.lines) ? ocr.lines : [])
		.filter((line) => line && String(line.text || '').trim().length > 0)
		.map((line) => ({ text: String(line.text).trim(), confidence: line.confidence, box: line.box }));

	if (!cells.length) return null;

	// A receipt photographed upside down reads from the bottom of the image up
	// and from right to left, so the header, the rows above it and the order of
	// words inside a cell all have to follow that direction. The pipeline
	// reports the orientation it settled on per line, so the receipt's overall
	// direction is decided by a majority vote rather than assumed.
	const flipped = isUpsideDown(ocr);
	const rows = groupIntoRows(cells, { reversed: flipped });
	const header = findHeaderRow(rows);
	if (!header) return null;

	const columns = buildColumns(header.row, rows.filter((row) => row !== header.row));
	if (!columns.length) return null;

	const body = [];
	for (let index = 0; index < rows.length; index += 1) {
		if (index === header.index) continue;
		const row = rows[index];
		const cellsByColumn = {};
		let anything = 0;

		for (const cell of row.cells) {
			const { column, overlap } = assignToColumn(cell, columns);
			if (!column) continue;
			// A cell touching a column by only a sliver is more likely a
			// neighbour's bleed than real content; still keep it, but the
			// extractor treats such columns as unreliable.
			const bucket = cellsByColumn[column.key] || { text: '', confidence: null, cells: [], tight: true };
			bucket.cells.push({ text: cell.text, confidence: cell.confidence, box: cell.box, overlap });
			if (overlap < widthOf(cell.box) * 0.35) bucket.tight = false;
			cellsByColumn[column.key] = bucket;
			anything += 1;
		}
		if (!anything) continue;

		const values = {};
		for (const [key, bucket] of Object.entries(cellsByColumn)) {
			values[key] = {
				text: bucket.cells.map((entry) => entry.text).join(' ').trim(),
				confidence: bucket.cells.length
					? Math.min(...bucket.cells.map((entry) => entry.confidence ?? 0))
					: null,
				tight: bucket.tight,
				boxes: bucket.cells.map((entry) => entry.box),
			};
		}

		// Columns are built from the header row, whose cells are already in
		// reading order, so the first one is the row's name column whichever way
		// up the receipt was photographed.
		const label = values[columns[0].key] ? values[columns[0].key].text : '';
		body.push({
			rowIndex: index,
			// Rows printed above the column labels are receipt metadata (shop
			// name, receipt number, date), never line items.
			aboveHeader: index < header.index,
			y0: row.y0,
			y1: row.y1,
			label,
			isTotalRow: isTotalLabel(label),
			values,
		});
	}

	const heights = rows.map((row) => row.y1 - row.y0);
	return {
		columns: columns.map((column) => ({ key: column.key, label: column.label, x0: column.x0, x1: column.x1 })),
		headerRowIndex: header.index,
		headerKeys: [...header.row.cells].length ? [...new Set(columns.map((column) => column.key))] : [],
		medianRowHeight: median(heights),
		rows: body,
	};
};

module.exports = {
	buildReceiptTable,
	groupIntoRows,
	buildColumns,
	assignToColumn,
	isNumeric,
	isTotalLabel,
	normalizeLabel,
	COLUMN_KEYWORDS,
	TOTAL_ROW_LABELS,
};
