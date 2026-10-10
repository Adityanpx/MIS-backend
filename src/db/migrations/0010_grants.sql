-- admin_user: full DML on everything except changing audit history
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO admin_user;
REVOKE UPDATE, DELETE ON app.audit_log FROM admin_user;
REVOKE INSERT, UPDATE, DELETE ON app.schema_migrations FROM admin_user;

-- app_user: operational tenant tables (read/write, still row-limited by RLS)
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app.users, app.user_plant_roles, app.refresh_tokens, app.auth_tokens,
  app.plant_settings, app.parameters, app.parameter_standards, app.plant_constants,
  app.stock_items, app.stock_adjustments, app.staff_categories, app.staff_strengths,
  app.safety_items, app.safety_requirements, app.contract_years, app.revenue_components,
  app.bank_guarantees, app.insurance_policies,
  app.imports, app.logsheets, app.logsheet_values, app.correction_requests, app.daily_derived,
  app.plant_data_versions, app.pdf_documents, app.attachments, app.exports, app.notifications
TO app_user;

-- app_user: append-only tables
GRANT SELECT, INSERT ON app.logsheet_value_history, app.audit_log, app.email_outbox,
                        app.payment_notifications, app.tds_entries, app.plant_requests TO app_user;
GRANT UPDATE (status, attempts, provider_id, error, sent_at) ON app.email_outbox TO app_user;

-- app_user: read-only views of billing & lifecycle data (writes only through admin_user)
GRANT SELECT ON app.plants, app.subscriptions, app.billing_schedule, app.invoices, app.invoice_lines,
                app.credit_notes, app.payments, app.payment_allocations, app.receipts,
                app.client_credit_ledger, app.lifecycle_events, app.client_documents TO app_user;

-- clients: read own row; update only safe columns
GRANT SELECT ON app.clients TO app_user;
GRANT UPDATE (display_name, logo_key, primary_contact, billing_emails,
              terms_version, terms_accepted_at, terms_accepted_by) ON app.clients TO app_user;
-- plants: client may rename (PRD SET-01); everything else is Super Admin only
GRANT UPDATE (name) ON app.plants TO app_user;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app_user, admin_user;
