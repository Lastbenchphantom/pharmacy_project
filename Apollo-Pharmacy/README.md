# Apollo Pharmacy frontend

## Run locally

1. Copy `.env.example` to `.env` and set `VITE_API_URL` to the deployed backend URL plus `/api` when the backend is not local (for example `https://your-api.vercel.app/api`).
2. Production builds use `.env.production` when present.
3. Run `npm install` and `npm run dev`.
4. Open `/admin` for the staff login page.

The public catalog reads medicines from the backend API. Stock quantities are controlled from the authenticated admin dashboard (manual adjust, add medicine with optional initial stock, and receipt OCR confirm).

Receipt OCR runs on the backend with Tesseract (no OpenAI required for stock receipts).
