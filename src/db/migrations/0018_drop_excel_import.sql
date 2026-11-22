-- Removes the Excel import feature: the logsheets -> imports link, then the imports table
-- (its RLS policies, grants and indexes go with it).
ALTER TABLE app.logsheets DROP COLUMN import_id;
DROP TABLE app.imports;
