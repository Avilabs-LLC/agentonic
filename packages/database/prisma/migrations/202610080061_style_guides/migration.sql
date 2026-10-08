-- Aprender mi estilo (architecture §57, owner request, 8 October 2026).
-- The person who connected a Gmail account can ask the knowledge worker to read
-- the mail they sent in the last 90 days (at most 200 messages) and draft a
-- writing-style guide. Mail is read and analyzed in the worker's memory only:
-- this table never holds message content, only progress counts and, until the
-- person decides, the drafted guide. They review the guide, and the customer
-- app adds the accepted text to a collection through the ordinary upload path.
-- An expired or discarded guide is erased.

CREATE TABLE agentonic.style_guides (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES agentonic.workspaces(id),
 agent_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 member_id uuid NOT NULL,
 request_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','reading','analyzing','writing','ready','accepted','discarded','failed','cancelled')),
 window_days integer NOT NULL DEFAULT 90 CHECK(window_days=90),
 max_messages integer NOT NULL DEFAULT 200 CHECK(max_messages BETWEEN 1 AND 200),
 messages_total integer CHECK(messages_total BETWEEN 0 AND 200),
 messages_read integer NOT NULL DEFAULT 0 CHECK(messages_read BETWEEN 0 AND 200),
 messages_used integer CHECK(messages_used BETWEEN 0 AND 200),
 batches_total integer CHECK(batches_total BETWEEN 0 AND 40),
 batches_done integer NOT NULL DEFAULT 0 CHECK(batches_done BETWEEN 0 AND 40),
 budget_usd numeric(20,8) NOT NULL CHECK(budget_usd BETWEEN 0.25 AND 2),
 committed_microusd bigint NOT NULL DEFAULT 0 CHECK(committed_microusd>=0),
 guide text CHECK(guide IS NULL OR length(guide) BETWEEN 1 AND 40000),
 object_id uuid,
 error_code text CHECK(error_code IS NULL OR error_code IN ('not_enough_mail','reconnect','gmail_unavailable','budget_exhausted','provider_unavailable','lease_lost','configuration_required')),
 consent jsonb NOT NULL CHECK(jsonb_typeof(consent)='object'),
 worker_lease uuid,
 lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 started_at timestamptz,
 finished_at timestamptz,
 expires_at timestamptz,
 UNIQUE(workspace_id,id),
 UNIQUE(member_id,request_id),
 FOREIGN KEY(workspace_id,agent_id,connection_id) REFERENCES agentonic.gmail_connections(workspace_id,agent_id,id),
 FOREIGN KEY(workspace_id,member_id) REFERENCES agentonic.workspace_members(workspace_id,id),
 FOREIGN KEY(object_id) REFERENCES agentonic.stored_objects(id),
 -- The drafted guide exists only while it waits for the person's decision.
 CHECK(guide IS NULL OR status='ready'),
 CHECK(status<>'ready' OR (guide IS NOT NULL AND expires_at IS NOT NULL)),
 CHECK((status='accepted')=(object_id IS NOT NULL)),
 CHECK((status='failed')=(error_code IS NOT NULL))
);
-- One run at a time per account.
CREATE UNIQUE INDEX style_guides_one_active ON agentonic.style_guides(connection_id) WHERE status IN ('queued','reading','analyzing','writing');
CREATE INDEX style_guides_queue ON agentonic.style_guides(created_at) WHERE status='queued';
ALTER TABLE agentonic.style_guides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.style_guides FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure,agentonic_deployer_local,agentonic_deployer_azure,agentonic_runtime_local,agentonic_runtime_azure;

-- What a person sees of their own accounts' guides: progress, cost and, while it
-- waits for them, the drafted guide. Never another member's.
CREATE FUNCTION agentonic.style_guide_view(g agentonic.style_guides) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('id',g.id,'connectionId',g.connection_id,
  'status',CASE WHEN g.status='ready' AND g.expires_at<=clock_timestamp() THEN 'discarded' ELSE g.status END,
  'messagesRead',g.messages_read,'messagesTotal',g.messages_total,'messagesUsed',g.messages_used,'batchesDone',g.batches_done,'batchesTotal',g.batches_total,
  'budgetUsd',g.budget_usd,'committedMicrousd',g.committed_microusd,'errorCode',g.error_code,
  'createdAt',g.created_at,'startedAt',g.started_at,'finishedAt',g.finished_at,'expiresAt',g.expires_at,
  'guide',CASE WHEN g.status='ready' AND g.expires_at>clock_timestamp() THEN g.guide END,
  'document',(SELECT jsonb_build_object('objectId',o.id,'title',d.title,'collectionId',s.collection_id,'collection',c.name)
   FROM agentonic.stored_objects o JOIN agentonic.document_versions v ON v.object_id=o.id JOIN agentonic.documents d ON d.id=v.document_id
   JOIN agentonic.knowledge_sources s ON s.id=d.source_id JOIN agentonic.knowledge_collections c ON c.id=s.collection_id
   WHERE o.id=g.object_id AND o.deleted_at IS NULL AND d.deleted_at IS NULL LIMIT 1))
$$;

CREATE FUNCTION agentonic.style_guide_state(target_agent uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR w IS NULL OR m IS NULL OR NOT agentonic.can_agent(target_agent,'edit') THEN RAISE insufficient_privilege; END IF;
 -- The latest guide of each account this person connected to the agent.
 RETURN jsonb_build_object('guides',coalesce((SELECT jsonb_agg(agentonic.style_guide_view(g) ORDER BY g.created_at) FROM (
  SELECT DISTINCT ON (g.connection_id) g.* FROM agentonic.style_guides g JOIN agentonic.gmail_connections c ON c.id=g.connection_id
  WHERE g.workspace_id=w AND g.agent_id=target_agent AND g.member_id=m AND c.owner_member_id=m
  ORDER BY g.connection_id,g.created_at DESC) g),'[]'::jsonb));
END $$;

CREATE FUNCTION agentonic.style_guide_command(operation text,payload jsonb,trace_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();allowed text[];c agentonic.gmail_connections;g agentonic.style_guides;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR agentonic.actor_user_id() IS NULL OR w IS NULL OR m IS NULL OR trace_id IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 allowed:=CASE operation WHEN 'start' THEN ARRAY['agentId','connectionId','budgetUsd','consent','requestId'] WHEN 'cancel' THEN ARRAY['id'] WHEN 'discard' THEN ARRAY['id'] WHEN 'accept' THEN ARRAY['id','objectId'] END;
 IF allowed IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR payload-allowed<>'{}' OR NOT(payload ?& allowed) THEN RAISE insufficient_privilege; END IF;
 IF operation='start' THEN
  -- Only the person who connected the account, for an agent they can edit.
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=(payload->>'connectionId')::uuid AND workspace_id=w AND agent_id=(payload->>'agentId')::uuid AND owner_member_id=m FOR UPDATE;
  IF c.id IS NULL OR NOT agentonic.can_agent(c.agent_id,'edit') OR payload->'consent' IS DISTINCT FROM 'true'::jsonb
  OR jsonb_typeof(payload->'budgetUsd') IS DISTINCT FROM 'number' OR (payload->>'budgetUsd')::numeric NOT BETWEEN 0.25 AND 2 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO g FROM agentonic.style_guides WHERE member_id=m AND request_id=(payload->>'requestId')::uuid;
  IF g.id IS NOT NULL THEN
   IF g.connection_id IS DISTINCT FROM c.id OR g.budget_usd IS DISTINCT FROM (payload->>'budgetUsd')::numeric THEN RAISE insufficient_privilege; END IF;
   RETURN jsonb_build_object('ok',true,'id',g.id);
  END IF;
  IF c.status<>'connected' OR c.credential_ciphertext IS NULL THEN RETURN '{"ok":false,"code":"reconnect"}'; END IF;
  IF EXISTS(SELECT 1 FROM agentonic.style_guides WHERE connection_id=c.id AND status IN ('queued','reading','analyzing','writing')) THEN RETURN '{"ok":false,"code":"busy"}'; END IF;
  -- A new run replaces a guide still waiting for a decision.
  UPDATE agentonic.style_guides SET status='discarded',guide=NULL,finished_at=coalesce(finished_at,clock_timestamp()) WHERE connection_id=c.id AND status='ready';
  INSERT INTO agentonic.style_guides(workspace_id,agent_id,connection_id,member_id,request_id,budget_usd,consent)
  VALUES(w,c.agent_id,c.id,m,(payload->>'requestId')::uuid,(payload->>'budgetUsd')::numeric,jsonb_build_object('version','style-consent-v1','acceptedAt',clock_timestamp(),'windowDays',90,'maxMessages',200)) RETURNING * INTO g;
 ELSE
  SELECT * INTO g FROM agentonic.style_guides WHERE id=(payload->>'id')::uuid AND workspace_id=w AND member_id=m FOR UPDATE;
  IF g.id IS NULL OR NOT agentonic.can_agent(g.agent_id,'edit') THEN RAISE insufficient_privilege; END IF;
  IF operation='cancel' THEN
   IF g.status NOT IN ('queued','reading','analyzing','writing') THEN RETURN '{"ok":false,"code":"conflict"}'; END IF;
   UPDATE agentonic.style_guides SET status='cancelled',worker_lease=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE id=g.id;
  ELSIF operation='discard' THEN
   IF g.status<>'ready' THEN RETURN '{"ok":false,"code":"conflict"}'; END IF;
   UPDATE agentonic.style_guides SET status='discarded',guide=NULL WHERE id=g.id;
  ELSE
   -- The accepted text was uploaded as an ordinary document by this person.
   IF g.status<>'ready' OR g.expires_at<=clock_timestamp() THEN RETURN '{"ok":false,"code":"conflict"}'; END IF;
   IF NOT EXISTS(SELECT 1 FROM agentonic.stored_objects o JOIN agentonic.document_versions v ON v.object_id=o.id JOIN agentonic.documents d ON d.id=v.document_id
    JOIN agentonic.knowledge_sources s ON s.id=d.source_id
    WHERE o.id=(payload->>'objectId')::uuid AND o.workspace_id=w AND o.deleted_at IS NULL AND d.deleted_at IS NULL AND s.authorized_by_member_id=m
    AND agentonic.can_collection(s.collection_id,'curate')) THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.style_guides SET status='accepted',guide=NULL,object_id=(payload->>'objectId')::uuid WHERE id=g.id;
  END IF;
 END IF;
 INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,action,resource_type,resource_id,outcome,request_id)
 VALUES(w,agentonic.actor_user_id(),m,'style_guide.'||operation,'style_guide',g.id::text,'succeeded',trace_id::text);
 RETURN jsonb_build_object('ok',true,'id',g.id);
END $$;

-- The knowledge worker's "style" lane. Housekeeping first: guides past their
-- review window are erased, and a run whose lease lapsed fails without retrying
-- (its provider reservations stay charged).
CREATE FUNCTION agentonic.style_guide_claim() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE g agentonic.style_guides; token uuid:=gen_random_uuid();
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 UPDATE agentonic.style_guides SET status='discarded',guide=NULL WHERE status='ready' AND expires_at<=clock_timestamp();
 UPDATE agentonic.style_guides SET status='failed',error_code='lease_lost',worker_lease=NULL,lease_until=NULL,finished_at=clock_timestamp()
 WHERE status IN ('reading','analyzing','writing') AND (lease_until<=clock_timestamp() OR started_at<clock_timestamp()-interval '30 minutes');
 FOR g IN SELECT * FROM agentonic.style_guides WHERE status='queued' ORDER BY created_at LIMIT 20 LOOP
  SELECT * INTO g FROM agentonic.style_guides WHERE id=g.id AND status='queued' FOR UPDATE SKIP LOCKED;
  IF g.id IS NULL THEN CONTINUE; END IF;
  -- The account must still be connected and owned by an active member who can edit the agent.
  IF NOT EXISTS(SELECT 1 FROM agentonic.gmail_connections c JOIN agentonic.workspace_members m ON m.id=c.owner_member_id JOIN agentonic.workspaces ws ON ws.id=c.workspace_id
   WHERE c.id=g.connection_id AND c.owner_member_id=g.member_id AND c.status='connected' AND c.credential_ciphertext IS NOT NULL
   AND m.status='active' AND m.removed_at IS NULL AND ws.status='active' AND ws.deleted_at IS NULL) THEN
   UPDATE agentonic.style_guides SET status='failed',error_code='reconnect',finished_at=clock_timestamp() WHERE id=g.id;
   CONTINUE;
  END IF;
  UPDATE agentonic.style_guides SET status='reading',worker_lease=token,lease_until=clock_timestamp()+interval '90 seconds',started_at=clock_timestamp() WHERE id=g.id;
  RETURN jsonb_build_object('id',g.id,'token',token,'kind','style','lane','style','queuedAt',g.created_at,'connectionId',g.connection_id,'windowDays',g.window_days,'maxMessages',g.max_messages);
 END LOOP;
 RETURN NULL;
END $$;

CREATE FUNCTION agentonic.style_guide_worker(operation text,guide_id uuid,token uuid,payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE g agentonic.style_guides;c agentonic.gmail_connections;amount bigint;budget agentonic.retrieval_provider_budgets;meter agentonic.retrieval_provider_operations;next_status text;
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO g FROM agentonic.style_guides WHERE id=guide_id FOR UPDATE;
 IF g.id IS NULL OR g.status NOT IN ('reading','analyzing','writing') OR g.worker_lease IS DISTINCT FROM token OR g.lease_until<=clock_timestamp() OR g.started_at<clock_timestamp()-interval '30 minutes' THEN RAISE insufficient_privilege; END IF;
 IF operation='fail' THEN
  UPDATE agentonic.style_guides SET status='failed',error_code=CASE WHEN payload->>'code' IN ('not_enough_mail','reconnect','gmail_unavailable','budget_exhausted','provider_unavailable','configuration_required') THEN payload->>'code' ELSE 'lease_lost' END,
  worker_lease=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE id=g.id;
  RETURN '{"ok":true}';
 END IF;
 -- Every other step needs the account still connected and its owner still able to edit the agent.
 SELECT * INTO c FROM agentonic.gmail_connections WHERE id=g.connection_id AND owner_member_id=g.member_id FOR UPDATE;
 IF c.id IS NULL OR NOT EXISTS(SELECT 1 FROM agentonic.workspace_members m WHERE m.id=g.member_id AND m.status='active' AND m.removed_at IS NULL) THEN RAISE insufficient_privilege; END IF;
 IF operation='reconnect' THEN
  UPDATE agentonic.gmail_connections SET status='reconnect',credential_ciphertext=NULL,operations='[]' WHERE id=c.id;
  UPDATE agentonic.style_guides SET status='failed',error_code='reconnect',worker_lease=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE id=g.id;
  RETURN '{"ok":true}';
 END IF;
 IF c.status<>'connected' OR c.credential_ciphertext IS NULL THEN RAISE insufficient_privilege; END IF;
 IF operation='heartbeat' THEN
  UPDATE agentonic.style_guides SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=g.id;
  RETURN '{"ok":true}';
 ELSIF operation='credential' THEN
  RETURN jsonb_build_object('credential',c.credential_ciphertext,'account',c.account,'connectionId',c.id);
 ELSIF operation='progress' THEN
  -- Counts only. Steps move forward: reading, analyzing, writing.
  next_status:=payload->>'status';
  IF next_status NOT IN ('reading','analyzing','writing') OR array_position(ARRAY['reading','analyzing','writing'],next_status)<array_position(ARRAY['reading','analyzing','writing'],g.status)
  OR payload-ARRAY['status','messagesRead','messagesTotal','messagesUsed','batchesDone','batchesTotal']<>'{}' THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.style_guides SET status=next_status,
   messages_read=coalesce((payload->>'messagesRead')::integer,messages_read),messages_total=coalesce((payload->>'messagesTotal')::integer,messages_total),
   messages_used=coalesce((payload->>'messagesUsed')::integer,messages_used),batches_done=coalesce((payload->>'batchesDone')::integer,batches_done),
   batches_total=coalesce((payload->>'batchesTotal')::integer,batches_total),lease_until=clock_timestamp()+interval '90 seconds' WHERE id=g.id;
  RETURN '{"ok":true}';
 ELSIF operation='reserve' THEN
  amount:=(payload->>'microusd')::bigint;
  IF payload->>'provider' IS DISTINCT FROM 'openai' OR payload->>'model' IS DISTINCT FROM 'gpt-5.4-mini' OR amount IS NULL OR amount NOT BETWEEN 1 AND 1000000 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO budget FROM agentonic.retrieval_provider_budgets WHERE provider='openai' FOR UPDATE;
  IF budget.provider IS NULL THEN RAISE insufficient_privilege; END IF;
  IF g.committed_microusd+amount>g.budget_usd*1000000 OR budget.committed_microusd+amount>budget.cap_microusd THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  INSERT INTO agentonic.retrieval_provider_operations(id,job_id,workspace_id,provider,model,reserved_microusd,agent_id) VALUES((payload->>'id')::uuid,g.id,g.workspace_id,'openai','gpt-5.4-mini',amount,g.agent_id);
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd+amount,updated_at=clock_timestamp() WHERE provider='openai';
  UPDATE agentonic.style_guides SET committed_microusd=committed_microusd+amount WHERE id=g.id;
  RETURN '{"ok":true}';
 ELSIF operation='settle' THEN
  SELECT * INTO meter FROM agentonic.retrieval_provider_operations WHERE id=(payload->>'id')::uuid AND job_id=g.id AND status='reserved' FOR UPDATE;
  amount:=(payload->>'microusd')::bigint;
  IF meter.id IS NULL OR amount IS NULL OR amount<0 OR payload->>'tokens' IS NULL OR (payload->>'tokens')::bigint<0 OR coalesce((payload->>'outputTokens')::bigint,0)<0 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.retrieval_provider_operations SET status='settled',actual_microusd=amount,input_tokens=(payload->>'tokens')::bigint,output_tokens=coalesce((payload->>'outputTokens')::bigint,0) WHERE id=meter.id;
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd-meter.reserved_microusd+amount,updated_at=clock_timestamp() WHERE provider=meter.provider;
  UPDATE agentonic.style_guides SET committed_microusd=committed_microusd-meter.reserved_microusd+amount WHERE id=g.id;
  RETURN '{"ok":true}';
 ELSIF operation='ready' THEN
  IF g.status<>'writing' OR jsonb_typeof(payload->'guide') IS DISTINCT FROM 'string' OR length(payload->>'guide') NOT BETWEEN 1 AND 40000 OR payload-ARRAY['guide']<>'{}'
  OR EXISTS(SELECT 1 FROM agentonic.retrieval_provider_operations WHERE job_id=g.id AND status='reserved') THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.style_guides SET status='ready',guide=payload->>'guide',worker_lease=NULL,lease_until=NULL,finished_at=clock_timestamp(),expires_at=clock_timestamp()+interval '7 days' WHERE id=g.id;
  RETURN '{"ok":true}';
 END IF;
 RAISE insufficient_privilege;
END $$;

-- Spend on a guide is attributed to it in usage events and the daily summary.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='agentonic.usage_events'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%unattributed%' LOOP
  EXECUTE format('ALTER TABLE agentonic.usage_events DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE agentonic.usage_events ADD CONSTRAINT usage_events_source_check CHECK(source IN ('run','ingestion','search','evaluation','preparation','style_guide','unattributed'));
CREATE OR REPLACE FUNCTION agentonic.usage_event(o agentonic.retrieval_provider_operations,occurred timestamptz) RETURNS agentonic.usage_events
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
 ELSIF EXISTS(SELECT 1 FROM agentonic.style_guides WHERE id=o.job_id) THEN
  e.source:='style_guide'; e.source_id:=o.job_id; e.agent_id:=o.agent_id;
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

REVOKE ALL ON FUNCTION agentonic.style_guide_view(agentonic.style_guides),agentonic.style_guide_state(uuid),agentonic.style_guide_command(text,jsonb,uuid),agentonic.style_guide_claim(),agentonic.style_guide_worker(text,uuid,uuid,jsonb)
 FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure,agentonic_deployer_local,agentonic_deployer_azure,agentonic_runtime_local,agentonic_runtime_azure;
GRANT EXECUTE ON FUNCTION agentonic.style_guide_state(uuid),agentonic.style_guide_command(text,jsonb,uuid) TO agentonic_customer;
GRANT EXECUTE ON FUNCTION agentonic.style_guide_claim(),agentonic.style_guide_worker(text,uuid,uuid,jsonb) TO agentonic_worker;
