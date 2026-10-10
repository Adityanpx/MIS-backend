GRANT UPDATE (mis_start, setup_status) ON app.plants TO app_user;
CREATE INDEX IF NOT EXISTS logsheets_status_idx ON app.logsheets (tenant_id, plant_id, status);
CREATE INDEX IF NOT EXISTS pdf_docs_current_idx ON app.pdf_documents (tenant_id, plant_id, d) WHERE status = 'current';
