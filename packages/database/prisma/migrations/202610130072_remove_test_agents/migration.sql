BEGIN;
-- Remove two development agents (owner decision, 13 October 2026).
--
-- "Prueba Gmail B2" (Gmail live acceptance B2, 8 October) and "Garantías Ferretería
-- Ejemplo" (review and deployment checks, 6 October) were test agents in ACME and are no
-- longer useful. Everything that holds their content goes: drafts and versions, reviews,
-- evaluations, private tests, chats with their messages, runs, tool calls, deployments,
-- channels and the disconnected Gmail connection. So does the tombstone of "Política de
-- garantía (sintética)", the knowledge collection only Garantías used: the owner removed
-- it in the app first, so the knowledge worker deleted its files from Storage.
--
-- Kept, as for any removal: content-free audit events and accumulated provider usage.
-- Usage rows keep their agent and amounts (Admin names the agent "Agente eliminado"); the
-- rows of runs become "unattributed", since those runs no longer exist. Provider
-- operations are untouched.
--
-- Immutability triggers are lifted only inside this block, which runs in this one
-- transaction: any failure leaves everything as it was. The deployment was stopped and
-- its copy removed from vm-agents-01 before this ran. Elsewhere (fresh and test
-- databases) neither agent nor the collection exists and nothing changes.
DO $$
DECLARE
 ws CONSTANT uuid:='ae52d6bb-dee6-40a2-bb9e-24bb9b7cbbe2';
 gmail_test CONSTANT uuid:='a32e5f68-487e-4792-b19b-5580e4475396';
 warranty CONSTANT uuid:='1c10259f-6b7a-464e-9bfb-05095b9b9418';
 collection CONSTANT uuid:='f27108d9-9bd4-4260-a09a-c69c01ca637b';
 targets uuid[];
 t record;
 n bigint;
BEGIN
 PERFORM 1 FROM agentonic.agents WHERE id IN (gmail_test,warranty) FOR UPDATE;
 IF EXISTS(SELECT 1 FROM agentonic.agents WHERE id IN (gmail_test,warranty) AND NOT (workspace_id=ws AND
  (id=gmail_test AND name='Prueba Gmail B2' OR id=warranty AND name='Garantías Ferretería Ejemplo'))) THEN
  RAISE EXCEPTION 'Unexpected agent behind a test agent ID';
 END IF;
 SELECT coalesce(array_agg(id),'{}') INTO targets FROM agentonic.agents WHERE id IN (gmail_test,warranty);

 IF cardinality(targets)>0 THEN
  IF EXISTS(SELECT 1 FROM agentonic.deployments WHERE agent_id=ANY(targets) AND status IN ('awaiting_activation','queued','preparing','running'))
   OR EXISTS(SELECT 1 FROM agentonic.agent_previews WHERE agent_id=ANY(targets) AND status='running')
   OR EXISTS(SELECT 1 FROM agentonic.evaluation_runs WHERE agent_id=ANY(targets) AND status IN ('awaiting_consent','queued','running'))
   OR EXISTS(SELECT 1 FROM agentonic.evaluation_preparations WHERE agent_id=ANY(targets) AND status IN ('queued','preparing','criteria_ready','evaluating'))
   OR EXISTS(SELECT 1 FROM agentonic.agent_schedules WHERE agent_id=ANY(targets))
   OR EXISTS(SELECT 1 FROM agentonic.style_guides WHERE agent_id=ANY(targets))
   OR EXISTS(SELECT 1 FROM agentonic.drive_connections WHERE agent_id=ANY(targets)) THEN
   RAISE EXCEPTION 'A test agent is still active or holds records this removal does not cover';
  END IF;

  -- Usage stays; its run rows lose only the link to runs that are about to go.
  ALTER TABLE agentonic.usage_events DISABLE TRIGGER usage_event_immutable;
  UPDATE agentonic.usage_events SET source='unattributed',run_id=NULL,source_id=NULL
   WHERE run_id IN (SELECT id FROM agentonic.agent_runs WHERE agent_id=ANY(targets));
  ALTER TABLE agentonic.usage_events ENABLE TRIGGER usage_event_immutable;

  -- Extension rows first: their triggers remove the matching general tool calls,
  -- conversations and messages, and end the runs.
  DELETE FROM agentonic.gmail_invocations WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.tool_invocations WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.staging_turns WHERE conversation_id IN (SELECT id FROM agentonic.staging_conversations WHERE agent_id=ANY(targets));
  DELETE FROM agentonic.background_jobs WHERE preview_id IN (SELECT id FROM agentonic.agent_previews WHERE agent_id=ANY(targets));
  DELETE FROM agentonic.agent_runs WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.staging_conversations WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.agent_previews WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.conversations WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.channel_endpoints WHERE agent_id=ANY(targets);

  DELETE FROM agentonic.agent_environments WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.deployment_renewals WHERE deployment_id IN (SELECT id FROM agentonic.deployments WHERE agent_id=ANY(targets));
  ALTER TABLE agentonic.deployments DISABLE TRIGGER deployment_immutable;
  DELETE FROM agentonic.deployments WHERE agent_id=ANY(targets);
  ALTER TABLE agentonic.deployments ENABLE TRIGGER deployment_immutable;

  -- A preparation and its evaluation point at each other; the preparation's link is optional.
  ALTER TABLE agentonic.evaluation_preparations DISABLE TRIGGER review_preparation_immutable;
  ALTER TABLE agentonic.evaluation_criteria_revisions DISABLE TRIGGER review_criteria_immutable;
  ALTER TABLE agentonic.evaluation_results DISABLE TRIGGER evaluation_result_immutable;
  ALTER TABLE agentonic.evaluation_batches DISABLE TRIGGER evaluation_batch_immutable;
  UPDATE agentonic.evaluation_preparations SET evaluation_id=NULL WHERE agent_id=ANY(targets) AND evaluation_id IS NOT NULL;
  DELETE FROM agentonic.evaluation_results WHERE evaluation_run_id IN (SELECT id FROM agentonic.evaluation_runs WHERE agent_id=ANY(targets));
  DELETE FROM agentonic.evaluation_runs WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.evaluation_batches WHERE preparation_id IN (SELECT id FROM agentonic.evaluation_preparations WHERE agent_id=ANY(targets));
  DELETE FROM agentonic.evaluation_criteria_revisions WHERE preparation_id IN (SELECT id FROM agentonic.evaluation_preparations WHERE agent_id=ANY(targets));
  DELETE FROM agentonic.evaluation_preparations WHERE agent_id=ANY(targets);
  ALTER TABLE agentonic.evaluation_preparations ENABLE TRIGGER review_preparation_immutable;
  ALTER TABLE agentonic.evaluation_criteria_revisions ENABLE TRIGGER review_criteria_immutable;
  ALTER TABLE agentonic.evaluation_results ENABLE TRIGGER evaluation_result_immutable;
  ALTER TABLE agentonic.evaluation_batches ENABLE TRIGGER evaluation_batch_immutable;

  DELETE FROM agentonic.approval_renewal_requests WHERE submission_id IN (SELECT id FROM agentonic.agent_submissions WHERE agent_id=ANY(targets));
  DELETE FROM agentonic.submission_review_decisions WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.agent_submissions WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.configuration_tools WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.configuration_releases WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.configuration_drafts WHERE agent_id=ANY(targets);

  -- The Gmail connection's trigger removes its general connection row.
  DELETE FROM agentonic.agent_connection_grants WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.gmail_oauth_states WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.drive_oauth_states WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.gmail_connections WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.agent_member_grants WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.agent_contact_grants WHERE agent_id=ANY(targets);
  DELETE FROM agentonic.agents WHERE id=ANY(targets);

  FOR t IN SELECT c.table_name FROM information_schema.columns c
   JOIN information_schema.tables x ON x.table_schema=c.table_schema AND x.table_name=c.table_name AND x.table_type='BASE TABLE'
   WHERE c.table_schema='agentonic' AND c.column_name='agent_id' AND c.table_name NOT IN ('usage_events','retrieval_provider_operations') LOOP
   EXECUTE format('SELECT count(*) FROM agentonic.%I WHERE agent_id=ANY($1)',t.table_name) INTO n USING targets;
   IF n>0 THEN RAISE EXCEPTION 'Test agent rows remain in %',t.table_name; END IF;
  END LOOP;
 END IF;

 -- The collection's tombstone, once its removal and Storage purge have finished.
 IF EXISTS(SELECT 1 FROM agentonic.knowledge_collections WHERE id=collection AND workspace_id=ws) THEN
  IF EXISTS(SELECT 1 FROM agentonic.knowledge_collections WHERE id=collection AND archived_at IS NULL)
   OR EXISTS(SELECT 1 FROM agentonic.documents d JOIN agentonic.knowledge_sources s ON s.id=d.source_id WHERE s.collection_id=collection)
   OR EXISTS(SELECT 1 FROM agentonic.ingestion_jobs j JOIN agentonic.knowledge_sources s ON s.id=j.source_id WHERE s.collection_id=collection)
   OR EXISTS(SELECT 1 FROM agentonic.drive_knowledge_files WHERE collection_id=collection) THEN
   RAISE NOTICE 'Collection not removed or not yet purged; left in place';
  ELSE
   DELETE FROM agentonic.collection_member_grants WHERE collection_id=collection;
   DELETE FROM agentonic.knowledge_sources WHERE collection_id=collection;
   DELETE FROM agentonic.knowledge_collections WHERE id=collection;
  END IF;
 END IF;
END $$;
COMMIT;
