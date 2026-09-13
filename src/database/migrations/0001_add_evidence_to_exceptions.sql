-- The `exceptions` table already exists (pre-provisioned, 0 rows) and matches the
-- engine's contract except for the machine-readable evidence payload. This adds it
-- without touching any of the existing WMS-owned tables.
ALTER TABLE exceptions
  ADD COLUMN IF NOT EXISTS evidence JSON NULL AFTER description;
