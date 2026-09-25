# Apollo Pharmacy backend

## Run locally

1. Copy `.env.example` to `.env` and configure `DATABASE_URL` (must start with `postgresql://` or `postgres://`), `ADMIN_LOGIN_PASSWORD`, and `FRONTEND_URL`.
2. Run `npm install`, then `npm run dev`.
3. The API listens on `http://localhost:5000` by default.

Run `npx prisma migrate deploy` once against the database before using stock batches, receipts, or push subscriptions. The API also bootstraps missing stock tables on first admin/stock request as a safety net.

Receipt stock extraction uses **Tesseract OCR** (`tesseract.js`) for JPG/PNG. Text PDFs are parsed with `pdf-parse`; scanned PDFs should be uploaded as images. OpenAI is only used for the optional `/api/chat` assistant when `OPENAI_API_KEY` is set.

Admin medicine create accepts optional `availableQty`, `batchNumber`, `expiryDate`, and `reason` and writes matching `StockBatch` + `StockTransaction` rows. Manual stock adjustments use `/api/admin/stock/adjust` and keep `Medicine.availableQty` in sync with batch totals.

Useful endpoints:

- `GET /api/medicines`
- `POST /api/admin/login`
- `PATCH /api/admin/update-stock`
- `POST /api/admin/stock/adjust`
- `POST /api/admin/medicines`
- `POST /api/admin/medicines/sync`
- `POST /api/stock/receipt/upload`
- `POST /api/stock/receipt/process`
- `GET /api/stock/receipt/:id`
- `POST /api/stock/receipt/confirm`
# Apollo-Pharmacy-Backend
