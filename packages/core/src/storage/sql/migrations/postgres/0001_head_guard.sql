CREATE OR REPLACE FUNCTION caplets_prevent_authority_head_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'authority head rows are undeletable';
END;
$$;
DROP TRIGGER IF EXISTS authority_heads_undeletable ON authority_heads;
CREATE TRIGGER authority_heads_undeletable
  BEFORE DELETE ON authority_heads
  FOR EACH ROW EXECUTE FUNCTION caplets_prevent_authority_head_delete();
