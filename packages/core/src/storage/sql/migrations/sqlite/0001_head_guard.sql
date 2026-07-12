CREATE TRIGGER IF NOT EXISTS authority_heads_undeletable
  BEFORE DELETE ON authority_heads
  FOR EACH ROW
  BEGIN
    SELECT RAISE(ABORT, 'authority head rows are undeletable');
  END;
