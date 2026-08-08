PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE "audit;events" (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO "audit;events" VALUES(1,'one;still one');
CREATE TRIGGER audit_insert AFTER INSERT ON "audit;events" BEGIN
  UPDATE "audit;events"
  SET value = CASE WHEN NEW.value = 'raw;value' THEN 'normalized' ELSE NEW.value END
  WHERE id = NEW.id;
END;
COMMIT;
PRAGMA foreign_keys=ON;
