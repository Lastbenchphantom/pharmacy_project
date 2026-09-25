const { createWorker } = require('tesseract.js');
const { PDFParse } = require('pdf-parse');

const SKIP_LINE = /^(total|sub\s*total|grand\s*total|cash|change|vat|tax|discount|invoice|receipt|bill|date|time|tel|phone|mobile|address|thank|welcome|qty|item|particulars|sl\.?|s\/?n|apollo\s+pharmacy)\b/i;
const STRENGTH_RE = /(\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|ml|iu|%|gm)\b(?:\s*\/\s*\d+(?:\.\d+)?\s*(?:ml|g))?)/i;
const QTY_LABEL_RE = /\b(?:qty|quantity|qnty)[:\s#-]*(\d{1,5})\b/i;
const QTY_UNIT_RE = /\b(\d{1,5})\s*(?:x|pcs?|pieces?|tab(?:let)?s?|cap(?:sule)?s?|box(?:es)?|btl|bottles?|packs?)\b/i;
const BATCH_RE = /(?:batch|b(?:atch)?[\s.\-]*no\.?|lot)[:\s#]*([A-Za-z0-9\-./]+)/i;
const EXPIRY_RE = /(?:exp(?:iry)?|exp\.?\s*date|use\s*before)[:\s]*([0-9]{1,2}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4}|[0-9]{1,2}[\/\-.][0-9]{2,4}|[A-Za-z]{3,9}[\s\-\/]?[0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i;
const PRICE_RE = /(?:tk\.?|bdt|৳)\s*(\d+(?:\.\d{1,2})?)\b/i;

const cleanLine = (line) => String(line || '')
	.replace(/[|_]+/g, ' ')
	.replace(/\s{2,}/g, ' ')
	.trim();

const extractPdfText = async (buffer) => {
	const parser = new PDFParse({ data: buffer });
	try {
		const result = await parser.getText();
		if (typeof result === 'string') return result;
		if (result && typeof result.text === 'string') return result.text;
		if (result && Array.isArray(result.pages)) {
			return result.pages.map((page) => page?.text || '').join('\n');
		}
		return '';
	} finally {
		await parser.destroy().catch(() => {});
	}
};

const ocrImageBuffer = async (buffer) => {
	const worker = await createWorker('eng', 1, {
		cachePath: process.env.TESS_CACHE_PATH || '/tmp',
		logger: () => {},
	});
	try {
		const { data } = await worker.recognize(buffer);
		return data?.text || '';
	} finally {
		await worker.terminate().catch(() => {});
	}
};

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
		const batchMatch = line.match(BATCH_RE) || lines[index + 1]?.match(BATCH_RE);
		const expiryMatch = line.match(EXPIRY_RE) || lines[index + 1]?.match(EXPIRY_RE) || lines[index + 2]?.match(EXPIRY_RE);

		let quantity = null;
		const qtyMatch = line.match(QTY_LABEL_RE) || line.match(QTY_UNIT_RE)
			|| lines[index + 1]?.match(QTY_LABEL_RE) || lines[index + 1]?.match(QTY_UNIT_RE);
		if (qtyMatch) {
			const parsedQty = Number.parseInt(qtyMatch[1], 10);
			if (Number.isInteger(parsedQty) && parsedQty > 0 && parsedQty < 100000) quantity = parsedQty;
		}

		let unitPrice = null;
		const priceMatch = line.match(PRICE_RE);
		if (priceMatch) {
			const parsedPrice = Number(priceMatch[1]);
			if (Number.isFinite(parsedPrice) && parsedPrice >= 0) unitPrice = parsedPrice;
		}

		let medicineName = line
			.replace(BATCH_RE, '')
			.replace(EXPIRY_RE, '')
			.replace(PRICE_RE, '')
			.replace(/\bqty[:\s]*\d+\b/ig, '')
			.replace(/\s{2,}/g, ' ')
			.trim();

		if (medicineName.length < 3) continue;
		if (/^\d+$/.test(medicineName)) continue;
		// Skip lines that look like addresses or pure metadata
		if (medicineName.split(' ').length > 14) continue;

		const confidence = Math.min(
			0.95,
			0.45
				+ (strengthMatch ? 0.15 : 0)
				+ (quantity != null ? 0.15 : 0)
				+ (batchMatch ? 0.1 : 0)
				+ (expiryMatch ? 0.1 : 0),
		);

		items.push({
			medicine_name: medicineName,
			brand_name: medicineName.split(STRENGTH_RE)[0].trim() || medicineName,
			generic_name: null,
			strength: strengthMatch ? strengthMatch[1].trim() : null,
			dosage_form: null,
			pack_size: null,
			quantity,
			unit_price: unitPrice,
			total_price: null,
			batch_number: batchMatch ? batchMatch[1].trim() : null,
			expiry_date: expiryMatch ? expiryMatch[1].trim() : null,
			confidence,
		});
	}

	// Deduplicate near-identical consecutive names
	const deduped = [];
	for (const item of items) {
		const previous = deduped[deduped.length - 1];
		if (previous && previous.medicine_name.toLowerCase() === item.medicine_name.toLowerCase()) {
			if (item.quantity != null && previous.quantity == null) previous.quantity = item.quantity;
			if (item.batch_number && !previous.batch_number) previous.batch_number = item.batch_number;
			if (item.expiry_date && !previous.expiry_date) previous.expiry_date = item.expiry_date;
			if (item.unit_price != null && previous.unit_price == null) previous.unit_price = item.unit_price;
			continue;
		}
		deduped.push(item);
	}

	return deduped.slice(0, 100);
};

const extractReceiptItemsWithTesseract = async (file) => {
	const fileBuffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer);
	if (!fileBuffer.length) {
		const error = new Error('Uploaded receipt file data is empty');
		error.statusCode = 400;
		throw error;
	}

	let text = '';
	const isPdf = file.mimetype === 'application/pdf';
	try {
		if (isPdf) {
			text = await extractPdfText(fileBuffer);
			if (!text || text.trim().length < 12) {
				const error = new Error('This PDF has little readable text. Export or photograph the receipt as JPG/PNG and upload again for OCR.');
				error.statusCode = 422;
				throw error;
			}
		} else {
			text = await ocrImageBuffer(fileBuffer);
		}
	} catch (ocrError) {
		if (ocrError.statusCode) throw ocrError;
		const error = new Error(`Receipt OCR failed: ${ocrError.message || 'unknown error'}`);
		error.statusCode = 502;
		throw error;
	}

	const items = parseReceiptText(text);
	if (items.length === 0) {
		const error = new Error('OCR could not find medicine lines on this receipt. Try a clearer photo or enter items manually after upload.');
		error.statusCode = 422;
		throw error;
	}
	return items;
};

module.exports = {
	extractReceiptItemsWithTesseract,
	parseReceiptText,
};
