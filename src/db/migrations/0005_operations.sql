CREATE TABLE app.imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  plant_id    uuid NOT NULL,
  file_key    text NOT NULL,
  mapping     text NOT NULL CHECK (mapping IN ('template','excel_data_entry')),
  status      text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','validating','validated','applying','applied','failed')),
  report      jsonb,
  options     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz,
  updated_by  uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, plant_id) REFERENCES app.plants (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE app.logsheets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  plant_id      uuid NOT NULL,
  log_date      date NOT NULL,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','submitted','corrected','returned','checked','verified')),
  version       int NOT NULL DEFAULT 1,
  submitted_by  uuid,
  submitted_at  timestamptz,
  checked_by    uuid,
  checked_at    timestamptz,
  verified_by   uuid,
  verified_at   timestamptz,
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import')),
  import_id     uuid,
  locked_by     uuid,
  locked_until  timestamptz,
  remarks       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz,
  updated_by    uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, plant_id, log_date),
  FOREIGN KEY (tenant_id, plant_id)  REFERENCES app.plants  (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, import_id) REFERENCES app.imports (tenant_id, id)
);

CREATE TABLE app.logsheet_values (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  logsheet_id   uuid NOT NULL,
  parameter_id  uuid NOT NULL,
  value_num     numeric(18,6),
  value_text    text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, logsheet_id, parameter_id),
  FOREIGN KEY (tenant_id, logsheet_id)  REFERENCES app.logsheets  (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, parameter_id) REFERENCES app.parameters (tenant_id, id)
);

CREATE TABLE app.logsheet_value_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  logsheet_id   uuid NOT NULL,
  parameter_id  uuid NOT NULL,
  version       int NOT NULL,
  old_num       numeric(18,6),
  new_num       numeric(18,6),
  old_text      text,
  new_text      text,
  changed_by    uuid,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  reason        text NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, logsheet_id)  REFERENCES app.logsheets  (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, parameter_id) REFERENCES app.parameters (tenant_id, id)
);

CREATE TABLE app.correction_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  logsheet_id   uuid NOT NULL,
  requested_by  uuid NOT NULL,
  reason        text NOT NULL,
  proposed      jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by    uuid,
  decided_at    timestamptz,
  comment       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, logsheet_id) REFERENCES app.logsheets (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE app.daily_derived (
  tenant_id     uuid NOT NULL,
  plant_id      uuid NOT NULL,
  d             date NOT NULL,
  vals          jsonb NOT NULL,
  data_version  bigint NOT NULL,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, plant_id, d),
  FOREIGN KEY (tenant_id, plant_id) REFERENCES app.plants (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE app.pdf_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  plant_id      uuid NOT NULL,
  d             date NOT NULL,
  doc_type      text NOT NULL CHECK (doc_type IN ('logsheet','mis','dashboard')),
  version       int NOT NULL,
  file_key      text,
  size_bytes    int,
  status        text NOT NULL CHECK (status IN ('current','superseded','stale','failed')),
  reason        text,
  data_version  bigint,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, plant_id, d, doc_type, version),
  FOREIGN KEY (tenant_id, plant_id) REFERENCES app.plants (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE app.attachments (                       -- Phase 3 (P3 feature)
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  logsheet_id  uuid NOT NULL,
  file_key     text NOT NULL,
  caption      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, logsheet_id) REFERENCES app.logsheets (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE app.exports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.clients(id),
  scope       jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','building','ready','failed','expired')),
  file_key    text,
  expires_at  timestamptz,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  requested_by_admin uuid,
  UNIQUE (tenant_id, id)
);
