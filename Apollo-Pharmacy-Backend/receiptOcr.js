const { createWorker } = require('tesseract.js');

const SKIP_LINE = /^(total|sub\s*total|grand\s*total|cash|change|vat|tax|discount|invoice|receipt|bill|date|time|tel|phone|mobile|address|thank|welcome|qty|item|particulars|sl\.?|s\/?n|apollo\s+pharmacy)\b/i;
const STRENGTH_RE = /(\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|ml|iu|%|gm)\b(?:\s*\/\s*\d+(?:\.\d+)?\s*(?:ml|g))?)/i;
const QTY_LABEL_RE = /\b(?:qty|quantity|qnty)[:\s#-]*(\d{1,5})\b/i;
const QTY_UNIT_RE = /\b(\d{1,5})\s*(?:x|pcs?|pieces?|tab(?:let)?s?|cap(?:sule)?s?|box(?:es)?|btl|bottles?|packs?)\b/i;
const BATCH_RE = /(?:batch|b(?:atch)?[\s.\-]*no\.?|lot)[:\s#]*([A-Za-z0-9\-./]+)/i;
const EXPIRY_RE = /(?:exp(?:iry)?|exp\.?\s*date|use\s*before)[:\s]*([0-9]{1,2}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4}|[0-9]{1,2}[\/\-.][0-9]{2,4}|[A-Za-z]{3,9}[\s\-\/]?[0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i;
const PRICE_RE = /(?:tk\.?|bdt|৳)\s*(\d+(?:\.\d{1,2})?)\b/i;
const DOSAGE_FORM_RE = /\b(tablets?|capsules?|syrups?|suspensions?|injections?|salines?|creams?|ointments?|drops?|inhalers?|powders?|sachets?)\b/i;
const MANUFACTURER_RE = /(?:manufacturer|mfr\.?|company|made\s+by)[:\s]+([A-Za-z][A-Za-z0-9 .&-]{1,40})/i;

const DOSAGE_FORM_MAP = {
	tablet: 'Tablet',
	tablets: 'Tablet',
	capsule: 'Capsule',
	capsules: 'Capsule',
	syrup: 'Syrup',
	syrups: 'Syrup',
	suspension: 'Suspension',
	suspensions: 'Suspension',
	injection: 'Injection',
	injections: 'Injection',
	saline: 'Saline',
	salines: 'Saline',
	cream: 'Cream',
	creams: 'Cream',
	ointment: 'Ointment',
	ointments: 'Ointment',
	drop: 'Drops',
	drops: 'Drops',
	inhaler: 'Inhaler',
	inhalers: 'Inhaler',
	powder: 'Powder',
	powders: 'Powder',
	sachet: 'Sachet',
	sachets: 'Sachet',
};

/** Keep OCR under typical Vercel serverless limits so failures can mark FAILED before hard kill. */
const OCR_IMAGE_TIMEOUT_MS = Number.parseInt(process.env.RECEIPT_OCR_TIMEOUT_MS, 10) || 45_000;
const PDF_PARSE_TIMEOUT_MS = Number.parseInt(process.env.RECEIPT_PDF_TIMEOUT_MS, 10) || 15_000;

const cleanLine = (line) => String(line || '')
	.replace(/[|_]+/g, ' ')
	.replace(/\s{2,}/g, ' ')
	.trim();

const withTimeout = (promise, timeoutMs, message) => {
	let timer;
	const timeoutPromise = new Promise((_, reject) => {
		timer = setTimeout(() => {
			const error = new Error(message);
			error.statusCode = 504;
			error.code = 'RECEIPT_OCR_TIMEOUT';
			reject(error);
		}, timeoutMs);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		clearTimeout(timer);
	});
};

const logOcrStep = (step, startedAt, extra = {}) => {
	const elapsedMs = Date.now() - startedAt;
	console.info('[receipt-ocr]', { step, elapsedMs, ...extra });
};

const parseMoney = (raw) => {
	if (raw == null) return null;
	const parsed = Number(String(raw).replace(/,/g, ''));
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

/**
 * Lazy-load pdf-parse only for PDF receipts.
 * pdf-parse@2.x pulls pdfjs-dist which needs browser DOMMatrix and crashes on Vercel/Node.
 * pdf-parse@1.1.1 runs in Node without DOMMatrix / browser PDF.js.
 */
const extractPdfText = async (buffer) => {
	const pdfParse = require('pdf-parse');
	const result = await pdfParse(buffer);
	return typeof result?.text === 'string' ? result.text : '';
};

const ocrImageBuffer = async (buffer, timeoutMs = OCR_IMAGE_TIMEOUT_MS) => {
	const worker = await createWorker('eng', 1, {
		cachePath: process.env.TESS_CACHE_PATH || '/tmp',
		logger: () => {},
	});
	try {
		const text = await withTimeout(
			worker.recognize(buffer).then(({ data }) => data?.text || ''),
			timeoutMs,
			'Receipt processing took too long. Please try again.',
		);
		return text;
	} finally {
		await worker.terminate().catch(() => {});
	}
};

/** Extract receipt-level header fields when visible. Missing values stay null — never invented. */
const parseReceiptHeader = (rawText) => {
	const text = String(rawText || '');
	const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);

	let supplierName = null;
	for (const line of lines.slice(0, 8)) {
		if (SKIP_LINE.test(line)) continue;
		if (/^\d+$/.test(line)) continue;
		if (line.length >= 3 && line.length <= 60 && !STRENGTH_RE.test(line)) {
			supplierName = line;
			break;
		}
	}

	const invoiceMatch = text.match(/(?:invoice|inv|receipt|bill)[\s.#:—-]*([A-Za-z0-9\-\/]+)/i);
	const dateMatch = text.match(/(?:date|dated)[:\s]*([0-9]{1,2}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i)
		|| text.match(/\b([0-9]{1,2}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4})\b/);
	const subtotalMatch = text.match(/sub\s*total[:\s]*([0-9]+(?:\.[0-9]{1,2})?)/i);
	const discountMatch = text.match(/discount[:\s]*([0-9]+(?:\.[0-9]{1,2})?)/i);
	const taxMatch = text.match(/(?:vat|tax)[:\s]*([0-9]+(?:\.[0-9]{1,2})?)/i);
	const totalMatch = text.match(/(?:grand\s*)?total[:\s]*([0-9]+(?:\.[0-9]{1,2})?)/i);

	return {
		supplierName,
		invoiceNumber: invoiceMatch ? invoiceMatch[1].trim() : null,
		purchaseDate: dateMatch ? dateMatch[1].trim() : null,
		subtotal: parseMoney(subtotalMatch?.[1]),
		discount: parseMoney(discountMatch?.[1]),
		tax: parseMoney(taxMatch?.[1]),
		total: parseMoney(totalMatch?.[1]),
	};
};

const normalizeDosageForm = (raw) => {
	if (!raw) return null;
	const key = String(raw).toLowerCase().trim();
	return DOSAGE_FORM_MAP[key] || null;
};

/**
 * Parse OCR text into line items only. Does NOT match against the medicine catalog.
 * Unknown fields remain null/empty — never fabricated.
 */
const parseReceiptText = (rawText) => {
	const lines = String(rawText || '')
		.split(/\r?\n/)
		.map(cleanLine)
		.filter((line) => line.length >= 3);

	const items = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (SKIP_LINE.test(line)) continue;
		if (/^[\d\s.,:\-\/]+$/.test(line)) continue;

		const strengthMatch = line.match(STRENGTH_RE);
		const formMatch = line.match(DOSAGE_FORM_RE) || lines[index + 1]?.match(DOSAGE_FORM_RE);
		const batchMatch = line.match(BATCH_RE) || lines[index + 1]?.match(BATCH_RE) || lines[index + 2]?.match(BATCH_RE);
		const expiryMatch = line.match(EXPIRY_RE) || lines[index + 1]?.match(EXPIRY_RE) || lines[index + 2]?.match(EXPIRY_RE);
		const manufacturerMatch = line.match(MANUFACTURER_RE)
			|| lines[index + 1]?.match(MANUFACTURER_RE)
			|| lines[index + 2]?.match(MANUFACTURER_RE);

		let quantity = null;
		const qtyMatch = line.match(QTY_LABEL_RE) || line.match(QTY_UNIT_RE)
			|| lines[index + 1]?.match(QTY_LABEL_RE) || lines[index + 1]?.match(QTY_UNIT_RE);
		if (qtyMatch) {
			const parsedQty = Number.parseInt(qtyMatch[1], 10);
			if (Number.isInteger(parsedQty) && parsedQty > 0 && parsedQty < 100000) quantity = parsedQty;
		}

		let unitPrice = null;
		const priceMatch = line.match(PRICE_RE) || lines[index + 1]?.match(PRICE_RE);
		if (priceMatch) {
			const parsedPrice = Number(priceMatch[1]);
			if (Number.isFinite(parsedPrice) && parsedPrice >= 0) unitPrice = parsedPrice;
		}

		let medicineName = line
			.replace(BATCH_RE, '')
			.replace(EXPIRY_RE, '')
			.replace(PRICE_RE, '')
			.replace(MANUFACTURER_RE, '')
			.replace(/\bqty[:\s]*\d+\b/ig, '')
			.replace(/\s{2,}/g, ' ')
			.trim();

		if (medicineName.length < 3) continue;
		if (/^\d+$/.test(medicineName)) continue;
		if (medicineName.split(' ').length > 14) continue;
		// Skip pure metadata lines that are not product rows.
		if (/^(manufacturer|mfr\.?|company|batch|exp)\b/i.test(medicineName)) continue;

		const dosageForm = normalizeDosageForm(formMatch?.[1]);
		// Require a medicine signal so supplier/header lines are not treated as items.
		const hasMedicineSignal = Boolean(
			strengthMatch || dosageForm || quantity != null || unitPrice != null || batchMatch || expiryMatch,
		);
		if (!hasMedicineSignal) continue;

		const brandName = medicineName.split(STRENGTH_RE)[0].trim() || medicineName;
		const totalPrice = quantity != null && unitPrice != null
			? Number((quantity * unitPrice).toFixed(2))
			: null;

		const confidence = Math.min(
			0.95,
			0.45
				+ (strengthMatch ? 0.15 : 0)
				+ (quantity != null ? 0.15 : 0)
				+ (batchMatch ? 0.1 : 0)
				+ (expiryMatch ? 0.1 : 0),
		);

		items.push({
			productName: medicineName,
			medicine_name: medicineName,
			brand_name: brandName,
			generic_name: null,
			type: dosageForm,
			dosage_form: dosageForm,
			strength: strengthMatch ? strengthMatch[1].trim() : null,
			manufacturer: manufacturerMatch ? manufacturerMatch[1].trim() : null,
			pack_size: null,
			quantity,
			unit_price: unitPrice,
			total_price: totalPrice,
			batch_number: batchMatch ? batchMatch[1].trim() : null,
			expiry_date: expiryMatch ? expiryMatch[1].trim() : null,
			confidence,
		});
	}

	const deduped = [];
	for (const item of items) {
		const previous = deduped[deduped.length - 1];
		if (previous && previous.medicine_name.toLowerCase() === item.medicine_name.toLowerCase()) {
			if (item.quantity != null && previous.quantity == null) previous.quantity = item.quantity;
			if (item.batch_number && !previous.batch_number) previous.batch_number = item.batch_number;
			if (item.expiry_date && !previous.expiry_date) previous.expiry_date = item.expiry_date;
			if (item.unit_price != null && previous.unit_price == null) previous.unit_price = item.unit_price;
			if (item.total_price != null && previous.total_price == null) previous.total_price = item.total_price;
			if (item.manufacturer && !previous.manufacturer) previous.manufacturer = item.manufacturer;
			if (item.dosage_form && !previous.dosage_form) {
				previous.dosage_form = item.dosage_form;
				previous.type = item.dosage_form;
			}
			continue;
		}
		deduped.push(item);
	}

	return deduped.slice(0, 100);
};

/**
 * OCR/AI extraction only.
 * Does NOT load the medicine catalog.
 * Does NOT match medicines.
 * Does NOT modify stock.
 */
const extractReceiptWithTesseract = async (file) => {
	const overallStartedAt = Date.now();
	const fileBuffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer);
	const mimeType = file.mimetype || 'unknown';
	const byteLength = fileBuffer.length;
	logOcrStep('start', overallStartedAt, { mimeType, byteLength });

	if (!fileBuffer.length) {
		const error = new Error('Could not read this receipt. Please upload a clearer JPG or PNG.');
		error.statusCode = 400;
		throw error;
	}

	let text = '';
	const isPdf = mimeType === 'application/pdf';
	try {
		if (isPdf) {
			const pdfStartedAt = Date.now();
			logOcrStep('pdf_parse_begin', pdfStartedAt, { mimeType, byteLength });
			text = await withTimeout(
				extractPdfText(fileBuffer),
				PDF_PARSE_TIMEOUT_MS,
				'Receipt processing took too long. Please try again.',
			);
			logOcrStep('pdf_parse_done', pdfStartedAt, { textLength: text.trim().length });
			if (!text || text.trim().length < 12) {
				const error = new Error('Scanned PDF OCR is not currently supported. Please upload the receipt as JPG or PNG.');
				error.statusCode = 422;
				throw error;
			}
		} else {
			const ocrStartedAt = Date.now();
			logOcrStep('image_ocr_begin', ocrStartedAt, { mimeType, byteLength });
			text = await ocrImageBuffer(fileBuffer, OCR_IMAGE_TIMEOUT_MS);
			logOcrStep('image_ocr_done', ocrStartedAt, { textLength: String(text || '').trim().length });
		}
	} catch (ocrError) {
		if (ocrError.statusCode) throw ocrError;
		const message = String(ocrError.message || 'unknown error');
		if (/DOMMatrix/i.test(message)) {
			const error = new Error('PDF parsing is misconfigured on the server (browser PDF.js loaded in Node). Re-upload as JPG/PNG, or contact admin after the Node pdf-parse fix is deployed.');
			error.statusCode = 502;
			throw error;
		}
		const looksCorrupt = /invalid pdf|bad xref|pdf structure|password|encrypted|format error|unexpected/i.test(message);
		const error = new Error(
			looksCorrupt
				? 'Could not read this receipt. Please upload a clearer JPG or PNG.'
				: 'AI processing failed. Please retry.',
		);
		error.statusCode = looksCorrupt ? 422 : 502;
		error.cause = ocrError;
		throw error;
	}

	const parseStartedAt = Date.now();
	const header = parseReceiptHeader(text);
	const items = parseReceiptText(text);
	logOcrStep('text_parse_done', parseStartedAt, { itemCount: items.length });
	if (items.length === 0) {
		const error = new Error(
			isPdf
				? 'Scanned PDF OCR is not currently supported. Please upload the receipt as JPG or PNG.'
				: 'Could not read this receipt. Please upload a clearer JPG or PNG.',
		);
		error.statusCode = 422;
		throw error;
	}
	logOcrStep('complete', overallStartedAt, { itemCount: items.length, mimeType });
	return { ...header, items };
};

/** @deprecated Prefer extractReceiptWithTesseract — kept for callers that expect an items array. */
const extractReceiptItemsWithTesseract = async (file) => {
	const result = await extractReceiptWithTesseract(file);
	return result.items;
};

module.exports = {
	extractReceiptWithTesseract,
	extractReceiptItemsWithTesseract,
	parseReceiptText,
	parseReceiptHeader,
	OCR_IMAGE_TIMEOUT_MS,
	PDF_PARSE_TIMEOUT_MS,
};
