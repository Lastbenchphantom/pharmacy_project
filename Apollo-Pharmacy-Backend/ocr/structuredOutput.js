'use strict';

/**
 * Final gate before receipt data reaches a human or the stock ledger.
 *
 * This module never repairs a value. It only:
 *   - enforces the output shape the upload endpoint and Review screen expect,
 *   - strips anything that is not supported by printed evidence,
 *   - records every reason a field needs a human,
 *   - cross-checks the receipt against itself (qty x price vs printed line
 *     total, sum of lines vs printed subtotal) and raises a review flag when
 *     the arithmetic does not add up.
 *
 * A wrong expiry date silently shortens shelf life; a wrong quantity silently
 * corrupts stock. Blank-and-flag beats plausible.
 */

const ITEM_KEYS = [
	'product_name',
	'generic_name',
	'strength',
	'pack_size',
	'quantity',
	'unit_price',
	'total_price',
	'batch_number',
	'expiry_date',
	'confidence',
	'needs_review',
];

const HEADER_KEYS = [
	'supplier_name',
	'invoice_number',
	'purchase_date',
	'subtotal',
	'discount',
	'tax',
	'total',
];

/** Money figures may not disagree by more than this (absolute, or relative). */
const MONEY_TOLERANCE = 0.02;
const MONEY_RELATIVE_TOLERANCE = 0.01;

const isBlank = (value) => value == null || (typeof value === 'string' && !value.trim());

/** Keeps only parseable numbers; anything else becomes null rather than NaN. */
const safeNumber = (value, { integer = false, min = null } = {}) => {
	if (isBlank(value)) return null;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return null;
	if (min != null && parsed < min) return null;
	return integer ? Math.round(parsed) : parsed;
};

const moneyMatches = (a, b) => {
	if (a == null || b == null) return null;
	const difference = Math.abs(a - b);
	const scale = Math.max(Math.abs(a), Math.abs(b));
	return difference <= Math.max(MONEY_TOLERANCE, scale * MONEY_RELATIVE_TOLERANCE);
};

const normalizeExpiry = (raw, reasons) => {
	if (isBlank(raw)) return null;
	const text = String(raw).trim();
	const match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/) || text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
	if (!match) {
		reasons.push(`Expiry "${text}" is not a readable date`);
		return null;
	}
	const [a, b, c] = match.slice(1).map((part) => Number.parseInt(part, 10));
	// A component above 12 cannot be a month, which pins the order for us:
	// "31/12/2027" is 31 December, not an impossible month 31.
	let year;
	let month;
	let day;
	if (a > 31) {
		[year, month, day] = [a, b, c];
	} else if (a > 12) {
		[year, month, day] = [c, b, a];
	} else if (b > 12) {
		[year, month, day] = [c, a, b];
	} else {
		[day, month, year] = [a, b, c];
	}
	if (month < 1 || month > 12 || day < 1 || day > 31) {
		reasons.push(`Expiry "${text}" is not a real calendar date`);
		return null;
	}
	return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/**
 * Validates and normalises one line item.
 *
 * Confidence is clamped to [0, 1] and `needs_review` is forced on for anything
 * the receipt did not actually print, regardless of how confident the
 * recogniser was.
 */
const validateItem = (raw, index) => {
	const reasons = [];
	const source = raw && typeof raw === 'object' ? raw : {};

	const productName = isBlank(source.product_name ?? source.productName) ? null : String(source.product_name ?? source.productName).trim();
	if (!productName) reasons.push('Product name is missing');
	if (productName && productName.length > 120) reasons.push('Product name is implausibly long');

	const strength = isBlank(source.strength) ? null : String(source.strength).trim();
	const genericName = isBlank(source.generic_name) ? null : String(source.generic_name).trim();
	const packSize = safeNumber(source.pack_size, { integer: true, min: 1 });
	const quantity = safeNumber(source.quantity, { integer: true, min: 1 });
	const unitPrice = safeNumber(source.unit_price, { min: 0 });
	const totalPrice = safeNumber(source.total_price, { min: 0 });
	const batchNumber = isBlank(source.batch_number) ? null : String(source.batch_number).trim();
	const expiryDate = normalizeExpiry(source.expiry_date, reasons);

	// An item with no measured confidence is unknown, not zero: claiming zero
	// would flag every item for review while reporting no reason at all.
	const measured = safeNumber(source.confidence);
	const confidence = measured == null ? null : Math.max(0, Math.min(1, measured));

	if (quantity == null) reasons.push('Quantity could not be read');
	if (unitPrice == null) reasons.push('Unit price could not be read');
	if (quantity != null && unitPrice != null && totalPrice != null) {
		// Receipts that print VAT per line also print a VAT-inclusive line total,
		// so the printed tax is added once to quantity x unit price. Comparing
		// against quantity x unit price alone would report every taxed receipt
		// as inconsistent. When a VAT column exists but could not be read the
		// check is skipped rather than guessed, and the extractor has already
		// flagged the unreadable amount.
		const vat = safeNumber(source.vat_amount, { min: 0 });
		const hasVatColumn = source.vat_column === true;
		if (!(hasVatColumn && vat == null)) {
			const expected = Number((quantity * unitPrice + (vat || 0)).toFixed(2));
			if (moneyMatches(expected, totalPrice) === false) {
				reasons.push(`Line total ${totalPrice} does not match ${quantity} x ${unitPrice} plus VAT ${vat || 0} (${expected})`);
			}
		}
	}

	// The expiry gate in the Review screen depends on this being present; if the
	// receipt did not print one the row must never look complete.
	if (!expiryDate) reasons.push('Expiry date is missing or unreadable');

	const needsReview = reasons.length > 0
		|| source.needsReview === true
		|| source.needs_review === true
		|| confidence == null
		|| confidence < 0.6;

	// A review flag with no explanation is useless to whoever has to action it.
	if (needsReview && !reasons.length) reasons.push('Item could not be fully verified');

	const item = {
		product_name: productName,
		generic_name: genericName,
		strength,
		pack_size: packSize,
		quantity,
		unit_price: unitPrice,
		total_price: totalPrice,
		batch_number: batchNumber,
		expiry_date: expiryDate,
		confidence: confidence == null ? null : Number(confidence.toFixed(4)),
		needs_review: needsReview,
		review_reasons: reasons,
		source_box: source.box || null,
		// Aliases the existing upload route and Review screen already read.
		productName,
		medicine_name: productName,
		brand_name: isBlank(source.brand_name) ? productName : String(source.brand_name).trim(),
		article_code: isBlank(source.article_code) ? null : String(source.article_code).trim(),
		dosage_form: isBlank(source.dosage_form ?? source.type) ? null : String(source.dosage_form ?? source.type).trim(),
		type: isBlank(source.dosage_form ?? source.type) ? null : String(source.dosage_form ?? source.type).trim(),
		manufacturer: isBlank(source.manufacturer) ? null : String(source.manufacturer).trim(),
	};
	void index;
	return item;
};

const validateHeader = (raw) => {
	const reasons = [];
	const source = raw && typeof raw === 'object' ? raw : {};

	const header = {
		supplier_name: isBlank(source.supplierName ?? source.supplier_name) ? null : String(source.supplierName ?? source.supplier_name).trim(),
		invoice_number: isBlank(source.invoiceNumber ?? source.invoice_number) ? null : String(source.invoiceNumber ?? source.invoice_number).trim(),
		purchase_date: normalizeExpiry(source.purchaseDate ?? source.purchase_date, reasons),
		subtotal: safeNumber(source.subtotal, { min: 0 }),
		discount: safeNumber(source.discount, { min: 0 }),
		tax: safeNumber(source.tax, { min: 0 }),
		total: safeNumber(source.total, { min: 0 }),
	};

	if (!header.supplier_name) reasons.push('Supplier name is missing');
	if (!header.invoice_number) reasons.push('Receipt number is missing');
	if (!header.purchase_date) reasons.push('Purchase date is missing or unreadable');
	if (header.total == null) reasons.push('Grand total is missing or unreadable');
	return { header, reasons };
};

/**
 * Cross-checks the whole receipt against itself.
 *
 * These are the checks that catch a mis-assigned column: if the printed line
 * totals do not add up to the printed subtotal, some number landed in the wrong
 * cell and a human should look before any of it reaches stock.
 */
const crossCheck = (header, items) => {
	const notes = [];
	const lineTotals = items.map((item) => item.total_price).filter((value) => value != null);
	const sumLines = lineTotals.length ? Number(lineTotals.reduce((sum, value) => sum + value, 0).toFixed(2)) : null;

	// A printed SUBTOTAL is the net (pre-tax) figure, and line totals on a taxed
	// receipt include VAT. Comparing the printed subtotal against gross line
	// totals would always disagree, so the net basis (quantity x unit price) is
	// used, falling back to the printed line totals when unit prices are absent.
	const netLines = items
		.filter((item) => item.quantity != null && item.unit_price != null)
		.map((item) => Number((item.quantity * item.unit_price).toFixed(2)));
	const sumNet = netLines.length ? Number(netLines.reduce((sum, value) => sum + value, 0).toFixed(2)) : null;
	const subtotalBasis = sumNet != null ? sumNet : sumLines;

	// Whether a receipt's SUBTOTAL is net or gross varies by vendor, so only a
	// large discrepancy is treated as a symptom of a column landing in the wrong
	// cell. The printed arithmetic below is the unambiguous check.
	let lineTotalsMatchSubtotal = null;
	if (header.subtotal != null && subtotalBasis != null && header.subtotal > 0) {
		lineTotalsMatchSubtotal = moneyMatches(header.subtotal, subtotalBasis) !== false;
		if (!lineTotalsMatchSubtotal && Math.abs(header.subtotal - subtotalBasis) / header.subtotal > 0.15) {
			notes.push(`Printed subtotal ${header.subtotal} is far from the sum of line totals ${subtotalBasis}; a column may be misaligned`);
		}
	}
	if (header.subtotal != null && header.discount != null && header.tax != null && header.total != null) {
		const expected = Number((header.subtotal - header.discount + header.tax).toFixed(2));
		if (moneyMatches(expected, header.total) === false) {
			notes.push(`Grand total ${header.total} does not match subtotal - discount + VAT (${expected})`);
		}
	}
	if (!items.length) notes.push('No line items were found');
	return { sumLines, lineTotalsMatchSubtotal, notes };
};

/**
 * Builds the validated, schema-stable extraction result.
 *
 * @returns {{items: object[], header: object, needs_review: boolean, review_reasons: string[]}}
 */
const buildStructuredOutput = (extraction) => {
	const source = extraction && typeof extraction === 'object' ? extraction : {};
	const { header, reasons: headerReasons } = validateHeader(source.header);

	const items = (Array.isArray(source.items) ? source.items : [])
		.slice(0, 200)
		.map((item, index) => validateItem(item, index));

	const { sumLines, lineTotalsMatchSubtotal, notes: consistencyNotes } = crossCheck(header, items);

	const missingExpiry = items.filter((item) => !item.expiry_date).length;
	const unreadableTotals = items.filter((item) => item.quantity == null || item.total_price == null).length;

	const reviewReasons = [...headerReasons, ...consistencyNotes];
	if (missingExpiry) reviewReasons.push(`${missingExpiry} of ${items.length} items have no readable expiry date`);
	if (unreadableTotals) reviewReasons.push(`${unreadableTotals} item(s) are missing a quantity or line total`);

	const needsReview = reviewReasons.length > 0 || items.some((item) => item.needs_review);

	return {
		header,
		items,
		needs_review: needsReview,
		review_reasons: reviewReasons,
		// camelCase aliases for the existing upload route and review screen.
		supplierName: header.supplier_name,
		invoiceNumber: header.invoice_number,
		purchaseDate: header.purchase_date,
		subtotal: header.subtotal,
		discount: header.discount,
		tax: header.tax,
		total: header.total,
		summary: {
			item_count: items.length,
			needs_review_count: items.filter((item) => item.needs_review).length,
			missing_expiry_count: missingExpiry,
			sum_of_line_totals: sumLines,
			line_totals_match_subtotal: lineTotalsMatchSubtotal,
		},
	};
};

module.exports = {
	buildStructuredOutput,
	validateItem,
	validateHeader,
	crossCheck,
	normalizeExpiry,
	safeNumber,
	moneyMatches,
	ITEM_KEYS,
	HEADER_KEYS,
	MONEY_TOLERANCE,
};
