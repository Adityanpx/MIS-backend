CREATE TABLE app.clients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- this IS the tenant_id everywhere
  code               text NOT NULL UNIQUE,
  display_name       text NOT NULL,
  legal_name         text NOT NULL,
  gstin              text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  pan                text CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  state_code         text NOT NULL,
  address            jsonb NOT NULL DEFAULT '{}'::jsonb,
  primary_contact    jsonb NOT NULL DEFAULT '{}'::jsonb,
  billing_emails     text[] NOT NULL DEFAULT '{}',
  logo_key           text,
  notes              text,
  force_2fa          boolean NOT NULL DEFAULT false,
  account_state      text NOT NULL DEFAULT 'active'
                     CHECK (account_state IN ('active','grace','read_only','suspended','terminated')),
  manual_suspended   boolean NOT NULL DEFAULT false,
  hold_until         date,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','scheduled_for_deletion','deleted')),
  terms_version      text,
  terms_accepted_at  timestamptz,
  terms_accepted_by  uuid,
  terminated_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz,
  updated_by         uuid
);

CREATE TABLE app.client_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.clients(id),
  doc_type    text NOT NULL,
  title       text NOT NULL,
  file_key    text NOT NULL,
  doc_date    date,
  remarks     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  UNIQUE (tenant_id, id)
);

CREATE TABLE app.users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES app.clients(id),
  name                text NOT NULL,
  email               text NOT NULL,
  mobile              text,
  designation         text,
  password_hash       text,
  totp_secret_enc     text,
  totp_enabled        boolean NOT NULL DEFAULT false,
  is_client_admin     boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','disabled')),
  token_version       int NOT NULL DEFAULT 1,
  failed_logins       int NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  last_login_at       timestamptz,
  notification_prefs  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz,
  updated_by          uuid,
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX users_email_uq ON app.users (lower(email));

CREATE TABLE app.plants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES app.clients(id),
  code              text NOT NULL,
  name              text NOT NULL,
  type              text NOT NULL CHECK (type IN ('STP','WTP','ETP','CETP','OTHER')),
  capacity_mld      numeric(10,3) NOT NULL CHECK (capacity_mld > 0),
  city              text,
  state_code        text NOT NULL,
  om_start          date NOT NULL,
  om_tenure_months  int  NOT NULL CHECK (om_tenure_months BETWEEN 1 AND 180),
  om_end            date NOT NULL,
  mis_start         date NOT NULL,
  setup_status      text NOT NULL DEFAULT 'settings_pending' CHECK (setup_status IN ('settings_pending','live','closed')),
  account_state     text NOT NULL DEFAULT 'active'
                    CHECK (account_state IN ('active','grace','read_only','suspended','terminated','expired')),
  manual_suspended  boolean NOT NULL DEFAULT false,
  hold_until        date,
  closed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz,
  updated_by        uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (om_end = (om_start + make_interval(months => om_tenure_months))::date - 1),
  CHECK (mis_start BETWEEN om_start AND om_end)
);

CREATE TABLE app.user_plant_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  plant_id    uuid NOT NULL,
  role        text NOT NULL CHECK (role IN ('editor','checker','verifier','viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id, plant_id),
  FOREIGN KEY (tenant_id, user_id)  REFERENCES app.users  (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, plant_id) REFERENCES app.plants (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE app.refresh_tokens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  user_id          uuid NOT NULL,
  family_id        uuid NOT NULL,
  token_hash       text NOT NULL UNIQUE,
  device           text,
  ip               text,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  replaced_by      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE app.auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('invite','reset')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE app.act_as_sessions (               -- Phase 3
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES app.clients(id),
  super_admin_id   uuid NOT NULL REFERENCES app.super_admins(id),
  mode             text NOT NULL CHECK (mode IN ('view','edit')),
  reason           text NOT NULL,
  code_hash        text UNIQUE,
  code_expires_at  timestamptz,
  code_used_at     timestamptz,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  UNIQUE (tenant_id, id)
);

CREATE TABLE app.plant_data_versions (
  tenant_id         uuid NOT NULL,
  plant_id          uuid NOT NULL,
  data_version      bigint NOT NULL DEFAULT 0,
  settings_version  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, plant_id),
  FOREIGN KEY (tenant_id, plant_id) REFERENCES app.plants (tenant_id, id) ON DELETE CASCADE
);
