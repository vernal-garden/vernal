-- 016_plantings_one_per_cell.sql
-- One planting per grid cell (Robert, 2026-10-15). Production had zero
-- duplicate cells on 2026-10-15; the check stops the deploy with a clear
-- message if any appeared since.
BEGIN;
DO $$
DECLARE dup_cells integer;
BEGIN
  SELECT COUNT(*) INTO dup_cells FROM (
    SELECT 1 FROM plantings
    WHERE cell_x IS NOT NULL
    GROUP BY bed_id, cell_x, cell_y
    HAVING COUNT(*) > 1
  ) d;
  IF dup_cells > 0 THEN
    RAISE EXCEPTION '016: % grid cell(s) hold more than one planting; resolve them before applying', dup_cells;
  END IF;
END $$;
CREATE UNIQUE INDEX plantings_one_per_cell_idx
  ON plantings (bed_id, cell_x, cell_y)
  WHERE cell_x IS NOT NULL;
COMMIT;
