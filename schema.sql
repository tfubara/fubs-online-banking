CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name VARCHAR(80) NOT NULL,
  middle_name VARCHAR(80),
  last_name VARCHAR(80) NOT NULL,
  date_of_birth DATE NOT NULL,
  gender VARCHAR(40),
  country VARCHAR(80) NOT NULL,
  state_region VARCHAR(100) NOT NULL,
  city VARCHAR(100) NOT NULL,
  residential_address VARCHAR(250) NOT NULL,
  postal_code VARCHAR(20),
  occupation VARCHAR(100),
  employment_status VARCHAR(80),
  email VARCHAR(254) NOT NULL UNIQUE,
  phone VARCHAR(25) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  transaction_pin_hash TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ,
  phone_verified_at TIMESTAMPTZ,
  face_verification_status VARCHAR(30) NOT NULL DEFAULT 'not_configured'
    CHECK (face_verification_status IN ('not_started','pending','verified','failed','not_configured')),
  account_status VARCHAR(30) NOT NULL DEFAULT 'pending_review'
    CHECK (account_status IN ('pending_review','active','restricted','closed')),
  terms_accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  account_number CHAR(10) NOT NULL UNIQUE,
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','restricted','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS beneficiaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recipient_name VARCHAR(160) NOT NULL,
  recipient_account_number CHAR(10) NOT NULL,
  bank_name VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference VARCHAR(40) NOT NULL UNIQUE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  type VARCHAR(30) NOT NULL CHECK (type IN ('deposit','withdrawal','transfer_in','transfer_out','fee','reversal')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted','failed','reversed')),
  description VARCHAR(240) NOT NULL,
  idempotency_key VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  posted_at TIMESTAMPTZ,
  UNIQUE (account_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_transactions_account_created ON transactions(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_beneficiaries_owner ON beneficiaries(owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(100) NOT NULL,
  outcome VARCHAR(30) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
