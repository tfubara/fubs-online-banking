# Fubs Online Banking — Version B foundation

A production-oriented Node.js + PostgreSQL starter, not a licensed bank or payment processor. It does not move real money or perform actual facial recognition.

## Included
- Four-step signup: personal, contact/profile, security, selfie/confirmation
- No NIN or BVN fields
- Camera capture stays in the browser; no selfie is uploaded or stored
- Password and transaction PIN hashing with bcrypt
- PostgreSQL user/account/beneficiary/transaction/audit tables
- PostgreSQL-backed sessions, secure cookie defaults, Helmet, rate limits
- Login, logout, profile and transaction-history APIs
- Render deployment template

## Local setup
1. Install Node.js 22+ and PostgreSQL.
2. Create a database and set `DATABASE_URL`.
3. Run `psql "$DATABASE_URL" -f schema.sql` (the schema enables `pgcrypto`; your database role must have permission).
4. Copy `.env.example` to `.env`; set a random `SESSION_SECRET` of at least 32 characters.
5. Run `npm install`, then `npm start`.
6. Visit http://localhost:3000.

## Render
Build command: `npm install`
Start command: `npm start`
Health check path: `/api/health`

Check the Render dashboard for current PostgreSQL plan availability and pricing. For production, configure database TLS and confirm the provider's SSL requirements.

## Not production-ready for real money
Email/SMS OTP delivery and facial verification are not implemented. The selfie is only captured locally and is not proof of identity. The account remains `pending_review`, and face status is `not_configured`. No deposit, withdrawal, or transfer endpoint is provided. Do not claim verification succeeded unless a vetted provider confirms it through a secured server-side flow.

Before real-money use, work with a regulated banking/payment partner and implement double-entry accounting, idempotent posting, signed webhook verification, reconciliation, reversal/dispute handling, fraud controls, additional transaction authentication, monitoring, backups, privacy controls, and independent security/legal review. Add CSRF protection and a strict origin policy before production use.
