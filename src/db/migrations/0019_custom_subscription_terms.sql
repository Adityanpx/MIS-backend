-- Subscriptions no longer pick a plan: the Super Admin types the term, the price per year and the
-- yearly hike for each plant. Those terms live in plan_snapshot (name 'Custom'), so plan_id becomes optional.
ALTER TABLE app.subscriptions ALTER COLUMN plan_id DROP NOT NULL;
