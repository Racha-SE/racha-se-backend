-- NOTE: this is a reference copy. The version actually applied to the
-- database lives in src/db/migrations/0001_triggers.sql (tracked by
-- drizzle-kit, run via `bun run db:migrate`). If you change the trigger
-- logic, edit that migration (or generate a new one) — editing only this
-- file has no effect on the database.

-- ============================================================
-- Trigger 1: Enforce expired_date before a branch order can be
-- approved/completed (FR-BR-03 vs FR-BR-07 gap)
-- ============================================================

CREATE OR REPLACE FUNCTION check_branch_order_detail_expiry()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.order_type = 'branch' AND NEW.status IN ('approved', 'completed') THEN
    IF EXISTS (
      SELECT 1
      FROM branch_order_detail
      WHERE lot_id = NEW.lot_id
        AND expired_date IS NULL
    ) THEN
      RAISE EXCEPTION
        'Cannot approve order lot_id %: branch_order_detail has rows with no expired_date set',
        NEW.lot_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_branch_order_detail_expiry
BEFORE UPDATE ON "order"
FOR EACH ROW
WHEN (NEW.order_type = 'branch')
EXECUTE FUNCTION check_branch_order_detail_expiry();


-- ============================================================
-- Trigger 2: Prevent deletion of a user who has order history
-- (referential integrity safeguard)
-- ============================================================

CREATE OR REPLACE FUNCTION prevent_user_deletion()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "order" WHERE user_id = OLD.user_id) THEN
    RAISE EXCEPTION
      'Cannot delete user %: user has existing order history in the system',
      OLD.user_id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_before_user_delete
BEFORE DELETE ON "user"
FOR EACH ROW
EXECUTE FUNCTION prevent_user_deletion();
