BEGIN;
-- The general model, part 3: usage events (architecture section 50). The provider
-- ledger (retrieval_provider_operations) stays the authority for reservations and
-- spend caps, and feeds usage_events: each settled operation becomes one
-- immutable usage event with the ledger operation's ID, attributed to what it
-- paid for. A reservation that never settles is an unknown outcome; it stays in
-- the ledger, keeps its reservation and is counted as unknown in the daily
-- summary, never as zero. Deviations from schema.dbml, recorded there:
--   source/source_id attribute evaluations, criteria preparation and searches,
--     which are neither a run nor an ingestion; old rows whose job is gone are
--     'unattributed';
--   connection_id is null for the platform's own provider accounts;
--   agent_id and ingestion_job_id have no foreign key, because spend outlives
--     the agents and jobs it measured;
--   one meter, 'operation', per ledger operation: the ledger records one cost
--     per operation, with its token counts as evidence;
--   daily_cost_summaries is a view, always current, instead of a cache table.

CREATE TABLE agentonic.usage_events (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES agentonic.workspaces(id), agent_id uuid, run_id uuid, ingestion_job_id uuid,
 source text NOT NULL CHECK(source IN ('run','ingestion','search','evaluation','preparation','unattributed')), source_id uuid,
 provider text NOT NULL, model_identifier text, provider_event_key text NOT NULL, provider_request_id text,
 pricing_snapshot jsonb NOT NULL, occurred_at timestamptz NOT NULL,
 quantity numeric(24,8) CHECK(quantity>=0), provider_cost_usd numeric(20,8) CHECK(provider_cost_usd>=0), connection_id uuid,
 measurement_status text NOT NULL CHECK(measurement_status IN ('unknown','estimated','measured')),
 cost_basis text NOT NULL CHECK(cost_basis IN ('unknown','estimated','provider_billed')),
 provider_operation_key text NOT NULL, pricing_evidence jsonb, provider_aggregate_evidence jsonb,
 meter text NOT NULL CHECK(meter ~ '^[a-z][a-z_]{1,40}$'), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(provider,provider_operation_key,meter),
 FOREIGN KEY(workspace_id,run_id) REFERENCES agentonic.agent_runs(workspace_id,id),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES agentonic.connections(workspace_id,id),
 CHECK((source='run')=(run_id IS NOT NULL)), CHECK((source='ingestion')=(ingestion_job_id IS NOT NULL)),
 CHECK(run_id IS NULL OR agent_id IS NOT NULL), CHECK(ingestion_job_id IS NULL OR agent_id IS NULL),
 CHECK((measurement_status='unknown')=(quantity IS NULL)), CHECK((cost_basis='unknown')=(provider_cost_usd IS NULL))
);
CREATE INDEX usage_events_workspace_time ON agentonic.usage_events(workspace_id,occurred_at);
CREATE INDEX usage_events_agent_time ON agentonic.usage_events(workspace_id,agent_id,occurred_at);
ALTER TABLE agentonic.usage_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.usage_events FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure,agentonic_deployer_local,agentonic_deployer_azure,agentonic_runtime_local,agentonic_runtime_azure;
-- Usage events are facts: never changed or removed.
CREATE FUNCTION agentonic.usage_event_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE insufficient_privilege; END $$;
CREATE TRIGGER usage_event_immutable BEFORE UPDATE OR DELETE ON agentonic.usage_events FOR EACH ROW EXECUTE FUNCTION agentonic.usage_event_immutable();

-- What one ledger operation paid for, from the record it names.
CREATE FUNCTION agentonic.usage_event(o agentonic.retrieval_provider_operations,occurred timestamptz) RETURNS agentonic.usage_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e agentonic.usage_events; ingestion uuid;
BEGIN
 e.id:=o.id; e.workspace_id:=o.workspace_id; e.provider:=o.provider; e.model_identifier:=o.model;
 e.provider_event_key:=o.id::text; e.provider_operation_key:=o.id::text; e.meter:='operation'; e.occurred_at:=occurred; e.created_at:=clock_timestamp();
 e.pricing_snapshot:=jsonb_build_object('basis','list_price_estimate','reservedMicrousd',o.reserved_microusd,'settledMicrousd',o.actual_microusd);
 e.pricing_evidence:=jsonb_strip_nulls(jsonb_build_object('inputTokens',o.input_tokens,'outputTokens',o.output_tokens));
 e.quantity:=1; e.measurement_status:='measured'; e.cost_basis:='estimated'; e.provider_cost_usd:=o.actual_microusd::numeric/1000000;
 IF EXISTS(SELECT 1 FROM agentonic.agent_runs WHERE id=o.job_id AND workspace_id=o.workspace_id) THEN
  e.source:='run'; e.run_id:=o.job_id; e.source_id:=o.job_id;
  SELECT agent_id INTO e.agent_id FROM agentonic.agent_runs WHERE id=o.job_id;
 ELSIF EXISTS(SELECT 1 FROM agentonic.evaluation_runs WHERE id=o.job_id) THEN
  e.source:='evaluation'; e.source_id:=o.job_id; e.agent_id:=o.agent_id;
 ELSIF EXISTS(SELECT 1 FROM agentonic.evaluation_preparations WHERE id=o.job_id) THEN
  e.source:='preparation'; e.source_id:=o.job_id; e.agent_id:=o.agent_id;
 ELSE
  SELECT id INTO ingestion FROM agentonic.ingestion_jobs WHERE background_job_id=o.job_id;
  IF ingestion IS NOT NULL THEN
   e.source:='ingestion'; e.ingestion_job_id:=ingestion; e.source_id:=o.job_id;
  ELSIF EXISTS(SELECT 1 FROM agentonic.background_jobs WHERE id=o.job_id AND kind='retrieve') THEN
   e.source:='search'; e.source_id:=o.job_id; e.agent_id:=o.agent_id;
  ELSE
   e.source:='unattributed'; e.source_id:=o.job_id; e.agent_id:=o.agent_id;
  END IF;
 END IF;
 RETURN e;
END $$;
CREATE FUNCTION agentonic.ledger_usage() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO agentonic.usage_events SELECT (agentonic.usage_event(NEW,clock_timestamp())).*;
 RETURN NEW;
END $$;
CREATE TRIGGER ledger_usage AFTER UPDATE OF status ON agentonic.retrieval_provider_operations
 FOR EACH ROW WHEN (OLD.status='reserved' AND NEW.status='settled') EXECUTE FUNCTION agentonic.ledger_usage();
-- Spend is never forgotten: ledger operations are not deleted.
CREATE FUNCTION agentonic.ledger_retained() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE insufficient_privilege; END $$;
CREATE TRIGGER ledger_retained BEFORE DELETE ON agentonic.retrieval_provider_operations FOR EACH ROW EXECUTE FUNCTION agentonic.ledger_retained();

-- Every operation settled so far, at the time it was reserved (its settlement time was not kept).
INSERT INTO agentonic.usage_events SELECT (agentonic.usage_event(o,o.created_at)).* FROM agentonic.retrieval_provider_operations o WHERE o.status='settled';

-- Known spend per day in each workspace's own time zone, with unknown outcomes
-- counted separately. The row without an agent is the whole workspace, shared
-- ingestion included once; agent rows are that agent's direct cost and are not
-- added to it again. An unsettled reservation counts as unknown after an hour.
CREATE VIEW agentonic.daily_cost_summaries WITH (security_barrier) AS
WITH facts AS (
 SELECT e.workspace_id,e.agent_id,(e.occurred_at AT TIME ZONE w.timezone)::date local_date,w.timezone,
  e.provider_cost_usd known,0 unknown,CASE WHEN e.cost_basis='estimated' THEN 1 ELSE 0 END estimated
 FROM agentonic.usage_events e JOIN agentonic.workspaces w ON w.id=e.workspace_id
 UNION ALL
 SELECT o.workspace_id,o.agent_id,(o.created_at AT TIME ZONE w.timezone)::date,w.timezone,0,1,0
 FROM agentonic.retrieval_provider_operations o JOIN agentonic.workspaces w ON w.id=o.workspace_id
 WHERE o.status='reserved' AND o.created_at<clock_timestamp()-interval '1 hour'
)
SELECT workspace_id,agent_id,local_date,timezone reporting_timezone,sum(known)::numeric(20,8) known_cost_usd,
 sum(unknown)::integer unknown_cost_operations,sum(estimated)::integer estimated_cost_operations,clock_timestamp() computed_at
FROM facts GROUP BY GROUPING SETS ((workspace_id,local_date,timezone),(workspace_id,agent_id,local_date,timezone))
HAVING GROUPING(agent_id)=1 OR agent_id IS NOT NULL;
REVOKE ALL ON agentonic.daily_cost_summaries FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
REVOKE ALL ON FUNCTION agentonic.usage_event_immutable(),agentonic.usage_event(agentonic.retrieval_provider_operations,timestamptz),agentonic.ledger_usage(),agentonic.ledger_retained()
 FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
COMMIT;
