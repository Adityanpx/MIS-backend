CREATE TABLE app.audit_log (
  id                  bigserial PRIMARY KEY,
  tenant_id           uuid REFERENCES app.clients(id) ON DELETE SET NULL,   -- NULL = platform event
  actor_type          text NOT NULL CHECK (actor_type IN ('super_admin','user','system')),
  actor_id            uuid,
  acting_as_admin_id  uuid,
  action              text NOT NULL,
  entity              text NOT NULL,
  entity_id           text,
  before              jsonb,
  after               jsonb,
  reason              text,
  ip                  text,
  user_agent          text,
  request_id          text,
  at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  user_id        uuid NOT NULL,
  template_code  text NOT NULL,
  title          text NOT NULL,
  body           text NOT NULL,
  link           text,
  read_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE app.email_outbox (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES app.clients(id) ON DELETE SET NULL,          -- NULL = platform email (Super Admins)
  to_emails      text[] NOT NULL,
  template_code  text NOT NULL,
  subject        text NOT NULL,
  body_html      text NOT NULL,
  body_text      text NOT NULL,
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','bounced')),
  attempts       int NOT NULL DEFAULT 0,
  provider_id    text,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz
);
