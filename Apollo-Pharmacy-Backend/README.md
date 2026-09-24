# Apollo Pharmacy backend

## Run locally

1. Copy `.env.example` to `.env` and configure `DATABASE_URL`, `ADMIN_LOGIN_PASSWORD`, and `FRONTEND_URL`.
2. Run `npm install`, then `npm run dev`.
3. The API listens on `http://localhost:5000` by default.

Run `npx prisma migrate deploy` once against the Supabase database before creating appointments, updating prices, or using receipt stock updates. The migrations add medicine prices, appointment email/note fields, and receipt review plus stock transaction history without deleting existing records.

To send accept/reject notifications, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM`. Without SMTP settings, the appointment status still updates and the admin response reports that no email was sent.

`MEDICINE_API_URL` must return a JSON array or an object containing `data`, `medicines`, or `results`. The admin dashboard's catalog sync imports new records with `availableQty: 0`; existing stock is never overwritten. Admin sessions are signed, stateless bearer tokens and expire after eight hours.

Receipt stock updates require `OPENAI_API_KEY` and use `OPENAI_MODEL` (default `gpt-4o-mini`) for structured receipt extraction. Receipt uploads are admin-only, limited to 10 MB, and are never applied to stock until an admin confirms the review. Confirmations are transactional and idempotent; uploaded file bytes are cleared after confirmation.

Useful endpoints:

- `GET /api/medicines`
- `POST /api/appointments`
- `POST /api/admin/login`
- `GET /api/admin/appointments`
- `PATCH /api/admin/appointments/:id`
- `PATCH /api/admin/update-stock`
- `POST /api/admin/medicines/sync`
- `POST /api/stock/receipt/upload`
- `POST /api/stock/receipt/process`
- `GET /api/stock/receipt/:id`
- `POST /api/stock/receipt/confirm`
# Apollo-Pharmacy-Backend
