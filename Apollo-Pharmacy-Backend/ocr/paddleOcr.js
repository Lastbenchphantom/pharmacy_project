/**
 * PaddleOCR (PP-OCRv5) inference pipeline for Node.
 *
 * Three stages, all preserving geometry:
 *   1. DB text detection  -> quadrilateral regions + detection scores
 *   2. Angle classifier   -> 0deg / 180deg per crop
 *   3. CRNN-CTC recognizer -> text + per-line confidence
 *
 * The result is a structured `lines` array: text, confidence, bounding box and
 * polygon. Nothing is flattened into a plain-text blob, so downstream table
 * reconstruction can still reason about columns and rows.
 */

const {
	decodeReceiptImage,
	renderRaw,
	cropRaw,
	imageSizeOf,
} = require('./imagePreprocess');

// Paddle's default cap of 960 px on the long edge is tuned for scene text. A
// receipt photographed close up is far larger than that, and the downscale
// dissolves the small print that carries the invoice number and date, so the
// cap is raised and made configurable.
const DET_LIMIT_SIDE = Number.parseInt(process.env.PADDLE_OCR_DET_LIMIT_SIDE || '1280', 10);
const DET_LIMIT_TYPE = process.env.PADDLE_OCR_DET_LIMIT_TYPE || 'max';
const DET_THRESHOLD = Number.parseFloat(process.env.PADDLE_OCR_DET_THRESHOLD || '0.5');
const DET_BOX_THRESHOLD = Number.parseFloat(process.env.PADDLE_OCR_DET_BOX_THRESHOLD || '0.5');
const DET_UNCLIP_RATIO = 1.6;
const DET_MIN_SIZE = 3;
const REC_BATCH_SIZE = 8;
const REC_IMAGE_HEIGHT = 48;
// The graph's width axis is dynamic, so crops are fed at their natural aspect
// ratio. A hard 320px cap squeezed long lines down to ~1.3 CTC timesteps per
// character, which shredded them ("PURCHASE RECEIPT" -> "P URCH AS E RE CEI PT").
const REC_IMAGE_WIDTH = 1024;
const CLS_IMAGE_SIZE = [3, 48, 192];
// Orientation is confirmed by the recogniser, not trusted from the classifier.
// A reading this weak is not believable, so the other way round is tried, and a
// swap has to beat the current reading by this margin to be worth accepting.
const FLIP_VERIFY_CONFIDENCE = 0.5;
const FLIP_MARGIN = 0.1;
const ORIENTATION_CONFIDENCE_THRESHOLD = 0.5;

/* ------------------------------------------------------------------ */
/* Tensor helpers                                                       */
/* ------------------------------------------------------------------ */

const ort = () => require('onnxruntime-node');

/**
 * Resamples a raw RGB crop into the fixed recogniser canvas.
 *
 * Two details matter for accuracy and both mirror PaddleOCR's own pipeline:
 *  - the aspect ratio is preserved (width = height * cropRatio, capped), because
 *    stretching a short word across the full 320px canvas wrecks the glyphs;
 *  - resampling is bilinear, since nearest-neighbour drops thin strokes.
 * The unused right-hand strip is padded with mid-grey, which the CTC decoder
 * reads as trailing blanks and discards.
 */
const cropToTensor = (image, targetHeight, targetWidth) => {
	const runtime = ort();
	const plane = new Float32Array(3 * targetHeight * targetWidth).fill(0.5);
	const channels = image.channels || 3;
	const cropRatio = image.height > 0 ? image.width / image.height : 1;
	const contentWidth = Math.min(
		targetWidth,
		Math.max(1, Math.round(targetHeight * cropRatio)),
	);

	const scaleX = image.width / contentWidth;
	const scaleY = image.height / targetHeight;

	for (let y = 0; y < targetHeight; y += 1) {
		const sourceY = Math.min(image.height - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
		const y0 = Math.floor(sourceY);
		const y1 = Math.min(image.height - 1, y0 + 1);
		const wy = sourceY - y0;
		for (let x = 0; x < contentWidth; x += 1) {
			const sourceX = Math.min(image.width - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
			const x0 = Math.floor(sourceX);
			const x1 = Math.min(image.width - 1, x0 + 1);
			const wx = sourceX - x0;
			const offset = y * targetWidth + x;
			for (let c = 0; c < 3; c += 1) {
				const topLeft = image.data[(y0 * image.width + x0) * channels + c];
				const topRight = image.data[(y0 * image.width + x1) * channels + c];
				const bottomLeft = image.data[(y1 * image.width + x0) * channels + c];
				const bottomRight = image.data[(y1 * image.width + x1) * channels + c];
				const top = topLeft + (topRight - topLeft) * wx;
				const bottom = bottomLeft + (bottomRight - bottomLeft) * wx;
				const value = top + (bottom - top) * wy;
				plane[offset + c * targetHeight * targetWidth] = (value / 255 - 0.5) / 0.5;
			}
		}
	}
	return new runtime.Tensor('float32', plane, [1, 3, targetHeight, targetWidth]);
};

/** Same treatment as `cropToTensor`, but for a batch padded to one shared width. */
const cropsToBatchTensor = (images, targetHeight, targetWidth) => {
	const runtime = ort();
	const count = images.length;
	// PaddleOCR batches to the widest member so glyph heights stay comparable.
	const widths = images.map((image) => Math.min(
		targetWidth,
		Math.max(1, Math.round(targetHeight * (image.height > 0 ? image.width / image.height : 1))),
	));
	const batchWidth = Math.max(...widths, 1);
	const singlePlane = targetHeight * batchWidth;
	const data = new Float32Array(count * 3 * singlePlane).fill(0.5);
	for (let index = 0; index < count; index += 1) {
		// Lay out each member on a canvas wide enough for the whole batch.
		const member = cropToTensor(images[index], targetHeight, batchWidth);
		data.set(member.data.subarray(0, 3 * singlePlane), index * 3 * singlePlane);
	}
	// The graph's width axis is dynamic, so declare the real batch stride here.
	return new runtime.Tensor('float32', data, [count, 3, targetHeight, batchWidth]);
};

/* ------------------------------------------------------------------ */
/* Geometry: connected components -> convex hull -> min-area rectangle   */
/* ------------------------------------------------------------------ */

const rotate = (point, pivot, angle) => {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const dx = point[0] - pivot[0];
	const dy = point[1] - pivot[1];
	return [pivot[0] + dx * cos - dy * sin, pivot[1] + dx * sin + dy * cos];
};

const polygonArea = (points) => {
	let sum = 0;
	for (let i = 0; i < points.length; i += 1) {
		const [x0, y0] = points[i];
		const [x1, y1] = points[(i + 1) % points.length];
		sum += x0 * y1 - x1 * y0;
	}
	return Math.abs(sum) / 2;
};

const convexHull = (points) => {
	if (points.length < 3) return [...points];
	const sorted = [...points].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
	const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const lower = [];
	for (const point of sorted) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
		lower.push(point);
	}
	const upper = [];
	for (let i = sorted.length - 1; i >= 0; i -= 1) {
		const point = sorted[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
		upper.push(point);
	}
	lower.pop();
	upper.pop();
	return lower.concat(upper);
};

const axisAlignedRect = (points) => {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const [x, y] of points) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	const width = maxX - minX;
	const height = maxY - minY;
	return {
		points: [
			[minX, minY],
			[maxX, minY],
			[maxX, maxY],
			[minX, maxY],
		],
		width,
		height,
		angle: 0,
		centre: [(minX + maxX) / 2, (minY + maxY) / 2],
	};
};

/** Rotating-calipers minimum-area rectangle over the hull edges. */
const minAreaRect = (points) => {
	const hull = convexHull(points);
	// A single pixel or a straight run of rule pixels has no interior angle to
	// sweep; its bounding box is already optimal.
	if (hull.length < 3) return hull.length ? axisAlignedRect(hull) : null;

	let best = null;
	for (let i = 0; i < hull.length; i += 1) {
		const edge = [hull[i], hull[(i + 1) % hull.length]];
		const angle = Math.atan2(edge[1][1] - edge[0][1], edge[1][0] - edge[0][0]);
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const point of hull) {
			const [x, y] = rotate(point, [0, 0], -angle);
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
		const area = (maxX - minX) * (maxY - minY);
		if (area > 0 && (!best || area < best.area)) {
			// Keep the whole sweep box so the winner can be rebuilt in image space.
			best = { area, minX, maxX, minY, maxY, angle };
		}
	}
	if (!best) return null;

	// The sweep rotates the hull by -angle about the origin to axis-align it, so
	// the box centre has to be rotated by +angle to land back in image space.
	const centre = rotate(
		[(best.minX + best.maxX) / 2, (best.minY + best.maxY) / 2],
		[0, 0],
		best.angle,
	);

	// Report the long side as `width` and fold the difference into the angle so
	// every caller sees one consistent convention.
	let width = best.maxX - best.minX;
	let height = best.maxY - best.minY;
	let angle = best.angle;
	if (height > width) {
		[width, height] = [height, width];
		angle += Math.PI / 2;
	}
	while (angle > Math.PI / 2) angle -= Math.PI;
	while (angle <= -Math.PI / 2) angle += Math.PI;

	const pointsOut = [
		[-width / 2, -height / 2],
		[width / 2, -height / 2],
		[width / 2, height / 2],
		[-width / 2, height / 2],
	].map(([dx, dy]) => {
		const [x, y] = rotate([dx, dy], [0, 0], angle);
		return [x + centre[0], y + centre[1]];
	});
	return { points: pointsOut, width, height, angle, centre };
};

/**
 * PaddleOCR "unclip": pushes every edge outward by `area / perimeter` scaled by
 * the model ratio. DB shrinks the activation region, so without this tall glyphs
 * and descenders get cut off.
 */
const expandRect = (rect, width, height, offset) => {
	const cx = rect.points.reduce((sum, point) => sum + point[0], 0) / rect.points.length;
	const cy = rect.points.reduce((sum, point) => sum + point[1], 0) / rect.points.length;
	const halfWidth = rect.width / 2 + offset;
	const halfHeight = rect.height / 2 + offset;
	const corners = [
		[-halfWidth, -halfHeight],
		[halfWidth, -halfHeight],
		[halfWidth, halfHeight],
		[-halfWidth, halfHeight],
	].map(([dx, dy]) => rotate([dx, dy], [0, 0], rect.angle));
	return {
		points: corners.map(([dx, dy]) => [
			Math.min(width - 1, Math.max(0, cx + dx)),
			Math.min(height - 1, Math.max(0, cy + dy)),
		]),
		width: rect.width + offset * 2,
		height: rect.height + offset * 2,
	};
};

const toAxisAlignedBox = (points) => {
	const xs = points.map((point) => point[0]);
	const ys = points.map((point) => point[1]);
	return {
		x0: Math.max(0, Math.min(...xs)),
		y0: Math.max(0, Math.min(...ys)),
		x1: Math.max(...xs),
		y1: Math.max(...ys),
	};
};

/** 8-connected component labelling over the thresholded probability map. */
const findConnectedComponents = (mask, width, height, minArea) => {
	const labels = new Int32Array(width * height).fill(-1);
	const components = [];
	const stack = new Int32Array(width * height);
	for (let start = 0; start < labels.length; start += 1) {
		if (labels[start] !== -1 || !mask[start]) continue;
		const id = components.length;
		let cursor = 0;
		stack[cursor++] = start;
		labels[start] = id;
		const pixels = [];
		while (cursor > 0) {
			const index = stack[--cursor];
			pixels.push(index);
			const x = index % width;
			const y = (index / width) | 0;
			for (let dy = -1; dy <= 1; dy += 1) {
				for (let dx = -1; dx <= 1; dx += 1) {
					if (!dx && !dy) continue;
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
					const neighbour = ny * width + nx;
					if (labels[neighbour] !== -1 || !mask[neighbour]) continue;
					labels[neighbour] = id;
					stack[cursor++] = neighbour;
				}
			}
		}
		if (pixels.length >= minArea) components.push(pixels);
		else for (const index of pixels) labels[index] = -2;
	}
	return { labels, components };
};

/** Groups per-glyph components that sit on the same text baseline. */
const mergeLineComponents = (components, labels, width) => {
	const boxes = components.map((pixels) => {
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const index of pixels) {
			const x = index % width;
			const y = (index / width) | 0;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
		return {
			box: { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 },
			pixels,
		};
	}).sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);

	const merged = [];
	for (const candidate of boxes) {
		let host = null;
		for (const group of merged) {
			const overlapY = Math.min(group.box.y1, candidate.box.y1) - Math.max(group.box.y0, candidate.box.y0);
			const minHeight = Math.min(group.box.y1 - group.box.y0, candidate.box.y1 - candidate.box.y0);
			if (overlapY <= 0 || overlapY / Math.max(1, minHeight) < 0.5) continue;
			const gap = Math.max(candidate.box.x0 - group.box.x1, group.box.x0 - candidate.box.x1);
			const maxWidth = Math.max(group.box.x1 - group.box.x0, candidate.box.x1 - candidate.box.x0);
			if (gap > maxWidth * 0.6) continue;
			host = group;
			break;
		}
		if (host) {
			host.box.x0 = Math.min(host.box.x0, candidate.box.x0);
			host.box.x1 = Math.max(host.box.x1, candidate.box.x1);
			host.box.y0 = Math.min(host.box.y0, candidate.box.y0);
			host.box.y1 = Math.max(host.box.y1, candidate.box.y1);
			host.pixels = host.pixels.concat(candidate.pixels);
		} else {
			merged.push({ box: candidate.box, pixels: candidate.pixels });
		}
	}
	return { labels, groups: merged };
};

const boxArea = (box) => Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);

/** Axis-aligned bounds of a set of linear pixel indices in a row-major mask. */
const boundingBoxOf = (pixels, mapWidth) => {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const index of pixels) {
		const x = index % mapWidth;
		const y = (index / mapWidth) | 0;
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	return { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
};

const intersectionOverUnion = (a, b) => {
	const intersection = overlapArea(a, b);
	const union = boxArea(a) + boxArea(b) - intersection;
	return union > 0 ? intersection / union : 0;
};

const overlapArea = (a, b) => {
	const x0 = Math.max(a.x0, b.x0);
	const y0 = Math.max(a.y0, b.y0);
	const x1 = Math.min(a.x1, b.x1);
	const y1 = Math.min(a.y1, b.y1);
	return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
};

/** Standard DB unclip ratio: area / perimeter. */
const unclipRatio = (points) => {
	let perimeter = 0;
	for (let i = 0; i < points.length; i += 1) {
		const [x0, y0] = points[i];
		const [x1, y1] = points[(i + 1) % points.length];
		perimeter += Math.hypot(x1 - x0, y1 - y0);
	}
	return perimeter > 0 ? polygonArea(points) / perimeter : 0;
};

/* ------------------------------------------------------------------ */
/* Stage 1: DB text detection                                           */
/* ------------------------------------------------------------------ */

const letterBoxToDetectorInput = async (image) => {
	let scale = 1;
	let targetWidth = image.width;
	let targetHeight = image.height;
	const longEdge = Math.max(targetWidth, targetHeight);
	if (DET_LIMIT_TYPE === 'max' && longEdge > DET_LIMIT_SIDE) {
		scale = DET_LIMIT_SIDE / longEdge;
		targetWidth = Math.max(32, Math.floor(image.width * scale));
		targetHeight = Math.max(32, Math.floor(image.height * scale));
	}
	targetWidth = Math.ceil(targetWidth / 32) * 32;
	targetHeight = Math.ceil(targetHeight / 32) * 32;

	const { data, info } = await require('sharp')(
		Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length),
		{ raw: { width: image.width, height: image.height, channels: image.channels } },
	)
		.resize({ width: targetWidth, height: targetHeight, kernel: 'lanczos3', fit: 'fill' })
		.removeAlpha()
		.toColourspace('srgb')
		.raw()
		.toBuffer({ resolveWithObject: true });

	const runtime = ort();
	const plane = 3 * info.height * info.width;
	const values = new Float32Array(plane).fill(1);
	for (let i = 0, p = 0; i < info.width * info.height; i += 1, p += 3) {
		values[i] = (data[p] / 255 - 0.5) / 0.5;
		values[info.width * info.height + i] = (data[p + 1] / 255 - 0.5) / 0.5;
		values[2 * info.width * info.height + i] = (data[p + 2] / 255 - 0.5) / 0.5;
	}
	return {
		tensor: new runtime.Tensor('float32', values, [1, 3, info.height, info.width]),
		scale: { width: info.width / image.width, height: info.height / image.height },
	};
};

/**
 * Drops printed table rules from the detection map.
 *
 * Receipts are ruled tables, and a rule activates the DB head just like a row of
 * text does. Left in place it welds itself to the nearest line and drags a
 * phantom box across the page. A rule is recognisable by geometry: far shorter
 * than the page's text and far longer than a glyph.
 */
const RULE_ASPECT_RATIO = 8;
const RULE_HEIGHT_RATIO = 0.6;

const removeRuleComponents = (components, labels, mapWidth, mapHeight, mask) => {
	if (components.length < 2) return components;
	const boxes = components.map((pixels) => {
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const index of pixels) {
			const x = index % mapWidth;
			const y = (index / mapWidth) | 0;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
		return { pixels, width: maxX - minX + 1, height: maxY - minY + 1, x0: minX, y0: minY };
	});
	const heights = boxes.map((entry) => entry.height).sort((a, b) => a - b);
	const medianHeight = heights[heights.length >> 1] || 1;
	const heightCutoff = Math.max(2, medianHeight * RULE_HEIGHT_RATIO);
	const kept = [];
	for (const entry of boxes) {
		const isRule = entry.height <= heightCutoff && entry.width >= entry.height * RULE_ASPECT_RATIO;
		if (isRule) {
			for (const index of entry.pixels) {
				mask[index] = 0;
				labels[index] = -2;
			}
			continue;
		}
		kept.push(entry.pixels);
	}
	void mapHeight;
	return kept;
};

/**
 * Runs DB post-processing over the probability map and returns axis-aligned and
 * quadrilateral boxes in original-image pixel coordinates.
 */
const postProcessDetection = (probabilityMap, mapWidth, mapHeight, scale, imageWidth, imageHeight) => {
	const mask = new Uint8Array(mapWidth * mapHeight);
	for (let i = 0; i < mask.length; i += 1) {
		mask[i] = probabilityMap[i] >= DET_THRESHOLD ? 1 : 0;
	}

	const minArea = Math.max(4, Math.round((DET_MIN_SIZE * DET_MIN_SIZE * mapWidth) / 640));
	const { labels, components: detected } = findConnectedComponents(mask, mapWidth, mapHeight, minArea);
	if (!detected.length) return [];
	const components = removeRuleComponents(detected, labels, mapWidth, mapHeight, mask);
	if (!components.length) return [];

	// Deliberately NO line merging here. DB already separates table cells, and
	// welding a row's cells into one box would destroy the column x-ranges the
	// table layer depends on. Word-level boxes are re-joined later, once a row
	// and its columns are known.
	const groups = components.map((pixels) => ({ pixels }));
	const candidates = [];

	for (const group of groups) {
		const box = boundingBoxOf(group.pixels, mapWidth);
		const area = boxArea(box);
		if (area < minArea * 0.5) continue;
		// Detection confidence = mean probability inside the candidate box.
		let scoreSum = 0;
		for (let y = box.y0; y < box.y1; y += 1) {
			for (let x = box.x0; x < box.x1; x += 1) {
				scoreSum += probabilityMap[y * mapWidth + x];
			}
		}
		const score = scoreSum / Math.max(1, box.x1 - box.x0) / Math.max(1, box.y1 - box.y0);
		if (score < DET_BOX_THRESHOLD * 0.5) continue;

		const corners = [
			[box.x0, box.y0],
			[box.x1, box.y0],
			[box.x1, box.y1],
			[box.x0, box.y1],
		];
		const rect = minAreaRect(corners);
		if (!rect || rect.width < 2 || rect.height < 2) continue;
		candidates.push({ rect, score });
	}

	// DB can emit a tight box nested inside a looser one for the same text.
	// Keeping the higher-scoring box and discarding the contained duplicate
	// avoids recognising the same line twice at different heights.
	const kept = [];
	for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
		const candidateBox = toAxisAlignedBox(candidate.rect.points);
		const candidateArea = boxArea(candidateBox);
		const contained = kept.some((existing) => {
			const overlap = intersectionOverUnion(existing.box, candidateBox);
			const cover = overlapArea(existing.box, candidateBox) / Math.max(1, candidateArea);
			return cover > 0.7 || (overlap > 0.5 && cover > 0.45);
		});
		if (contained) continue;
		kept.push({ ...candidate, box: candidateBox });
	}

	return kept.map(({ rect, score, box }) => {
		// Cap the expansion so one noisy blob cannot swallow the whole page.
		const offset = Math.min(unclipRatio(rect.points) * DET_UNCLIP_RATIO, Math.max(rect.width, rect.height));
		const expanded = expandRect(rect, mapWidth, mapHeight, offset);
		const mapPoints = expanded.points;
		const points = mapPoints.map(([x, y]) => [
			Math.max(0, Math.min(imageWidth - 1, x / scale.width)),
			Math.max(0, Math.min(imageHeight - 1, y / scale.height)),
		]);
		const aligned = toAxisAlignedBox(points);
		return {
			box: aligned,
			points,
			score: Number(score.toFixed(4)),
			height: Math.max(aligned.y1 - aligned.y0, 1),
			mapArea: boxArea(box),
		};
	}).filter((region) => (region.box.x1 - region.box.x0) >= 2 && (region.box.y1 - region.box.y0) >= 2);
};

const detectTextRegions = async (buffer) => {
	const models = await require('./paddleModels').getPaddleModels();
	const image = await decodeReceiptImage(buffer);
	const { tensor, scale } = await letterBoxToDetectorInput(image);
	const outputs = await models.det.run({ x: tensor });
	const probabilityMap = outputs[models.det.outputNames[0]].data;
	// Detector output is NCHW: [batch, channels, height, width].
	const [, , mapHeight, mapWidth] = outputs[models.det.outputNames[0]].dims;
	return postProcessDetection(probabilityMap, mapWidth, mapHeight, scale, image.width, image.height);
};

/* ------------------------------------------------------------------ */
/* Stage 2: angle classifier                                            */
/* ------------------------------------------------------------------ */

/** Label 1 means the crop is upside down; the pipeline only flips by 180deg. */
const classifyAngles = async (crops) => {
	if (!crops.length) return [];
	const models = await require('./paddleModels').getPaddleModels();
	const results = [];
	const batchSize = Math.max(1, Math.min(REC_BATCH_SIZE, crops.length));
	for (let start = 0; start < crops.length; start += batchSize) {
		const batch = crops.slice(start, start + batchSize);
		const input = cropsToBatchTensor(batch, CLS_IMAGE_SIZE[1], CLS_IMAGE_SIZE[2]);
		const outputs = await models.cls.run({ x: input });
		const scores = outputs[models.cls.outputNames[0]].data;
		for (let index = 0; index < batch.length; index += 1) {
			results.push(scores[index * 2 + 1] > 0.5 ? 180 : 0);
		}
	}
	return results;
};

/* ------------------------------------------------------------------ */
/* Stage 3: CRNN-CTC recognition                                        */
/* ------------------------------------------------------------------ */

/**
 * Greedy CTC decode. Index 0 (and any padded index) is the blank label.
 *
 * PP-OCRv5 encodes inter-word spaces as an *extended blank run* rather than a
 * dictionary character, so plain argmax decoding glues words together. Every
 * emitted character keeps its timestep, which lets `applySpacingRecovery`
 * reinstate the gaps from geometry alone — no invented characters, just the
 * blank runs the model actually produced.
 */
const decodeCtc = (output, timeSteps, classCount, characters, blankIndex) => {
	const tokens = [];
	let previous = -1;
	let blankRun = 0;

	for (let t = 0; t < timeSteps; t += 1) {
		let bestIndex = 0;
		let bestScore = -Infinity;
		const base = t * classCount;
		for (let c = 0; c < classCount; c += 1) {
			const score = output[base + c];
			if (score > bestScore) {
				bestScore = score;
				bestIndex = c;
			}
		}
		const isBlank = bestIndex === blankIndex || bestIndex >= characters.length;
		if (isBlank) {
			blankRun += 1;
			previous = -1;
			continue;
		}
		if (bestIndex !== previous) {
			const character = characters[bestIndex];
			if (character != null && character !== '') {
				tokens.push({ character, score: bestScore, step: t, blankRun });
			}
		}
		previous = bestIndex;
		blankRun = 0;
	}

	const confidence = tokens.length
		? tokens.reduce((sum, token) => sum + token.score, 0) / tokens.length
		: 0;
	const text = applySpacingRecovery(tokens, timeSteps).replace(/\s+/g, ' ').trim();
	return { text, confidence, tokens };
};

/**
 * Rebuilds word boundaries from where each character actually landed.
 *
 * PP-OCRv5 emits no space token; a word gap shows up only as an unusually long
 * stretch of blank timesteps before the next character. Measuring that blank run
 * directly beats measuring raw timestep distance, because neighbouring glyphs
 * routinely land one step apart while a real space costs several.
 *
 * The threshold is the crop's own median blank run, so it adapts to how densely
 * the particular line happened to pack its glyphs.
 */
const applySpacingRecovery = (tokens, timeSteps) => {
	if (tokens.length < 2) return tokens.map((token) => token.character).join('');
	const gaps = [];
	for (let i = 1; i < tokens.length; i += 1) gaps.push(tokens[i].blankRun);
	const sorted = [...gaps].sort((a, b) => a - b);
	const medianGap = sorted[sorted.length >> 1] || 0;
	// Glyph-to-glyph blank runs wobble by about one step from kerning and
	// hinting, so a space has to clear the baseline by a clear margin.
	const threshold = Math.max(2, medianGap + 2);

	let text = tokens[0].character;
	for (let i = 1; i < tokens.length; i += 1) {
		if (tokens[i].blankRun >= threshold) text += ' ';
		text += tokens[i].character;
	}
	void timeSteps;
	return text;
};

/**
 * Natural recogniser width for a crop: 48px tall at the crop's own aspect ratio.
 *
 * Batching pads every member to the widest one, so mixing a 660px-wide title
 * with a 90px "QTY" would blow the short crop up into mostly-blank canvas and
 * wreck it. Crops are therefore bucketed by natural width and batched only
 * against their own kind; results are written back to their original slots.
 */
const naturalCropWidth = (image, targetHeight) => Math.min(
	REC_IMAGE_WIDTH,
	Math.max(1, Math.round(targetHeight * (image.height > 0 ? image.width / image.height : 1))),
);

const recognizeCrops = async (crops) => {
	if (!crops.length) return [];
	const models = await require('./paddleModels').getPaddleModels();
	const runtime = ort();
	const { characters, blankIndex } = models.dictionary;
	const results = new Array(crops.length);

	const buckets = new Map();
	crops.forEach((image, index) => {
		const width = naturalCropWidth(image, REC_IMAGE_HEIGHT);
		if (!buckets.has(width)) buckets.set(width, []);
		buckets.get(width).push({ image, index });
	});

	for (const [width, members] of buckets) {
		for (let start = 0; start < members.length; start += REC_BATCH_SIZE) {
			const chunk = members.slice(start, start + REC_BATCH_SIZE);
			const input = cropsToBatchTensor(chunk.map((entry) => entry.image), REC_IMAGE_HEIGHT, width);
			const outputs = await models.rec.run({ x: input });
			const output = outputs[models.rec.outputNames[0]].data;
			// Output is [batch, timesteps, classes]; timesteps scale with input width.
			const [, timeSteps, classCount] = outputs[models.rec.outputNames[0]].dims;
			for (let i = 0; i < chunk.length; i += 1) {
				const slice = output.subarray(i * timeSteps * classCount, (i + 1) * timeSteps * classCount);
				results[chunk[i].index] = decodeCtc(slice, timeSteps, classCount, characters, blankIndex);
			}
		}
	}
	return results;
};

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */

/** Reading-order sort: top-to-bottom, then left-to-right within a text line. */
const sortRegions = (regions) => [...regions].sort((a, b) => {
	const heightA = a.box.y1 - a.box.y0;
	const heightB = b.box.y1 - b.box.y0;
	const lineTolerance = Math.max(8, Math.min(heightA, heightB) * 0.6);
	if (Math.abs(a.box.y0 - b.box.y0) > lineTolerance) return a.box.y0 - b.box.y0;
	return a.box.x0 - b.box.x0;
});

/**
 * Full PP-OCR pass over a prepared image.
 *
 * @returns {Promise<{width, height, lines: Array, regions: Array}>}
 */
const recognizeImage = async (buffer) => {
	const image = await decodeReceiptImage(buffer);
	if (!image.width || !image.height) {
		throw Object.assign(new Error('Receipt image could not be decoded'), { statusCode: 422 });
	}

	const regions = await detectTextRegions(buffer);
	if (!regions.length) {
		return { width: image.width, height: image.height, lines: [], regions: [] };
	}

	const sorted = sortRegions(regions);

	// Crops are cut at their natural width so nothing is squashed before the
	// recogniser sees it.
	const size = { width: image.width, height: image.height };
	const crops = [];
	for (const region of sorted) {
		crops.push(await cropRaw(buffer, region.box, size));
	}
	const angles = await classifyAngles(crops);

	// The angle classifier is advisory only. It is fed a fixed 48x192 window, so
	// a long thin line such as "PURCHASE RECEIPT INV-..." gets squeezed several
	// times over and is regularly misread in both directions. Rotating genuinely
	// upright text destroys it, and failing to rotate genuinely upside down text
	// drops it, so a crop is only accepted one way when that reading is clearly
	// better than the other.
	const recognized = await recognizeCrops(crops);
	for (let index = 0; index < sorted.length; index += 1) {
		const claimedFlip = angles[index] === 180;
		const current = recognized[index];
		// Re-check the other orientation whenever the classifier asked for a
		// flip, or when the chosen reading is too weak to trust on its own.
		if (!claimedFlip && current.text && current.confidence >= FLIP_VERIFY_CONFIDENCE) continue;

		const flipped = await decodeReceiptImage(await renderRaw(crops[index], { rotate: 180 }));
		const [alternative] = await recognizeCrops([flipped]);
		if (!alternative) continue;
		const better = current.text
			? alternative.confidence > current.confidence + FLIP_MARGIN
			: alternative.text && alternative.confidence >= FLIP_VERIFY_CONFIDENCE;
		if (!better) continue;
		recognized[index] = alternative;
		// The angle describes the crop as it was found in the image, not how it
		// ended up being read, so adopting the flipped reading means this part of
		// the receipt really was upside down.
		angles[index] = 180;
	}

	const lines = [];
	for (let index = 0; index < sorted.length; index += 1) {
		const region = sorted[index];
		const { text, confidence, tokens } = recognized[index];
		if (!text) continue;
		const detConfidence = Number.isFinite(region.score) ? region.score : 0;
		// Joint confidence: the recogniser is the stronger signal, the detector
		// gates obviously unreliable boxes.
		const jointConfidence = Number((confidence * 0.75 + detConfidence * 0.25).toFixed(4));
		lines.push({
			text,
			confidence: jointConfidence,
			recognitionConfidence: Number(confidence.toFixed(4)),
			detectionConfidence: detConfidence,
			box: {
				x0: Number(region.box.x0.toFixed(2)),
				y0: Number(region.box.y0.toFixed(2)),
				x1: Number(region.box.x1.toFixed(2)),
				y1: Number(region.box.y1.toFixed(2)),
			},
			points: region.points.map(([x, y]) => [Number(x.toFixed(2)), Number(y.toFixed(2))]),
			angle: angles[index],
			height: Number(region.height.toFixed(2)),
			...(process.env.PADDLE_OCR_DEBUG_TOKENS
				? { runs: tokens.map((t) => t.blankRun), steps: tokens.map((t) => t.step) }
				: {}),
		});
	}

	return { width: image.width, height: image.height, lines, regions: sorted };
};

/**
 * Cheap readability probe used by the orientation search: recognises a handful
 * of the largest boxes and returns the mean confidence.
 */
const scoreReadability = async (buffer, boxes) => {
	const models = await require('./paddleModels').getPaddleModels();
	const candidates = [...(boxes || [])]
		.filter((region) => region.score >= ORIENTATION_CONFIDENCE_THRESHOLD)
		.sort((a, b) => boxArea(b.box) - boxArea(a.box))
		.slice(0, 6);
	if (!candidates.length) return 0;
	const size = await imageSizeOf(buffer);
	const crops = [];
	for (const candidate of candidates) {
		crops.push(await cropRaw(buffer, candidate.box, size));
	}
	const input = cropsToBatchTensor(crops, REC_IMAGE_HEIGHT, REC_IMAGE_WIDTH);
	const outputs = await models.rec.run({ x: input });
	const output = outputs[models.rec.outputNames[0]].data;
	const [, timeSteps, classCount] = outputs[models.rec.outputNames[0]].dims;
	let total = 0;
	for (let index = 0; index < crops.length; index += 1) {
		const slice = output.subarray(index * timeSteps * classCount, (index + 1) * timeSteps * classCount);
		total += decodeCtc(slice, timeSteps, classCount, models.dictionary.characters, models.dictionary.blankIndex).confidence;
	}
	return total / crops.length;
};

module.exports = {
	recognizeImage,
	recognizeCrops,
	classifyAngles,
	cropToTensor,
	cropsToBatchTensor,
	detectTextRegions,
	scoreReadability,
	postProcessDetection,
	minAreaRect,
	convexHull,
	findConnectedComponents,
	mergeLineComponents,
	decodeCtc,
	sortRegions,
	DET_THRESHOLD,
	letterBoxToDetectorInput,
	DET_BOX_THRESHOLD,
	REC_IMAGE_HEIGHT,
	REC_IMAGE_WIDTH,
};
