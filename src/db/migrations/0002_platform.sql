CREATE TABLE app.super_admins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  email           text NOT NULL,
  mobile          text,
  password_hash   text,
  totp_secret_enc text,
  totp_enabled    boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','disabled')),
  failed_logins   int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  token_version   int NOT NULL DEFAULT 1,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz,
  updated_by      uuid
);
CREATE UNIQUE INDEX super_admins_email_uq ON app.super_admins (lower(email));

CREATE TABLE app.super_admin_refresh_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  super_admin_id  uuid NOT NULL REFERENCES app.super_admins(id) ON DELETE CASCADE,
  family_id       uuid NOT NULL,
  token_hash      text NOT NULL UNIQUE,
  device          text,
  ip              text,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  replaced_by     uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.super_admin_auth_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  super_admin_id  uuid NOT NULL REFERENCES app.super_admins(id) ON DELETE CASCADE,
  purpose         text NOT NULL CHECK (purpose IN ('invite','reset')),
  token_hash      text NOT NULL UNIQUE,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  is_public   boolean NOT NULL DEFAULT false,
  updated_at  timestamptz,
  updated_by  uuid
);

CREATE TABLE app.plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  code                  text NOT NULL UNIQUE,
  description           text,
  term_years            int NOT NULL CHECK (term_years BETWEEN 1 AND 15),
  price_per_year        numeric(14,2) NOT NULL CHECK (price_per_year >= 0),
  escalation_pct        numeric(7,4) NOT NULL DEFAULT 0 CHECK (escalation_pct BETWEEN 0 AND 25),
  upfront_discount_pct  numeric(7,4) NOT NULL DEFAULT 0 CHECK (upfront_discount_pct BETWEEN 0 AND 50),
  max_users_per_plant   int NOT NULL DEFAULT 10 CHECK (max_users_per_plant >= 1),
  storage_gb            int NOT NULL DEFAULT 5 CHECK (storage_gb >= 1),
  features              jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz,
  updated_by            uuid
);

CREATE TABLE app.doc_sequences (
  doc_type  text NOT NULL CHECK (doc_type IN ('invoice','credit_note','receipt')),
  fy        text NOT NULL,
  prefix    text NOT NULL,
  last_no   int  NOT NULL DEFAULT 0,
  PRIMARY KEY (doc_type, fy)
);

CREATE TABLE app.notification_templates (
  code        text PRIMARY KEY,
  channel     text NOT NULL CHECK (channel IN ('email','in_app','both')),
  subject     text NOT NULL,
  body_html   text NOT NULL,
  body_text   text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  updated_at  timestamptz,
  updated_by  uuid
);

CREATE TABLE app.razorpay_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      text NOT NULL UNIQUE,
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  result        text,
  error         text
);

CREATE TABLE app.announcements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message     text NOT NULL,
  level       text NOT NULL DEFAULT 'info' CHECK (level IN ('info','warning')),
  audience    jsonb NOT NULL DEFAULT '{"all": true}'::jsonb,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz,
  updated_by  uuid,
  CHECK (ends_at > starts_at)
);

CREATE TABLE app.idempotency_keys (
  scope       text NOT NULL,
  key         text NOT NULL,
  response    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
