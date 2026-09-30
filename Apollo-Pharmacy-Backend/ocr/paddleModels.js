const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

/**
 * PaddleOCR (PP-OCRv5) ONNX model management.
 *
 * The backend runs as a serverless function, so the ONNX graphs are fetched once
 * into a cache directory and reused across cold starts. Everything is lazy: the
 * public medicine routes never touch onnxruntime-node.
 */

const DEFAULT_BASE_URL = 'https://huggingface.co/bukuroo/PPOCRv5-ONNX/resolve/main';

const MODEL_FILES = {
	det: { remote: 'ppocrv5-mobile-det.onnx', local: 'ppocrv5_mobile_det.onnx' },
	rec: { remote: 'ppocrv5-mobile-rec.onnx', local: 'ppocrv5_mobile_rec.onnx' },
	cls: { remote: 'ppocrv5-cls.onnx', local: 'ppocrv5_cls.onnx' },
	dict: { remote: 'ppocrv5_dict.txt', local: 'ppocrv5_dict.txt' },
};

const MODEL_LABELS = {
	det: 'PP-OCRv5 mobile text detector (DB)',
	rec: 'PP-OCRv5 mobile text recognizer (CRNN-CTC)',
	cls: 'PP-OCRv5 mobile text angle classifier',
	dict: 'PP-OCRv5 recognition dictionary',
};

let cached = null;
let inflight = null;

const isTruthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

/** Cache dir preference: explicit config -> repo models dir -> OS temp dir. */
const resolveModelDir = () => {
	const configured = String(process.env.PADDLE_OCR_MODEL_DIR || '').trim();
	if (configured) return configured;
	const repoLocal = path.join(__dirname, '..', 'models', 'paddleocr');
	try {
		fs.mkdirSync(repoLocal, { recursive: true });
		fs.accessSync(repoLocal, fs.constants.W_OK);
		return repoLocal;
	} catch {
		return path.join(os.tmpdir(), 'apollo-paddleocr-models');
	}
};

const resolveRemoteUrl = (kind, remoteName) => {
	const perModel = String(process.env[`PADDLE_OCR_${kind.toUpperCase()}_URL`] || '').trim();
	if (perModel) return perModel;
	const base = String(process.env.PADDLE_OCR_MODEL_BASE_URL || '').trim() || DEFAULT_BASE_URL;
	return `${base.replace(/\/+$/, '')}/${remoteName}`;
};

const downloadToFile = async (url, destination, timeoutMs) => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
		const buffer = Buffer.from(await response.arrayBuffer());
		if (!buffer.length) throw new Error(`Empty response for ${url}`);
		const temporary = `${destination}.${process.pid}.part`;
		await fsp.writeFile(temporary, buffer);
		await fsp.rename(temporary, destination);
		return buffer.length;
	} finally {
		clearTimeout(timer);
	}
};

/**
 * Ensures every model artefact exists on disk, downloading whatever is missing.
 * Partial writes land on a `.part` file first so a killed cold start cannot
 * leave a truncated ONNX graph behind.
 */
const ensureModels = async () => {
	const modelDir = resolveModelDir();
	await fsp.mkdir(modelDir, { recursive: true });

	const timeoutMs = Number.parseInt(process.env.PADDLE_OCR_DOWNLOAD_TIMEOUT_MS, 10) || 180_000;
	const offline = isTruthy(process.env.PADDLE_OCR_OFFLINE);
	const paths = {};

	for (const [kind, spec] of Object.entries(MODEL_FILES)) {
		const destination = path.join(modelDir, spec.local);
		paths[kind] = destination;
		if (fs.existsSync(destination) && fs.statSync(destination).size > 0) continue;
		if (offline) {
			throw new Error(`PaddleOCR ${kind} model is missing at ${destination} and PADDLE_OCR_OFFLINE is set`);
		}
		await downloadToFile(resolveRemoteUrl(kind, spec.remote), destination, timeoutMs);
	}

	paths.dir = modelDir;
	return paths;
};

const loadDictionary = async (dictPath) => {
	const raw = await fsp.readFile(dictPath, 'utf8');
	// Shipped dictionaries are CRLF with a trailing newline; keep the trailing
	// full-width space that PaddleOCR reserves as its first real character.
	const entries = raw.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
	// CTC reserves index 0 for the blank label, so characters shift up by one.
	// Anything past the dictionary end is treated as blank as well: a padded
	// class count must never decode into fabricated text.
	const characters = ['\u0000', ...entries];
	const blankIndex = 0;
	return { characters, blankIndex };
};

const loadSessions = async () => {
	const ort = require('onnxruntime-node');
	const options = {
		executionProviders: ['cpu'],
		graphOptimizationLevel: 'all',
		logSeverityLevel: 3,
	};
	const [det, rec, cls] = await Promise.all([
		ort.InferenceSession.create(paths.det, options),
		ort.InferenceSession.create(paths.rec, options),
		ort.InferenceSession.create(paths.cls, options),
	]);
	const dictionary = await loadDictionary(paths.dict);
	return { ort, det, rec, cls, dictionary, modelDir: paths.dir };
};

let paths = null;

/**
 * Loads PaddleOCR once per process. Concurrent callers share one promise so a
 * burst of receipt uploads cannot start several cold starts.
 */
const getPaddleModels = async () => {
	if (cached) return cached;
	if (inflight) return inflight;
	inflight = (async () => {
		paths = await ensureModels();
		cached = await loadSessions();
		return cached;
	})();
	try {
		return await inflight;
	} finally {
		inflight = null;
	}
};

/** Model metadata only — safe to call from diagnostics without loading ONNX. */
const getPaddleModelInfo = async () => {
	const modelDir = resolveModelDir();
	return {
		engine: 'paddleocr',
		pipeline: 'PP-OCRv5',
		version: process.env.PADDLE_OCR_VERSION || 'v5',
		modelDir,
		baseUrl: String(process.env.PADDLE_OCR_MODEL_BASE_URL || DEFAULT_BASE_URL),
		artifacts: Object.fromEntries(
			Object.entries(MODEL_FILES).map(([kind, spec]) => [kind, {
				file: spec.local,
				label: MODEL_LABELS[kind],
				present: fs.existsSync(path.join(modelDir, spec.local)),
			}]),
		),
	};
};

/** Test hook — drops cached sessions so a new model dir can be picked up. */
const resetPaddleModelCache = () => {
	cached = null;
	inflight = null;
	paths = null;
};

module.exports = {
	getPaddleModels,
	getPaddleModelInfo,
	resetPaddleModelCache,
	MODEL_FILES,
	DEFAULT_BASE_URL,
};
