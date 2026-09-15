BEGIN;
-- Candidate ordering reflects the instant it is frozen, including two freezes in
-- one transaction. now() gave both the transaction start and random UUID order.
ALTER TABLE agentonic.configuration_releases ALTER COLUMN created_at SET DEFAULT clock_timestamp();
COMMIT;
