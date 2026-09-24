# Apollo Pharmacy frontend

## Run locally

1. Copy `.env.example` to `.env` and set `VITE_API_URL` to the deployed backend URL plus `/api` when the backend is not local.
2. Run `npm install` and `npm run dev`.
3. Open `/admin` for the staff login page.

The public catalog and appointment form read and write through the backend API. Medicine quantities are always controlled by the authenticated admin dashboard.

Doctor profiles shown on the booking page are loaded from `public/doctors.json`; edit that file to change the mock doctors and schedules.
# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
# Apollo-Pharmacy
