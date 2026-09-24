# Apollo Pharmacy backend

## Run locally

1. Copy `.env.example` to `.env` and configure `DATABASE_URL`, `ADMIN_LOGIN_PASSWORD`, and `FRONTEND_URL`.
2. Run `npm install`, then `npm run dev`.
3. The API listens on `http://localhost:5000` by default.

Run `npx prisma migrate deploy` once against the Supabase database before creating appointments or updating prices. The migrations add medicine prices and appointment email/note fields without deleting existing records.

To send accept/reject notifications, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM`. Without SMTP settings, the appointment status still updates and the admin response reports that no email was sent.

`MEDICINE_API_URL` must return a JSON array or an object containing `data`, `medicines`, or `results`. The admin dashboard's catalog sync imports new records with `availableQty: 0`; existing stock is never overwritten. Admin sessions are signed, stateless bearer tokens and expire after eight hours.

Useful endpoints:

- `GET /api/medicines`
- `POST /api/appointments`
- `POST /api/admin/login`
- `GET /api/admin/appointments`
- `PATCH /api/admin/appointments/:id`
- `PATCH /api/admin/update-stock`
- `POST /api/admin/medicines/sync`
# Apollo-Pharmacy-Backend
