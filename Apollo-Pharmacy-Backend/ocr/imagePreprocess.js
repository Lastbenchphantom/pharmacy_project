const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Receipt image preprocessing.
 *
 * The uploaded bytes are never mutated: preprocessing produces temporary,
 * derived buffers that live in the OS temp directory and are removed once OCR
 * finishes. Callers keep the original image for storage/re-display.
 *
 * Rotation and skew are resolved from *text geometry* rather than blind
 * heuristics: the caller injects a text-region detector, and the rotation that
 * yields the most horizontal, confidently readable text wins.
 */

const DEFAULT_OPTIONS = {
	// Target long edge for the OCR pass. PaddleOCR mobile det is trained at 640px;
	// feeding tiny receipts at native size wastes accuracy on small print.
	targetLongEdge: 1600,
	maxLongEdge: 3200,
	// Small print needs magnification; below this median glyph height we upscale.
	minMedianTextHeight: 26,
	// Low-contrast stretch is applied when the ink/paper spread is thin.
	minContrastSpread: 42,
	// Fraction of near-paper pixels above which the page counts as noisy.
	noiseThreshold: 0.18,
	// Extra deskew correction is only applied inside this tolerance; larger angles
	// mean the detector was reading rotated columns, not a skewed page.
	maxDeskewDegrees: 12,
	enableDenoise: true,
	enableSharpen: true,
	hardThreshold: false,
};

/** Decode to raw RGB, honouring EXIF orientation so phone photos are upright. */
const decodeReceiptImage = async (buffer) => {
	const sharp = require('sharp');
	const { data, info } = await sharp(buffer)
		.rotate() // EXIF transpose; no-op when the orientation tag is absent
		.removeAlpha()
		.toColourspace('srgb')
		.raw()
		.toBuffer({ resolveWithObject: true });
	return { data: new Uint8Array(data), width: info.width, height: info.height, channels: info.channels };
};

/** Rec. 709 luma plane for the supplied raw RGB pixels. */
const toLuminance = ({ data, width, height }, channels = 3) => {
	const luminance = new Float32Array(width * height);
	for (let i = 0, p = 0; i < luminance.length; i += 1, p += channels) {
		luminance[i] = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
	}
	return luminance;
};

/**
 * Characterises a page as ink-on-paper.
 *
 * A plain 5th/95th percentile is useless here: a receipt is ~97% white, so both
 * percentiles land in the paper and every clean scan looks "low contrast".
 * Instead the dark-pixel fraction is measured first, and the levels are sampled
 * from the middle of the ink and paper populations respectively.
 */
const analyseTone = (luminance) => {
	const bins = new Uint32Array(256);
	for (let i = 0; i < luminance.length; i += 1) {
		bins[Math.min(255, Math.max(0, Math.round(luminance[i] * 255)))] += 1;
	}
	const total = luminance.length || 1;
	const at = (fraction) => {
		let seen = 0;
		const target = Math.max(1, total * fraction);
		for (let bin = 0; bin < 256; bin += 1) {
			seen += bins[bin];
			if (seen >= target) return bin / 255;
		}
		return 1;
	};

	let darkPixels = 0;
	for (let bin = 0; bin < 128; bin += 1) darkPixels += bins[bin];
	const darkFraction = darkPixels / total;

	if (darkFraction < 0.0005) {
		return { low: 1, high: 1, spread: 0, darkFraction, noise: 0, blank: true };
	}

	const low = at(darkFraction * 0.5);
	const high = at(1 - darkFraction * 0.5);
	// Sensor noise and JPEG mush pile pixels up between the ink and paper
	// levels. A clean scan is bimodal — only anti-aliased glyph edges live in
	// that middle band — so its mid-tone share stays small.
	const lowBin = Math.round(low * 255);
	const highBin = Math.round(high * 255);
	const band = Math.max(1, Math.round((highBin - lowBin) * 0.1));
	let midPixels = 0;
	for (let bin = lowBin + band; bin <= highBin - band; bin += 1) midPixels += bins[bin];
	const noise = midPixels / total;

	return {
		low,
		high,
		spread: (high - low) * 255,
		darkFraction,
		noise,
		blank: false,
	};
};

const median = (values) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Renders raw RGB to a PNG buffer, applying the requested geometric and
 * photometric corrections.
 */
const renderRaw = async (image, {
	rotate = 0,
	background = '#ffffff',
	grayscale = false,
	normalize = false,
	linear = null,
	median = 3,
	sharpen = false,
	threshold = 0,
	upscale = 1,
} = {}) => {
	const sharp = require('sharp');
	let pipeline = sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length), {
		raw: { width: image.width, height: image.height, channels: image.channels },
	});

	if (upscale && upscale !== 1) {
		pipeline = pipeline.resize({
			width: Math.max(1, Math.round(image.width * upscale)),
			height: Math.max(1, Math.round(image.height * upscale)),
			kernel: 'lanczos3',
		});
	}
	if (grayscale) pipeline = pipeline.grayscale();
	if (median && median > 1) pipeline = pipeline.median(median);
	if (normalize) pipeline = pipeline.normalize({ lower: 1, upper: 99 });
	if (linear) pipeline = pipeline.linear(linear[0], linear[1]);
	if (sharpen) pipeline = pipeline.sharpen({ sigma: 1, m1: 0.4, m2: 1.2 });
	if (threshold) pipeline = pipeline.threshold(Math.round(threshold * 255));

	if (rotate) {
		pipeline = pipeline.rotate(rotate, { background });
	}
	return pipeline.png({ compressionLevel: 6 }).toBuffer();
};

/** PNG/JPEG buffers are re-read by several crops; metadata lookups are cached. */
const metadataCache = new WeakMap();

/**
 * Extracts a cropped, axis-aligned region as raw RGB for recognition.
 *
 * @param {Buffer} source encoded image or raw pixel container
 * @param {{x0:number,y0:number,x1:number,y1:number}} box region in source pixels
 * @param {{width:number,height:number}} [size] known source dimensions
 */
const cropRaw = async (source, box, size) => {
	const sharp = require('sharp');
	const bounds = size || await imageSizeOf(source);
	const left = Math.max(0, Math.floor(box.x0));
	const top = Math.max(0, Math.floor(box.y0));
	const right = Math.min(bounds.width, Math.ceil(box.x1));
	const bottom = Math.min(bounds.height, Math.ceil(box.y1));
	const width = Math.max(1, right - left);
	const height = Math.max(1, bottom - top);
	const { data } = await sharp(source)
		.extract({ left, top, width, height })
		.removeAlpha()
		.toColourspace('srgb')
		.raw()
		.toBuffer({ resolveWithObject: true });
	return { data: new Uint8Array(data), width, height, channels: 3 };
};

/** Resolves (and memoises) the pixel dimensions of an encoded image. */
const imageSizeOf = async (source) => {
	if (source && typeof source === 'object' && source.width && source.height) {
		return { width: source.width, height: source.height };
	}
	const cached = metadataCache.get(source);
	if (cached) return cached;
	const sharp = require('sharp');
	const metadata = await sharp(source).metadata();
	const size = { width: metadata.width, height: metadata.height };
	metadataCache.set(source, size);
	return size;
};

/**
 * Ranks candidate quarter-turns by how much *horizontal, readable* text they
 * expose. A receipt photographed sideways yields tall vertical boxes, so the
 * aspect-ratio term alone separates 0/180 from 90/270; recognition confidence
 * (injected by the caller) then separates 0 from 180.
 */
const scoreOrientation = (boxes, meanRecognitionConfidence) => {
	let horizontal = 0;
	let horizontalWidth = 0;
	for (const box of boxes) {
		const width = box.x1 - box.x0;
		const height = box.y1 - box.y0;
		if (height <= 0 || width <= 0) continue;
		if (width >= height * 1.5) {
			horizontal += 1;
			horizontalWidth += width;
		}
	}
	return horizontal * 1000 + horizontalWidth / 100 + (meanRecognitionConfidence || 0) * 50;
};

/**
 * Median long-axis tilt of the detected text boxes, in degrees.
 * Returns 0 when the page is already level.
 */
const estimateSkew = (boxes) => {
	const angles = [];
	for (const box of boxes) {
		const points = box.points && box.points.length >= 4 ? box.points : null;
		let angle = null;
		if (points) {
			// Use the top edge: for a text line this is the dominant near-horizontal edge.
			const [p0, p1] = [points[0], points[1]];
			const dx = p1[0] - p0[0];
			const dy = p1[1] - p0[1];
			const length = Math.hypot(dx, dy);
			if (length > 1) angle = (Math.atan2(dy, dx) * 180) / Math.PI;
		} else {
			const width = box.x1 - box.x0;
			const height = box.y1 - box.y0;
			if (width > 0 && height > 0 && width >= height) angle = 0;
		}
		if (angle == null || !Number.isFinite(angle)) continue;
		// Only near-horizontal edges describe page skew; steeper edges belong to
		// vertical separators or single characters.
		if (Math.abs(angle) > DEFAULT_OPTIONS.maxDeskewDegrees) continue;
		angles.push(angle);
	}
	const value = median(angles);
	return value && Math.abs(value) >= 0.3 ? value : 0;
};

/** Scale needed so the smallest text reaches a recognisable glyph height. */
const resolveUpscale = (medianTextHeight) => {
	if (!medianTextHeight || !Number.isFinite(medianTextHeight)) return 1;
	const { minMedianTextHeight } = DEFAULT_OPTIONS;
	if (medianTextHeight >= minMedianTextHeight) return 1;
	return Math.min(4, Math.max(1, minMedianTextHeight / medianTextHeight));
};

/**
 * Full preparation pass.
 *
 * @param {Buffer} buffer original uploaded image (left untouched)
 * @param {object} deps
 * @param {(buffer: Buffer) => Promise<Array>} deps.detectTextRegions text-region detector
 * @param {(buffer: Buffer, boxes: Array) => Promise<number>} deps.scoreReadability
 * @returns {Promise<{buffer: Buffer, width: number, height: number, transforms: object}>}
 */
const prepareReceiptImage = async (buffer, deps = {}) => {
	const { detectTextRegions, scoreReadability } = deps;
	const transforms = {
		exifOrientationApplied: true,
		quarterTurns: 0,
		deskewDegrees: 0,
		upscaled: false,
		contrastStretched: false,
		denoised: false,
		sharpenApplied: false,
		binarized: false,
	};

	const original = await decodeReceiptImage(buffer);
	transforms.sourceSize = { width: original.width, height: original.height };

	// --- Step 1: pick the quarter-turn using cheap text geometry + readability ---
	const orientationProbe = await renderRaw(original, {
		grayscale: true,
		normalize: true,
		upscale: resolveProbeScale(original),
	});

	let bestRotation = { degrees: 0, score: -1 };
	if (typeof detectTextRegions === 'function') {
		for (const degrees of [0, 90, 180, 270]) {
			let candidate;
			try {
				candidate = degrees === 0
					? orientationProbe
					: await renderRaw(original, {
						rotate: degrees,
						grayscale: true,
						normalize: true,
						upscale: resolveProbeScale(original),
					});
			} catch {
				continue;
			}
			let boxes = [];
			try {
				boxes = await detectTextRegions(candidate);
			} catch {
				boxes = [];
			}
			const readability = typeof scoreReadability === 'function'
				? await scoreReadability(candidate, boxes).catch(() => 0)
				: 0;
			const score = scoreOrientation(boxes, readability);
			if (score > bestRotation.score) bestRotation = { degrees, score };
		}
	}
	transforms.quarterTurns = bestRotation.degrees;

	const oriented = bestRotation.degrees
		? await renderRaw(original, { rotate: bestRotation.degrees })
		: original;

	// --- Step 2: geometry-scale the page so small print survives detection ---
	const longEdge = Math.max(oriented.width, oriented.height);
	const pageScale = longEdge > DEFAULT_OPTIONS.maxLongEdge
		? DEFAULT_OPTIONS.maxLongEdge / longEdge
		: longEdge < DEFAULT_OPTIONS.targetLongEdge
			? Math.min(2.5, DEFAULT_OPTIONS.targetLongEdge / longEdge)
			: 1;

	// --- Step 3: deskew, measured from the text boxes on the oriented page ---
	let deskewDegrees = 0;
	if (typeof detectTextRegions === 'function') {
		try {
			const pageProbe = await renderRaw(oriented, {
				grayscale: true,
				normalize: true,
				upscale: pageScale,
			});
			const boxes = await detectTextRegions(pageProbe);
			deskewDegrees = estimateSkew(boxes);
		} catch {
			deskewDegrees = 0;
		}
	}
	transforms.deskewDegrees = Number(deskewDegrees.toFixed(2));

	// --- Step 4: photometric corrections (contrast / noise / small print) ---
	const tone = analyseTone(toLuminance(oriented));
	const needsStretch = tone.spread < DEFAULT_OPTIONS.minContrastSpread;
	transforms.contrastStretched = needsStretch;
	// Median filtering costs sharpness, so it is only paid for when the paper
	// actually carries a noise haze.
	transforms.denoised = tone.noise > DEFAULT_OPTIONS.noiseThreshold;
	transforms.sharpenApplied = DEFAULT_OPTIONS.enableSharpen;
	transforms.binarized = Boolean(DEFAULT_OPTIONS.hardThreshold);
	transforms.tone = {
		spread: Number(tone.spread.toFixed(1)),
		darkFraction: Number(tone.darkFraction.toFixed(4)),
		noise: Number(tone.noise.toFixed(4)),
	};

	const textUpscale = await resolveTextUpscale(oriented, pageScale, detectTextRegions);
	transforms.upscaled = textUpscale !== 1;
	transforms.upscaleFactor = Number((pageScale * textUpscale).toFixed(3));

	const processed = await renderRaw(oriented, {
		rotate: -deskewDegrees,
		grayscale: true,
		normalize: !needsStretch,
		linear: needsStretch ? [1.15, -(tone.low * 255 - 18)] : null,
		median: transforms.denoised ? 3 : 1,
		sharpen: transforms.sharpenApplied,
		threshold: transforms.binarized ? 0.55 : 0,
		upscale: pageScale * textUpscale,
	});

	const finalImage = await decodeReceiptImage(processed);
	return {
		buffer: processed,
		width: finalImage.width,
		height: finalImage.height,
		transforms,
	};
};

const resolveProbeScale = (image) => {
	const longEdge = Math.max(image.width, image.height);
	if (longEdge <= 960) return 1;
	return 960 / longEdge;
};

/** Magnifies further when the detected glyphs are still below recognisable size. */
const resolveTextUpscale = async (oriented, pageScale, detectTextRegions) => {
	if (typeof detectTextRegions !== 'function' || pageScale >= 1) return 1;
	try {
		const probe = await renderRaw(oriented, { grayscale: true, normalize: true, upscale: pageScale });
		const boxes = await detectTextRegions(probe);
		const heights = boxes
			.map((box) => box.y1 - box.y0)
			.filter((height) => height > 2 && height < 400);
		return resolveUpscale(median(heights));
	} catch {
		return 1;
	}
};

/**
 * Writes a processed image to a temp file and returns a disposer.
 * Originals stay untouched; callers rely on `cleanup()` in a finally block.
 */
const withTemporaryImage = (buffer, prefix = 'apollo-receipt-') => {
	const temporaryPath = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 10)}.png`);
	fs.writeFileSync(temporaryPath, buffer);
	let removed = false;
	return {
		path: temporaryPath,
		cleanup() {
			if (removed) return;
			removed = true;
			try {
				fs.unlinkSync(temporaryPath);
			} catch {
				/* best effort — the OS temp directory is swept anyway */
			}
		},
	};
};

module.exports = {
	DEFAULT_OPTIONS,
	imageSizeOf,
	prepareReceiptImage,
	decodeReceiptImage,
	renderRaw,
	cropRaw,
	toLuminance,
	analyseTone,
	estimateSkew,
	scoreOrientation,
	resolveUpscale,
	withTemporaryImage,
	median,
};
