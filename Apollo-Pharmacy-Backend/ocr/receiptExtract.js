'use strict';

/**
 * Turns a recovered receipt table into structured header + line items.
 *
 * Hard rule for this module: a field is only populated when the receipt
 * actually printed evidence for it. Anything unreadable stays null and raises
 * `needsReview`, because a plausible-looking guess about an expiry date or a
 * pack size is far more dangerous here than a blank field that a human will
 * fill in during review.
 */

const { isTotalLabel, normalizeLabel } = require('./receiptTable');

const STRENGTH_RE = /\b(\d+(?:[.,]\d+)?)\s*(mg|mcg|g|kg|ml|l|%|iu|units?|mcg)\b/i;
const BATCH_RE = /\b(?:batch|batch\s*no\.?|lot)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-/]{1,19})\b/i;
const EXPIRY_RE = /\b(?:exp|expiry|expires|exp\.?date|mfd|use\s*by)\s*[:#\-]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2})/i;
const ARTICLE_CODE_RE = /\b([A-Z]{1,4}[-\s]?\d{3,8})\b/;
const INVOICE_RE = /\b(?:inv(?:oice)?|bill|doc(?:ument)?)\s*(?:no\.?|number|#)?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-/]{2,24})\b/i;
const DATE_RE = /\b(\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})\b/;

const DOSAGE_FORMS = [
	{ form: 'tablet', re: /\b(tabs?|tablets?)\b/i },
	{ form: 'capsule', re: /\b(caps?|capsules?)\b/i },
	{ form: 'syrup', re: /\b(syrups?)\b/i },
	{ form: 'suspension', re: /\b(suspensions?)\b/i },
	{ form: 'injection', re: /\b(injections?|inj\.?)\b/i },
	{ form: 'cream', re: /\b(creams?)\b/i },
	{ form: 'ointment', re: /\b(ointments?)\b/i },
	{ form: 'gel', re: /\b(gels?)\b/i },
	{ form: 'drops', re: /\b(drops?)\b/i },
	{ form: 'inhaler', re: /\b(inhalers?)\b/i },
];

/** Confidence below which a value is surfaced for human review. */
const LOW_CONFIDENCE = 0.6;

const textOf = (row, key) => {
	const entry = row && row.values ? row.values[key] : null;
	return entry && entry.text ? entry.text.trim() : '';
};

const confidenceOf = (row, key) => {
	const entry = row && row.values ? row.values[key] : null;
	return entry && Number.isFinite(entry.confidence) ? entry.confidence : null;
};

/**
 * Parses a printed money amount.
 *
 * Tills are inconsistent about separators, so both are accepted: "1,250.50",
 * "1.250,50" and "1250.50" all mean the same thing, while a lone trailing
 * group of exactly three digits after a comma is a thousands separator
 * ("1,250") rather than a decimal point.
 */
/**
 * A date slipping into a numeric column is the classic symptom of a merged or
 * misaligned cell. Parsing "31/12/2027" as a quantity of 31 is far worse than
 * returning nothing, so numeric parsing refuses anything date-shaped.
 */
const DATE_LIKE_RE = /\d{1,4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,4}/;

const parseMoney = (raw) => {
	const text = String(raw || '').trim();
	if (!text) return null;
	if (DATE_LIKE_RE.test(text)) return null;
	const cleaned = text.replace(/[^\d.,\-]/g, '');
	if (!cleaned) return null;
	const negative = cleaned.startsWith('-');
	const digits = cleaned.replace(/-/g, '');
	if (!/\d/.test(digits)) return null;

	const lastDot = digits.lastIndexOf('.');
	const lastComma = digits.lastIndexOf(',');
	let decimalIndex = -1;
	if (lastDot >= 0 && lastComma >= 0) decimalIndex = Math.max(lastDot, lastComma);
	else if (lastDot >= 0) decimalIndex = lastDot;
	else if (lastComma >= 0) decimalIndex = digits.length - lastComma - 1 <= 2 ? lastComma : -1;

	let integerPart = decimalIndex >= 0 ? digits.slice(0, decimalIndex) : digits;
	const fractionPart = decimalIndex >= 0 ? digits.slice(decimalIndex + 1) : '';
	integerPart = integerPart.replace(/[.,]/g, '');

	const fraction = fractionPart.replace(/[.,]/g, '');
	if (fraction && !/^\d{1,2}$/.test(fraction)) return null;
	const value = Number(`${integerPart || '0'}${fraction ? `.${fraction}` : ''}`);
	if (!Number.isFinite(value)) return null;
	return Number((negative ? -value : value).toFixed(2));
};

const parseQuantity = (raw) => {
	const text = String(raw || '').trim();
	if (!text) return null;
	if (DATE_LIKE_RE.test(text)) return null;
	const match = text.match(/-?\d[\d\s,]*/);
	if (!match || match[0].startsWith('-')) return null;
	const value = Number.parseInt(match[0].replace(/[\s,]/g, ''), 10);
	if (!Number.isInteger(value) || value <= 0 || value >= 100000) return null;
	return value;
};

/**
 * Parses a printed date, reporting ambiguity instead of silently guessing.
 *
 * "05/06/2026" cannot be resolved without knowing the shop's locale, so it is
 * reported as ambiguous and the caller flags it for review rather than storing a
 * date that might be three months out.
 */
const parseReceiptDate = (raw) => {
	const text = String(raw || '').trim();
	const match = text.match(DATE_RE);
	if (!match) return { iso: null, raw: null, ambiguous: false };

	const value = match[1];
	const parts = value.split(/[/\-.]/).map((part) => Number.parseInt(part, 10));
	let year;
	let month;
	let day;
	let ambiguous = false;

	if (parts[0] > 31) {
		[year, month, day] = parts;
	} else if (parts.length === 3 && parts[0] <= 12 && parts[1] <= 12) {
		// Both readings are valid; cannot tell 05/06 from 06/05.
		ambiguous = parts[0] !== parts[1];
		[day, month, year] = parts;
	} else {
		[day, month, year] = parts;
	}

	if (year < 100) year += year < 70 ? 2000 : 1900;
	if (!year || !month || !day || month > 12 || day > 31) return { iso: null, raw: value, ambiguous: true };
	const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
	return { iso, raw: value, ambiguous };
};

const dosageFormOf = (text) => {
	for (const entry of DOSAGE_FORMS) {
		if (entry.re.test(text)) return entry.form;
	}
	return null;
};

/**
 * Learns the article-code shape from the rows that do have a code column.
 *
 * On narrow receipts a long product name overruns the CODE column and the
 * detector returns one box covering both. Rather than inventing a split, the
 * trailing token is only promoted to `article_code` when it matches the pattern
 * the rest of the receipt already established.
 */
const learnCodePattern = (rows, codeKey) => {
	const samples = rows
		.filter((row) => !row.aboveHeader && !row.isTotalRow)
		.map((row) => textOf(row, codeKey))
		.filter(Boolean);
	if (samples.length < 2) return null;
	const prefixLengths = new Set(samples.map((sample) => (sample.match(/^[A-Z]*/i) || [''])[0].length));
	if (prefixLengths.size !== 1) return null;
	const lengths = samples.map((sample) => sample.replace(/[^0-9]/g, '').length);
	const digitLengths = new Set(lengths);
	if (digitLengths.size !== 1) return null;
	const prefixLength = [...prefixLengths][0];
	const digitLength = [...digitLengths][0];
	return (token) => {
		const match = String(token).match(/^([A-Za-z]{1,6})[-\s]?(\d{1,8})$/);
		if (!match) return false;
		return match[1].length === prefixLength && match[2].length === digitLength;
	};
};

/** Reads receipt-level figures out of the totals rows and the metadata rows. */
const extractHeader = (table, ocr) => {
	const header = {
		supplierName: null,
		invoiceNumber: null,
		purchaseDate: null,
		subtotal: null,
		discount: null,
		tax: null,
		total: null,
	};
	const issues = [];

	const metaRows = table.rows.filter((row) => row.aboveHeader);
	for (const row of metaRows) {
		// `label` is the first column's text, so rebuild from distinct cells to
		// avoid saying "APOLLO PHARMACY APOLLO PHARMACY".
		const seen = new Set();
		const parts = [];
		for (const column of table.columns) {
			const value = textOf(row, column.key);
			if (!value || seen.has(value)) continue;
			seen.add(value);
			parts.push(value);
		}
		const text = parts.join(' ').trim();
		if (!text) continue;

		if (!header.supplierName && /[A-Za-z]{4}/.test(text) && !DATE_RE.test(text)) {
			header.supplierName = text;
		}
		const invoice = text.match(INVOICE_RE);
		if (invoice && !header.invoiceNumber) header.invoiceNumber = invoice[1].trim();

		const date = parseReceiptDate(text);
		if (date.iso && !header.purchaseDate) {
			header.purchaseDate = date.iso;
			if (date.ambiguous) issues.push('Receipt date is printed ambiguously (day/month order unknown)');
		}
	}

	// Totals rows carry the figures; the row's own label decides which.
	const figureFor = (labelPattern) => {
		for (const row of table.rows) {
			if (!row.isTotalRow) continue;
			if (!labelPattern.test(normalizeLabel(row.label))) continue;
			for (const column of table.columns) {
				const value = parseMoney(textOf(row, column.key));
				if (value != null) return value;
			}
		}
		return null;
	};
	header.subtotal = figureFor(/^subtotal$/);
	header.discount = figureFor(/^(discount|less|rebate)$/);
	header.tax = figureFor(/^(vat|tax|gst|stamp)$/);
	header.total = figureFor(/^(grandtotal|total|netpayable|amountpayable)$/);

	if (header.subtotal == null) issues.push('Subtotal was not legible');
	if (header.total == null) issues.push('Grand total was not legible');
	if (!header.supplierName) issues.push('Supplier name was not legible');
	if (!header.purchaseDate) issues.push('Purchase date was not legible');

	const confidences = (ocr && Array.isArray(ocr.lines) ? ocr.lines : [])
		.map((line) => line && line.confidence)
		.filter((value) => Number.isFinite(value));
	const confidence = confidences.length ? Math.min(...confidences) : 0;

	return { header, issues, confidence: Number(confidence.toFixed(4)) };
};

/** Builds one line item from a table row. */
const itemFromRow = (row, table, matchesCode) => {
	const issues = [];
	const columnKeys = table.columns.map((column) => column.key);
	const rawProduct = textOf(row, 'product') || textOf(row, columnKeys[0]);
	if (!rawProduct) return null;

	let product = rawProduct;
	let articleCode = textOf(row, 'code');

	// Narrow-receipt repair: a product cell that overran the CODE column.
	if (!articleCode && matchesCode) {
		const tokens = product.split(/\s+/);
		const last = tokens[tokens.length - 1];
		if (tokens.length > 1 && matchesCode(last)) {
			articleCode = last;
			product = tokens.slice(0, -1).join(' ');
			issues.push('Article code was read from the product cell because the columns overlap');
		}
	}

	const strength = product.match(STRENGTH_RE);
	// Batch and expiry are read from their own columns when the receipt has
	// them, and otherwise from the product cell; neither is ever guessed.
	const batchCell = textOf(row, 'batch');
	const expiryCell = textOf(row, 'expiry');
	// A dedicated column already holds the bare value; otherwise it has to be
	// labelled ("Batch: BT-77") inside the product cell.
	const batch = batchCell ? { 1: batchCell.trim() } : product.match(BATCH_RE);
	const expiry = expiryCell ? { 1: expiryCell.trim() } : product.match(EXPIRY_RE);

	const quantity = parseQuantity(textOf(row, 'quantity'));
	const unitPrice = parseMoney(textOf(row, 'unit_price'));
	const printedTotal = parseMoney(textOf(row, 'total'));
	// A receipt that prints VAT per line usually prints a VAT-inclusive line
	// total, so the arithmetic check has to be done on the same basis.
	const printedVat = parseMoney(textOf(row, 'vat'));
	const hasVatColumn = row.values && row.values.vat != null;
	const vatAmount = printedVat != null ? printedVat : null;

	const packSize = parseQuantity(textOf(row, 'pack'));

	const totalCell = textOf(row, 'total');
	if ((totalCell.match(/\d[\d.,]*/g) || []).length > 1) {
		issues.push('More than one number in the total column');
	}

	// Confidence is the weakest link that actually contributed.
	const contributing = ['product', 'code', 'quantity', 'unit_price', 'total']
		.map((key) => confidenceOf(row, key))
		.filter((value) => value != null);
	const confidence = contributing.length ? Math.min(...contributing) : 0;

	if (!articleCode) issues.push('No article code was read');
	if (!batch || !batch[1]) issues.push('No batch number was read');
	if (quantity == null) issues.push('Quantity was not legible');
	if (unitPrice == null) issues.push('Unit price was not legible');
	if (!printedTotal) issues.push('Line total was not legible');
	if (hasVatColumn && vatAmount == null) issues.push('VAT amount was not legible');
	if (confidence < LOW_CONFIDENCE) issues.push(`Low reading confidence (${confidence.toFixed(2)})`);

	// Only derive a line total when the receipt does not print one. When a VAT
	// column is present the printed total includes it, so deriving from
	// quantity x unit price would silently drop the tax.
	const derivable = quantity != null && unitPrice != null
		&& (vatAmount != null || !hasVatColumn);
	const totalPrice = printedTotal != null
		? printedTotal
		: (derivable ? Number((quantity * unitPrice).toFixed(2)) : null);

	return {
		product_name: product,
		productName: product,
		medicine_name: product,
		brand_name: strength ? product.replace(STRENGTH_RE, '').trim() || product : product,
		generic_name: null,
		strength: strength ? `${strength[1]}${strength[2].toLowerCase()}` : null,
		pack_size: packSize,
		article_code: articleCode,
		type: dosageFormOf(product),
		dosage_form: dosageFormOf(product),
		manufacturer: null,
		quantity,
		unit_price: unitPrice,
		total_price: totalPrice,
		vat_amount: vatAmount,
		vat_column: hasVatColumn,
		batch_number: batch ? batch[1] : null,
		expiry_date: expiry ? expiry[1] : null,
		confidence: Number(confidence.toFixed(4)),
		needsReview: issues.length > 0,
		reviewReasons: issues,
		box: row.values.product ? row.values.product.boxes[0] : null,
		rowIndex: row.rowIndex,
	};
};

/**
 * Builds the full extraction from OCR output plus its recovered table.
 *
 * Returns null when there is no table to work from, so the caller can fall back
 * to flat-text parsing instead of pretending a grid was found.
 */
const extractFromTable = (ocr, table) => {
	if (!table || !Array.isArray(table.rows)) return null;

	const { header, issues: headerIssues, confidence: headerConfidence } = extractHeader(table, ocr);
	const codeKey = (table.columns.find((column) => column.key === 'code') || {}).key || 'code';
	const matchesCode = learnCodePattern(table.rows, codeKey);

	const items = [];
	for (const row of table.rows) {
		if (row.aboveHeader || row.isTotalRow) continue;
		const item = itemFromRow(row, table, matchesCode);
		if (item) items.push(item);
	}

	return {
		header,
		items: items.slice(0, 200),
		table: {
			columns: table.columns,
			headerRowIndex: table.headerRowIndex,
		},
		diagnostics: {
			headerIssues,
			headerConfidence,
			itemCount: items.length,
			needsReviewCount: items.filter((item) => item.needsReview).length,
		},
	};
};

module.exports = {
	extractFromTable,
	extractHeader,
	itemFromRow,
	parseMoney,
	parseQuantity,
	parseReceiptDate,
	dosageFormOf,
	learnCodePattern,
	LOW_CONFIDENCE,
	STRENGTH_RE,
	BATCH_RE,
	EXPIRY_RE,
	ARTICLE_CODE_RE,
};
