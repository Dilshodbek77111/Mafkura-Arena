-- 001_core: foydalanuvchilar, tasdiqlash, sessiyalar, adminlar, audit, outbox
CREATE TABLE users (
  id                serial PRIMARY KEY,
  public_id         varchar(16) NOT NULL,
  first_name        text NOT NULL,
  last_name         text NOT NULL,
  email             text NOT NULL,
  phone             text NOT NULL,
  password_hash     text NOT NULL,
  birth_date        date NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING_EMAIL'
    CHECK (status IN ('PENDING_EMAIL','PENDING_DOCUMENT','ACTIVE','DOC_REJECTED','BLOCKED','DELETION_PENDING','DELETED')),
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  tos_version       text NOT NULL,
  privacy_version   text NOT NULL,
  tos_accepted_at   timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_phone_key UNIQUE (phone),
  CONSTRAINT users_public_id_key UNIQUE (public_id),
  CONSTRAINT users_email_lower CHECK (email = lower(email))
);
CREATE INDEX users_status_idx ON users (status);

CREATE TABLE user_verifications (
  user_id        integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  doc_status     text NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (doc_status IN ('NOT_SUBMITTED','PENDING','APPROVED','REJECTED')),
  attempts_used  integer NOT NULL DEFAULT 0 CHECK (attempts_used >= 0),
  extra_attempts integer NOT NULL DEFAULT 0 CHECK (extra_attempts >= 0)
);

CREATE TABLE verification_codes (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('EMAIL','PHONE')),
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_codes_lookup_idx ON verification_codes (user_id, channel, created_at DESC);

CREATE TABLE sessions (
  id         serial PRIMARY KEY,
  user_id    integer REFERENCES users(id) ON DELETE CASCADE,
  admin_id   integer,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip         text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR admin_id IS NOT NULL)
);

CREATE TABLE login_throttle (
  key          text PRIMARY KEY,
  failures     integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id  serial PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key IN ('HEAD_ADMIN','ADMIN'))
);
INSERT INTO roles (key) VALUES ('HEAD_ADMIN'), ('ADMIN');

CREATE TABLE admins (
  id            serial PRIMARY KEY,
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  first_name    text NOT NULL,
  last_name     text NOT NULL,
  role_id       integer NOT NULL REFERENCES roles(id),
  active        boolean NOT NULL DEFAULT true,
  totp_secret   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verification_attempts (
  id            serial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES users(id),
  attempt_no    integer NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reject_reason text,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_at   timestamptz,
  reviewed_by   integer REFERENCES admins(id),
  CONSTRAINT verification_attempts_user_no_key UNIQUE (user_id, attempt_no)
);
-- Bir foydalanuvchida bir vaqtda faqat bitta PENDING ariza
CREATE UNIQUE INDEX verification_attempts_one_pending ON verification_attempts (user_id) WHERE status = 'PENDING';

CREATE TABLE verification_documents (
  id              serial PRIMARY KEY,
  attempt_id      integer NOT NULL REFERENCES verification_attempts(id),
  storage_key     text NOT NULL UNIQUE,
  mime            text NOT NULL,
  size_bytes      integer NOT NULL,
  sha256          text NOT NULL,
  retention_until timestamptz NOT NULL,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_documents_retention_idx ON verification_documents (retention_until) WHERE deleted_at IS NULL;

-- Append-only audit log
CREATE TABLE admin_audit_log (
  id          bigserial PRIMARY KEY,
  admin_id    integer REFERENCES admins(id),   -- NULL = tizim (masalan, avtomatik o'chirish)
  action      text NOT NULL,
  object_type text NOT NULL,
  object_id   text NOT NULL,
  old_value   jsonb,
  new_value   jsonb,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_log_object_idx ON admin_audit_log (object_type, object_id);

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table: % is not allowed on %', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
CREATE TRIGGER admin_audit_log_no_change BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER admin_audit_log_no_truncate BEFORE TRUNCATE ON admin_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TABLE notifications (
  id         serial PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  dedup_key  text NOT NULL UNIQUE,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- Persistent outbox: restartdan keyin yo'qolmaydi, dedup_key takroriy yuborishni to'sadi
CREATE TABLE notification_outbox (
  id         serial PRIMARY KEY,
  channel    text NOT NULL DEFAULT 'EMAIL' CHECK (channel IN ('EMAIL')),
  user_id    integer REFERENCES users(id) ON DELETE SET NULL,
  dedup_key  text NOT NULL UNIQUE,
  payload    jsonb NOT NULL,
  status     text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','SENT','FAILED','CANCELLED')),
  run_at     timestamptz NOT NULL,
  expires_at timestamptz,
  attempts   integer NOT NULL DEFAULT 0,
  locked_at  timestamptz,
  sent_at    timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_outbox_due_idx ON notification_outbox (run_at) WHERE status = 'PENDING';

CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
