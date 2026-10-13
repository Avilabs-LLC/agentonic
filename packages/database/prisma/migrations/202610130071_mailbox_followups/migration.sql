BEGIN;
-- Mailbox follow-ups (architecture §68, owner decisions 13 October 2026), for
-- runtimes that declare mailboxBatch (0.7.0), before §67's rollout:
--
-- * Whole threads: gmail.threads.read is a model tool authorized by the read
--   grant, so no permission changes; the worker checks gmail.read as before.
-- * Labels: gmail.labels.apply is a new grantable write. One proposal labels a
--   batch and is confirmed once; the subjects it shows are checked before
--   anything changes. It needs Google's gmail.modify scope, so connections
--   record can_label. A reconnect refreshes the same connection, same Google
--   account only, and keeps its tools. Only batch runtimes register the tool.
-- * Answers as they are written: staging_turns and background_jobs hold the
--   partial answer while a turn runs; chat and preview states show it, and it
--   is cleared when the turn leaves running.
-- * Style guide: an accepted Aprender mi estilo guide made for the agent,
--   in a source the version's knowledge includes, reaches batch runtimes'
--   context on every turn, as style only.
--
-- Each function is its live definition (or migration 70's, not yet applied)
-- with only these changes. CREATE OR REPLACE keeps the grants.

ALTER TABLE agentonic.gmail_connections ADD COLUMN can_label boolean NOT NULL DEFAULT false;
ALTER TABLE agentonic.gmail_connections DROP CONSTRAINT gmail_connections_operations_check;
ALTER TABLE agentonic.gmail_connections ADD CONSTRAINT gmail_connections_operations_check CHECK(jsonb_typeof(operations)='array' AND jsonb_array_length(operations)<=9);
ALTER TABLE agentonic.gmail_oauth_states ADD COLUMN reconnects uuid;
ALTER TABLE agentonic.staging_turns ADD COLUMN partial_answer text CHECK(partial_answer IS NULL OR length(partial_answer)<=30000);
ALTER TABLE agentonic.background_jobs ADD COLUMN partial_answer text CHECK(partial_answer IS NULL OR length(partial_answer)<=30000);

-- A partial answer lives only while its turn runs.
CREATE FUNCTION agentonic.clear_partial_answer() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.status IS DISTINCT FROM 'running' THEN NEW.partial_answer:=NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER staging_turn_partial BEFORE UPDATE ON agentonic.staging_turns FOR EACH ROW EXECUTE FUNCTION agentonic.clear_partial_answer();
CREATE TRIGGER background_job_partial BEFORE UPDATE ON agentonic.background_jobs FOR EACH ROW EXECUTE FUNCTION agentonic.clear_partial_answer();

-- The frozen Gmail grant a turn may use: labels only on a connection with gmail.modify.
CREATE FUNCTION agentonic.gmail_tools_usable(tools jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(x.tool),'[]') FROM (
  SELECT CASE WHEN t ? 'connectionId' AND NOT coalesce((SELECT gc.can_label FROM agentonic.gmail_connections gc WHERE gc.id=(t->>'connectionId')::uuid),false)
   THEN jsonb_set(t,'{operations}',coalesce((SELECT jsonb_agg(o) FROM jsonb_array_elements(t->'operations') o WHERE o<>'"gmail.labels.apply"'::jsonb),'[]')) ELSE t END tool
  FROM jsonb_array_elements(coalesce(tools,'[]')) t) x
 WHERE NOT (x.tool ? 'connectionId') OR jsonb_array_length(x.tool->'operations')>0
$$;

-- The latest accepted style guide made for this agent whose document is ready
-- in a source the version's frozen knowledge includes; 12,000 characters at most.
CREATE FUNCTION agentonic.agent_style_guide(agent uuid, access jsonb) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT nullif(left((SELECT string_agg(ch.content,E'\n\n' ORDER BY ch.ordinal) FROM agentonic.document_chunks ch WHERE ch.document_version_id=v.id),12000),'')
 FROM agentonic.style_guides g
 JOIN agentonic.document_versions v ON v.object_id=g.object_id AND v.status='ready'
 JOIN agentonic.documents doc ON doc.id=v.document_id AND doc.active_version_id=v.id AND doc.deleted_at IS NULL
 WHERE g.agent_id=agent AND g.status='accepted' AND g.object_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(access->'collections','[]')) col CROSS JOIN LATERAL jsonb_array_elements(coalesce(col->'sources','[]')) src WHERE src->>'id'=doc.source_id::text)
 ORDER BY g.created_at DESC LIMIT 1
$$;

-- Gmail: labels in the tool lists, the registry and connections.
CREATE OR REPLACE FUNCTION agentonic.valid_gmail_tools(tools jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
DECLARE g jsonb; op text;
BEGIN
 IF jsonb_typeof(tools) IS DISTINCT FROM 'array' OR jsonb_array_length(tools)>1 THEN RETURN false; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(tools) LOOP
  IF jsonb_typeof(g) IS DISTINCT FROM 'object' OR g-ARRAY['connectionId','operations']<>'{}' OR coalesce(g->>'connectionId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(g->'operations') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(g->'operations') NOT BETWEEN 1 AND 9 OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(g->'operations')) THEN RETURN false; END IF;
  FOR op IN SELECT jsonb_array_elements_text(g->'operations') LOOP
   IF op NOT IN ('gmail.search','gmail.read','gmail.drafts.list','gmail.drafts.read','gmail.drafts.create','gmail.drafts.update','gmail.drafts.delete','gmail.send','gmail.labels.apply') THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $function$;

CREATE OR REPLACE FUNCTION agentonic.gmail_register_tools()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE op text; ro boolean;
BEGIN
 IF NEW.execution_manifest->>'gmailContract' IS DISTINCT FROM '1' THEN RETURN NEW; END IF;
 FOREACH op IN ARRAY ARRAY['gmail.search','gmail.read','gmail.drafts.list','gmail.drafts.read','gmail.drafts.create','gmail.drafts.update','gmail.drafts.delete','gmail.send'] LOOP
  ro:=op IN ('gmail.search','gmail.read','gmail.drafts.list','gmail.drafts.read');
  INSERT INTO agentonic.code_tools(code_release_id,package_key,name,implementation_path,input_schema,read_only,requires_confirmation,expose_over_http,policy_contract)
   VALUES(NEW.id,'gmail-v1',op,'broker/gmail-v1','{"contract":"gmail-v1"}',ro,NOT ro,false,jsonb_build_object('environment','staging','ownerOnly',true,'humanConfirmation',NOT ro,'maxCallsPerTurn',3));
 END LOOP;
 -- Labels (§68): only runtimes that run mailbox batch turns.
 IF NEW.execution_manifest->>'mailboxBatch'='1' THEN
  INSERT INTO agentonic.code_tools(code_release_id,package_key,name,implementation_path,input_schema,read_only,requires_confirmation,expose_over_http,policy_contract)
   VALUES(NEW.id,'gmail-v1','gmail.labels.apply','broker/gmail-v1','{"contract":"gmail-v1"}',false,true,false,jsonb_build_object('environment','staging','ownerOnly',true,'humanConfirmation',true,'maxCallsPerTurn',10));
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION agentonic.gmail_command_v29(operation text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();aid uuid:=(payload->>'agentId')::uuid;
 s agentonic.gmail_oauth_states;c agentonic.gmail_connections;i agentonic.gmail_invocations;conv agentonic.staging_conversations;d agentonic.deployments;r agentonic.configuration_releases;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR w IS NULL OR m IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 -- Expired private proposals are erased; only content-free audit remains.
 UPDATE agentonic.gmail_invocations SET status=CASE WHEN status='pending' THEN 'expired' WHEN status='executing' THEN 'uncertain' ELSE status END,arguments_ciphertext=NULL
 WHERE workspace_id=w AND expires_at<=clock_timestamp() AND arguments_ciphertext IS NOT NULL;
 DELETE FROM agentonic.gmail_oauth_states WHERE workspace_id=w AND expires_at<clock_timestamp()-interval '1 hour';
 IF operation IN ('list','oauth.start','permissions') AND (aid IS NULL OR NOT agentonic.can_agent(aid,'edit')) THEN RAISE insufficient_privilege; END IF;
 IF operation='list' THEN
  RETURN jsonb_build_object('connections',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'account',account,'status',status,'operations',operations,'canLabel',can_label) ORDER BY created_at) FROM agentonic.gmail_connections WHERE workspace_id=w AND agent_id=aid AND owner_member_id=m AND status<>'disconnected'),'[]'));
 ELSIF operation='oauth.start' THEN
  IF (SELECT count(*) FROM agentonic.gmail_oauth_states WHERE owner_member_id=m AND expires_at>clock_timestamp())>=5 THEN RAISE insufficient_privilege; END IF;
  -- A reconnect refreshes one of the member's own connections for this agent (§68).
  IF payload ? 'reconnect' AND NOT EXISTS(SELECT 1 FROM agentonic.gmail_connections WHERE id=(payload->>'reconnect')::uuid AND workspace_id=w AND agent_id=aid AND owner_member_id=m AND status<>'disconnected') THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.gmail_oauth_states(state_hash,workspace_id,agent_id,owner_member_id,connection_id,verifier_ciphertext,reconnects) VALUES(payload->>'state',w,aid,m,(payload->>'connectionId')::uuid,payload->>'verifier',(payload->>'reconnect')::uuid); RETURN '{"ok":true}';
 ELSIF operation IN ('oauth.consume','oauth.finish') THEN
  SELECT * INTO s FROM agentonic.gmail_oauth_states WHERE state_hash=payload->>'state' AND workspace_id=w AND owner_member_id=m FOR UPDATE;
  IF s.state_hash IS NULL OR s.expires_at<=clock_timestamp() OR s.finished_at IS NOT NULL OR NOT agentonic.can_agent(s.agent_id,'edit') THEN RAISE insufficient_privilege; END IF;
  IF operation='oauth.consume' THEN
   IF s.consumed_at IS NOT NULL THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_oauth_states SET consumed_at=clock_timestamp() WHERE state_hash=s.state_hash;
   RETURN jsonb_build_object('agentId',s.agent_id,'connectionId',coalesce(s.reconnects,s.connection_id),'verifier',s.verifier_ciphertext);
  END IF;
  IF s.consumed_at IS NULL THEN RAISE insufficient_privilege; END IF;
  IF s.reconnects IS NOT NULL THEN
   SELECT * INTO c FROM agentonic.gmail_connections WHERE id=s.reconnects AND workspace_id=w AND agent_id=s.agent_id AND owner_member_id=m FOR UPDATE;
   -- Only the same Google account refreshes a connection; its tools stay.
   IF c.id IS NULL OR c.status='disconnected' OR lower(c.account)<>lower(payload->>'account') THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_connections SET credential_ciphertext=payload->>'credential',status='connected',can_label=coalesce((payload->>'canLabel')::boolean,false) WHERE id=c.id;
  ELSE
   INSERT INTO agentonic.gmail_connections(id,workspace_id,agent_id,owner_member_id,account,credential_ciphertext,can_label) VALUES(s.connection_id,w,s.agent_id,m,payload->>'account',payload->>'credential',coalesce((payload->>'canLabel')::boolean,false));
  END IF;
  UPDATE agentonic.gmail_oauth_states SET finished_at=clock_timestamp(),verifier_ciphertext='' WHERE state_hash=s.state_hash;
  RETURN jsonb_build_object('agentId',s.agent_id);
 ELSIF operation IN ('disconnect','permissions','credential','reconnect') THEN
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=(payload->>'connectionId')::uuid AND workspace_id=w AND owner_member_id=m FOR UPDATE;
  IF c.id IS NULL OR NOT agentonic.can_agent(c.agent_id,'edit') THEN RAISE insufficient_privilege; END IF;
  IF operation='disconnect' THEN
   UPDATE agentonic.gmail_connections SET status='disconnected',credential_ciphertext=NULL,operations='[]' WHERE id=c.id;
   UPDATE agentonic.gmail_invocations SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,arguments_ciphertext=NULL WHERE connection_id=c.id;
   RETURN jsonb_build_object('credential',c.credential_ciphertext);
  ELSIF operation='reconnect' THEN
   UPDATE agentonic.gmail_connections SET status='reconnect',credential_ciphertext=NULL,operations='[]' WHERE id=c.id; RETURN '{"ok":true}';
  ELSIF operation='permissions' THEN
   IF c.agent_id<>aid OR c.status<>'connected' OR (payload->'operations' ? 'gmail.labels.apply' AND NOT c.can_label) OR NOT agentonic.valid_gmail_tools(jsonb_build_array(jsonb_build_object('connectionId',c.id,'operations',payload->'operations'))) AND payload->'operations'<>'[]' THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_connections SET operations=payload->'operations' WHERE id=c.id; RETURN '{"ok":true}';
  ELSE RAISE insufficient_privilege; END IF;
 ELSIF operation IN ('invocations','inspect','confirm','cancel','complete') THEN
  IF operation='invocations' THEN
   SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=(payload->>'conversationId')::uuid AND workspace_id=w AND owner_member_id=m;
   IF conv.id IS NULL OR NOT agentonic.staging_conversation_readable(conv) THEN RAISE insufficient_privilege; END IF;
   RETURN jsonb_build_object('items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'operation',v.operation,'account',gc.account,'status',v.status,'hash',v.arguments_sha256,'expiresAt',v.expires_at,'argumentsCiphertext',v.arguments_ciphertext,'result',v.result,'automatic',v.approved_by_schedule_id IS NOT NULL) ORDER BY v.created_at) FROM agentonic.gmail_invocations v JOIN agentonic.gmail_connections gc ON gc.id=v.connection_id WHERE v.conversation_id=conv.id AND v.owner_member_id=m AND gc.status='connected'),'[]'));
  END IF;
  SELECT * INTO i FROM agentonic.gmail_invocations WHERE id=(payload->>'id')::uuid AND workspace_id=w AND owner_member_id=m FOR UPDATE;
  IF i.id IS NULL THEN RAISE insufficient_privilege; END IF;
  IF operation='complete' THEN
   IF i.status<>'executing' OR payload->>'status' NOT IN ('succeeded','failed','uncertain') THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_invocations SET status=payload->>'status',result=payload->'result',finished_at=clock_timestamp(),arguments_ciphertext=NULL WHERE id=i.id; RETURN '{"ok":true}';
  END IF;
  SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=i.conversation_id AND owner_member_id=m;
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=i.connection_id;
  SELECT * INTO d FROM agentonic.deployments WHERE id=conv.deployment_id;
  SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
  IF NOT agentonic.staging_conversation_authorized(conv) OR NOT agentonic.gmail_allowed(c,m,i.agent_id,i.operation)
   OR NOT (r.requested_access_snapshot->'tools') @> jsonb_build_array(jsonb_build_object('connectionId',c.id,'operations',jsonb_build_array(i.operation))) THEN RAISE insufficient_privilege; END IF;
  IF operation='cancel' THEN
   IF i.status<>'pending' THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_invocations SET status='cancelled',arguments_ciphertext=NULL WHERE id=i.id; RETURN '{"ok":true}';
  END IF;
  IF i.status<>'pending' OR i.expires_at<=clock_timestamp() OR i.arguments_ciphertext IS NULL OR i.arguments_sha256 IS DISTINCT FROM payload->>'hash' OR i.approved_by_schedule_id IS NOT NULL THEN RAISE insufficient_privilege; END IF;
  IF operation='confirm' THEN
   UPDATE agentonic.gmail_invocations SET status='executing',approved_at=clock_timestamp() WHERE id=i.id;
  END IF;
  RETURN jsonb_build_object('credential',c.credential_ciphertext,'connectionId',c.id,'account',c.account,'argumentsCiphertext',i.arguments_ciphertext,'operation',i.operation);
 END IF;
 RAISE insufficient_privilege;
END $function$;

-- Turns: usable grants and label proposals.
CREATE OR REPLACE FUNCTION agentonic.gmail_staging(operation text, deployment_id uuid, secret text, job_id uuid, token uuid, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
DECLARE d agentonic.deployments;conv agentonic.staging_conversations;t agentonic.staging_turns;r agentonic.configuration_releases;c agentonic.gmail_connections;g jsonb;op text:=payload->>'operation';
BEGIN
 PERFORM agentonic.staging_worker('heartbeat',deployment_id,secret,job_id,token,'{}');
 SELECT * INTO d FROM agentonic.deployments WHERE id=deployment_id;
 SELECT * INTO t FROM agentonic.staging_turns WHERE id=job_id;
 SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=t.conversation_id;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
 IF NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=r.code_release_id AND execution_manifest->>'gmailContract'='1') THEN RAISE insufficient_privilege; END IF;
 IF operation='gmail-tools' THEN RETURN jsonb_build_object('tools',agentonic.gmail_tools_usable(r.requested_access_snapshot->'tools')); END IF;
 SELECT value INTO g FROM jsonb_array_elements(r.requested_access_snapshot->'tools') WHERE value->>'connectionId'=payload->>'connectionId' AND value->'operations' ? op;
 SELECT * INTO c FROM agentonic.gmail_connections WHERE id=(g->>'connectionId')::uuid AND workspace_id=d.workspace_id AND agent_id=d.agent_id FOR UPDATE;
 IF NOT agentonic.gmail_allowed(c,conv.owner_member_id,d.agent_id,op) THEN RAISE insufficient_privilege; END IF;
 IF operation='gmail-read' AND op IN ('gmail.search','gmail.read','gmail.drafts.list','gmail.drafts.read') THEN RETURN jsonb_build_object('credential',c.credential_ciphertext,'account',c.account); END IF;
 IF operation='gmail-reconnect' THEN
  UPDATE agentonic.gmail_connections SET status='reconnect',credential_ciphertext=NULL,operations='[]' WHERE id=c.id;
  UPDATE agentonic.gmail_invocations SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,arguments_ciphertext=NULL WHERE connection_id=c.id;
  RETURN '{"ok":true}';
 END IF;
 IF operation='gmail-check' THEN RETURN '{"ok":true}'; END IF;
 IF operation='gmail-propose' AND op IN ('gmail.drafts.create','gmail.drafts.update','gmail.drafts.delete','gmail.send','gmail.labels.apply') AND (op<>'gmail.labels.apply' OR c.can_label) THEN
  IF (SELECT count(*) FROM agentonic.gmail_invocations WHERE turn_id=job_id)>=10 OR (SELECT count(*) FROM agentonic.gmail_invocations WHERE owner_member_id=conv.owner_member_id AND created_at>clock_timestamp()-interval '1 hour')>=30 THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.gmail_invocations(id,workspace_id,agent_id,connection_id,owner_member_id,turn_id,conversation_id,operation,arguments_ciphertext,arguments_sha256)
  VALUES((payload->>'id')::uuid,d.workspace_id,d.agent_id,c.id,conv.owner_member_id,job_id,conv.id,op,payload->>'argumentsCiphertext',payload->>'hash');
  RETURN jsonb_build_object('pendingApproval',true,'id',payload->>'id','automatic',(SELECT approved_by_schedule_id IS NOT NULL FROM agentonic.gmail_invocations WHERE id=(payload->>'id')::uuid));
 END IF;
 RAISE insufficient_privilege;
END $function$;

CREATE OR REPLACE FUNCTION agentonic.gmail_preview_worker(operation text, job_id uuid, token uuid, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
DECLARE j agentonic.background_jobs;p agentonic.agent_previews;c agentonic.gmail_connections;g jsonb;op text:=payload->>'operation';
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 PERFORM agentonic.rag_worker('heartbeat',job_id,token,'{}');
 SELECT * INTO j FROM agentonic.background_jobs WHERE id=job_id;
 SELECT * INTO p FROM agentonic.agent_previews WHERE id=j.preview_id AND workspace_id=j.workspace_id AND requested_by_member_id=j.member_id;
 IF p.id IS NULL OR NOT agentonic.preview_authorized(p) THEN RAISE insufficient_privilege; END IF;
 IF operation='gmail-tools' THEN RETURN jsonb_build_object('tools',agentonic.gmail_tools_usable(p.execution_policy->'tools')); END IF;
 SELECT value INTO g FROM jsonb_array_elements(p.execution_policy->'tools') WHERE value->>'connectionId'=payload->>'connectionId' AND value->'operations' ? op;
 SELECT * INTO c FROM agentonic.gmail_connections WHERE id=(g->>'connectionId')::uuid AND workspace_id=p.workspace_id AND agent_id=p.agent_id FOR UPDATE;
 IF NOT agentonic.gmail_allowed(c,p.requested_by_member_id,p.agent_id,op) THEN RAISE insufficient_privilege; END IF;
 IF operation='gmail-read' AND op IN ('gmail.search','gmail.read','gmail.drafts.list','gmail.drafts.read') THEN RETURN jsonb_build_object('credential',c.credential_ciphertext,'account',c.account); END IF;
 IF operation='gmail-check' THEN RETURN '{"ok":true}'; END IF;
 IF operation='gmail-reconnect' THEN
  UPDATE agentonic.gmail_connections SET status='reconnect',credential_ciphertext=NULL,operations='[]' WHERE id=c.id;
  UPDATE agentonic.gmail_invocations SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,arguments_ciphertext=NULL WHERE connection_id=c.id;
  RETURN '{"ok":true}';
 END IF;
 IF operation='gmail-propose' AND op IN ('gmail.drafts.create','gmail.drafts.update','gmail.drafts.delete','gmail.send','gmail.labels.apply') AND (op<>'gmail.labels.apply' OR c.can_label) THEN
  IF (SELECT count(*) FROM agentonic.gmail_invocations WHERE turn_id=job_id)>=10 OR (SELECT count(*) FROM agentonic.gmail_invocations WHERE owner_member_id=p.requested_by_member_id AND created_at>clock_timestamp()-interval '1 hour')>=30 THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.gmail_invocations(id,workspace_id,agent_id,connection_id,owner_member_id,turn_id,conversation_id,operation,arguments_ciphertext,arguments_sha256,expires_at,execution_context)
  VALUES((payload->>'id')::uuid,p.workspace_id,p.agent_id,c.id,p.requested_by_member_id,job_id,p.id,op,payload->>'argumentsCiphertext',payload->>'hash',least(p.expires_at,clock_timestamp()+interval '10 minutes'),'preview');
  RETURN jsonb_build_object('pendingApproval',true,'id',payload->>'id');
 END IF;
 RAISE insufficient_privilege;
END $function$;

-- Chat turns: partial answers and the style guide.
CREATE OR REPLACE FUNCTION agentonic.staging_worker(operation text, deployment_id uuid, secret text, job_id uuid, token uuid, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
DECLARE d agentonic.deployments;c agentonic.staging_conversations;t agentonic.staging_turns;r agentonic.configuration_releases;code agentonic.code_releases;
 hits jsonb;assets jsonb;history jsonb;budget agentonic.retrieval_provider_budgets;meter agentonic.retrieval_provider_operations;amount bigint;slot text;
BEGIN
 SELECT * INTO d FROM agentonic.deployments WHERE id=deployment_id;
 -- The serving copy works; a draining copy only finishes the turn it leased.
 IF coalesce(agentonic.deployment_copy(d,secret) NOT IN ('serving','draining'),true) THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=d.workspace_id FOR SHARE;
 SELECT * INTO d FROM agentonic.deployments WHERE id=deployment_id FOR UPDATE;
 slot:=agentonic.deployment_copy(d,secret);
 IF coalesce(slot NOT IN ('serving','draining'),true) OR d.status<>'running' OR d.desired_state<>'running' OR NOT agentonic.deployment_authorized(d) THEN RAISE insufficient_privilege; END IF;
 IF operation='claim' THEN
  IF slot='draining' THEN RETURN NULL; END IF;
  UPDATE agentonic.staging_turns turn SET status='failed',error_code='lease_lost',lease_token=NULL,lease_until=NULL
   FROM agentonic.staging_conversations conv WHERE conv.id=turn.conversation_id AND conv.deployment_id=d.id AND turn.status='running' AND (turn.lease_until<=clock_timestamp() OR turn.started_at<clock_timestamp()-agentonic.staging_turn_window(d.code_release_id));
  SELECT turn.* INTO t FROM agentonic.staging_turns turn JOIN agentonic.staging_conversations conv ON conv.id=turn.conversation_id
   WHERE conv.deployment_id=d.id AND turn.status='queued' AND agentonic.staging_conversation_authorized(conv) ORDER BY turn.created_at LIMIT 1 FOR UPDATE OF turn SKIP LOCKED;
  IF t.id IS NULL THEN RETURN NULL; END IF;
  UPDATE agentonic.staging_turns SET status='running',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '90 seconds',started_at=clock_timestamp() WHERE id=t.id RETURNING * INTO t;
  RETURN jsonb_build_object('id',t.id,'token',t.lease_token,'kind','retrieve','queuedAt',t.created_at);
 END IF;
 SELECT turn.* INTO t FROM agentonic.staging_turns turn JOIN agentonic.staging_conversations conv ON conv.id=turn.conversation_id WHERE turn.id=job_id AND conv.deployment_id=d.id FOR UPDATE OF turn;
 IF t.id IS NULL OR t.status<>'running' OR t.lease_token IS DISTINCT FROM token OR t.lease_until<=clock_timestamp() OR t.started_at<clock_timestamp()-agentonic.staging_turn_window(d.code_release_id) THEN RAISE insufficient_privilege; END IF;
 IF operation='fail' THEN
  UPDATE agentonic.staging_turns SET status='failed',error_code=CASE WHEN payload->>'code' IN ('provider_unavailable','budget_exhausted','configuration_required','runtime_mismatch') THEN payload->>'code' ELSE 'lease_lost' END,lease_token=NULL,lease_until=NULL WHERE id=t.id;
  RETURN '{"ok":true}';
 END IF;
 SELECT * INTO c FROM agentonic.staging_conversations WHERE id=t.conversation_id;
 IF NOT agentonic.staging_conversation_authorized(c) THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
 SELECT * INTO code FROM agentonic.code_releases WHERE id=d.code_release_id;
 -- The answer as it is written, shown while the turn runs (§68): batch runtimes only.
 IF operation='partial' THEN
  IF code.execution_manifest->>'mailboxBatch' IS DISTINCT FROM '1' OR jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR length(payload->>'text')>30000 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.staging_turns SET partial_answer=payload->>'text' WHERE id=t.id;
  RETURN '{"ok":true}';
 END IF;
 IF operation='heartbeat' THEN
  UPDATE agentonic.staging_turns SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=t.id;
  RETURN '{"ok":true}';
 ELSIF operation='read' THEN
  RETURN jsonb_build_object('kind','retrieve','workspaceId',d.workspace_id,'query',t.query,'retrievalQuery',concat_ws(E'\n',(SELECT string_agg(p.query,E'\n' ORDER BY p.number) FROM (SELECT query,number FROM agentonic.staging_turns WHERE conversation_id=c.id AND number<t.number AND status='succeeded' ORDER BY number DESC LIMIT 2) p),t.query),
   'generateAnswer',true,'preview',true,'hasCollections',jsonb_array_length(r.requested_access_snapshot->'collectionIds')>0,
   'runtime',jsonb_build_object('gitCommit',code.git_commit_sha,'artifactSha256',code.artifact_sha256,'manifest',code.execution_manifest));
 ELSIF operation='reserve' THEN
  IF NOT coalesce((payload->>'provider'='voyage' AND (payload->>'model'='voyage-4' OR payload->>'model'='rerank-2.5-lite')) OR (payload->>'provider'='openai' AND payload->>'model'=t.response_model),false) THEN RAISE insufficient_privilege; END IF;
  amount:=(payload->>'microusd')::bigint;
  IF amount IS NULL OR amount NOT BETWEEN 1 AND 5000000 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO budget FROM agentonic.retrieval_provider_budgets WHERE provider=payload->>'provider' FOR UPDATE;
  IF budget.provider IS NULL THEN RAISE insufficient_privilege; END IF;
  IF d.committed_microusd+amount>d.budget_usd*1000000 OR budget.committed_microusd+amount>budget.cap_microusd THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  INSERT INTO agentonic.retrieval_provider_operations(id,job_id,workspace_id,provider,model,reserved_microusd,agent_id,deployment_id,conversation_id)
   VALUES((payload->>'id')::uuid,t.id,d.workspace_id,budget.provider,payload->>'model',amount,d.agent_id,d.id,c.id);
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd+amount,updated_at=clock_timestamp() WHERE provider=budget.provider;
  UPDATE agentonic.deployments SET committed_microusd=committed_microusd+amount WHERE id=d.id;
  RETURN '{"ok":true}';
 ELSIF operation='settle' THEN
  SELECT * INTO meter FROM agentonic.retrieval_provider_operations op WHERE op.id=(payload->>'id')::uuid AND op.job_id=t.id AND op.deployment_id=d.id AND op.status='reserved' FOR UPDATE;
  amount:=(payload->>'microusd')::bigint;
  IF meter.id IS NULL OR amount IS NULL OR amount<0 OR payload->>'tokens' IS NULL OR (payload->>'tokens')::bigint<0 OR coalesce((payload->>'outputTokens')::bigint,0)<0 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.retrieval_provider_operations SET status='settled',actual_microusd=amount,input_tokens=(payload->>'tokens')::bigint,output_tokens=coalesce((payload->>'outputTokens')::bigint,0) WHERE id=meter.id;
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd-meter.reserved_microusd+amount,updated_at=clock_timestamp() WHERE provider=meter.provider;
  UPDATE agentonic.deployments SET committed_microusd=committed_microusd-meter.reserved_microusd+amount WHERE id=d.id;
  RETURN '{"ok":true}';
 ELSIF operation='empty-search' THEN
  IF jsonb_array_length(r.requested_access_snapshot->'collectionIds')<>0 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.staging_turns SET matches='[]' WHERE id=t.id; RETURN '{"ok":true}';
 ELSIF operation='search' THEN
  IF jsonb_typeof(payload->'embedding') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'embedding')<>1024 THEN RAISE insufficient_privilege; END IF;
  WITH eligible AS MATERIALIZED (
   SELECT ch.* FROM agentonic.document_chunks ch JOIN agentonic.document_versions v ON v.id=ch.document_version_id JOIN agentonic.documents doc ON doc.id=v.document_id AND doc.active_version_id=v.id
   WHERE ch.workspace_id=d.workspace_id AND v.status='ready' AND doc.deleted_at IS NULL
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.requested_access_snapshot->'collections') col CROSS JOIN LATERAL jsonb_array_elements(col->'sources') src WHERE src->>'id'=doc.source_id::text)
  ), semantic AS (
   SELECT id,row_number() OVER(ORDER BY embedding OPERATOR(public.<=>) (payload->'embedding')::text::public.vector,id) rank FROM eligible ORDER BY embedding OPERATOR(public.<=>) (payload->'embedding')::text::public.vector,id LIMIT 40
  ), lexical AS (
   SELECT id,row_number() OVER(ORDER BY ts_rank_cd(search_vector,q) DESC,id) rank FROM eligible,LATERAL(SELECT websearch_to_tsquery('pg_catalog.simple',t.query)||websearch_to_tsquery('pg_catalog.spanish',t.query)||websearch_to_tsquery('pg_catalog.english',t.query) q) query WHERE search_vector@@q ORDER BY ts_rank_cd(search_vector,q) DESC,id LIMIT 40
  ), ranked AS (
   SELECT coalesce(s.id,l.id) id,coalesce(1.0/(60+s.rank),0)+coalesce(1.0/(60+l.rank),0) score FROM semantic s FULL JOIN lexical l ON s.id=l.id ORDER BY score DESC,coalesce(s.id,l.id) LIMIT CASE WHEN payload->>'rerank'='true' THEN 32 ELSE 8 END
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',ranked.id,'hash',ch.content_sha256) ORDER BY ranked.score DESC,ranked.id),'[]') INTO hits FROM ranked JOIN agentonic.document_chunks ch ON ch.id=ranked.id;
  UPDATE agentonic.staging_turns SET matches=hits WHERE id=t.id; RETURN '{"ok":true}';
 ELSIF operation IN ('context','answer','rerank-context','select-matches') THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',ch.id,'text',ch.content) ORDER BY hit.ordinality),'[]') INTO hits
   FROM jsonb_array_elements(t.matches) WITH ORDINALITY hit(value,ordinality) JOIN agentonic.document_chunks ch ON ch.id=(hit.value->>'id')::uuid AND ch.workspace_id=d.workspace_id AND ch.content_sha256=hit.value->>'hash'
   JOIN agentonic.document_versions v ON v.id=ch.document_version_id JOIN agentonic.documents doc ON doc.id=v.document_id AND doc.active_version_id=v.id WHERE doc.deleted_at IS NULL AND v.status='ready';
  IF jsonb_array_length(hits)<>jsonb_array_length(t.matches) THEN RAISE insufficient_privilege; END IF;
  IF operation='rerank-context' THEN RETURN jsonb_build_object('passages',hits); END IF;
  IF operation='select-matches' THEN
   IF EXISTS(SELECT 1 FROM agentonic.retrieval_provider_operations op WHERE op.job_id=t.id AND op.status='reserved') THEN RAISE insufficient_privilege; END IF;
   hits:=agentonic.select_retrieval_matches(t.matches,payload->'ids');
   UPDATE agentonic.staging_turns SET matches=hits WHERE id=t.id;
   RETURN '{"ok":true}';
  END IF;
  IF jsonb_array_length(hits)>8 THEN RAISE insufficient_privilege; END IF;
  IF operation='context' THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('path','skills/'||(s->>'name')||'.md','sha256',encode(sha256(convert_to(s->>'instructions','UTF8')),'hex')) ORDER BY s->>'name'),'[]') INTO assets FROM jsonb_array_elements(r.content->'skills') s;
   assets:=jsonb_build_array(jsonb_build_object('path','prompts/system.md','sha256',encode(sha256(convert_to(r.content->>'systemPrompt','UTF8')),'hex')))||assets;
   -- Batch runtimes (§67) see each earlier turn's Gmail actions, IDs and outcomes only (B8);
   -- earlier runtimes keep answers within their 12,000 characters.
   SELECT coalesce(jsonb_agg(jsonb_build_object('query',p.query,'answer',p.answer)||CASE WHEN p.actions IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('actions',p.actions) END ORDER BY p.number),'[]') INTO history
    FROM (SELECT q.query,CASE WHEN code.execution_manifest->>'mailboxBatch'='1' THEN q.answer ELSE left(q.answer,12000) END answer,q.number,
     CASE WHEN code.execution_manifest->>'mailboxBatch'='1' THEN agentonic.turn_gmail_actions(q.id) END actions
     FROM agentonic.staging_turns q WHERE q.conversation_id=c.id AND q.number<t.number AND q.status='succeeded' ORDER BY q.number DESC LIMIT 9) p;
   RETURN jsonb_build_object('previewModel',t.response_model,'reasoningLevel',t.reasoning_effort,'query',t.query,'passages',hits,'environment','staging','audience','private','expiresAt',least(c.expires_at,t.started_at+agentonic.staging_turn_window(d.code_release_id)),
    'configurationJson',r.content::text,'contentSha256',r.content_sha256,'composedPromptSha256',r.composed_prompt_sha256,'assetManifestJson',assets::text,'assetManifestSha256',r.asset_manifest_sha256,'accessJson',r.requested_access_snapshot::text,'accessSha256',r.requested_access_sha256,'history',history)
    -- The owner's writing style for batch runtimes (§68).
    ||CASE WHEN code.execution_manifest->>'mailboxBatch'='1' THEN jsonb_strip_nulls(jsonb_build_object('styleGuide',agentonic.agent_style_guide(d.agent_id,r.requested_access_snapshot))) ELSE '{}'::jsonb END;
  END IF;
  IF jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR length(payload->>'text') NOT BETWEEN 1 AND 30000 OR jsonb_typeof(payload->'citations') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'citations')>8 OR jsonb_typeof(payload->'insufficientEvidence') IS DISTINCT FROM 'boolean' OR payload->>'model' IS DISTINCT FROM t.response_model
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(payload->'citations') citation WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(hits) h WHERE h->>'id'=citation))
   OR (jsonb_array_length(hits)>0 AND payload->'insufficientEvidence'='false' AND jsonb_array_length(payload->'citations')=0) THEN RAISE insufficient_privilege; END IF;
  IF d.committed_microusd>d.budget_usd*1000000 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.staging_turns SET status='succeeded',answer=payload->>'text',citations=payload->'citations',insufficient_evidence=(payload->>'insufficientEvidence')::boolean,lease_token=NULL,lease_until=NULL WHERE id=t.id;
  RETURN '{"ok":true}';
 END IF;
 RAISE insufficient_privilege;
END $function$;

CREATE OR REPLACE FUNCTION agentonic.staging_chat(operation text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();c agentonic.staging_conversations;d agentonic.deployments;t agentonic.staging_turns;n integer;items jsonb;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR w IS NULL OR m IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 IF operation='list' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c1.id,'agentId',c1.agent_id,'agentName',a.name,'deploymentId',c1.deployment_id,'title',c1.title,'expiresAt',c1.expires_at) ORDER BY c1.created_at DESC),'[]') INTO items
   FROM agentonic.staging_conversations c1 JOIN agentonic.agents a ON a.id=c1.agent_id WHERE c1.workspace_id=w AND c1.owner_member_id=m AND agentonic.staging_conversation_readable(c1) AND agentonic.can_agent(c1.agent_id,'invoke');
  RETURN jsonb_build_object('ok',true,'conversations',items,'agents',coalesce((SELECT jsonb_agg(jsonb_build_object('id',dep.id,'agentId',dep.agent_id,'name',a.name,'environment',dep.environment)) FROM agentonic.deployments dep JOIN agentonic.agents a ON a.id=dep.agent_id WHERE dep.workspace_id=w AND dep.authorized_by_member_id=m AND dep.status='running' AND agentonic.deployment_online(dep) AND agentonic.deployment_authorized(dep) AND agentonic.can_agent(dep.agent_id,'invoke')),'[]'::jsonb));
 ELSIF operation='start' THEN
  SELECT * INTO d FROM agentonic.deployments WHERE id=(payload->>'deploymentId')::uuid AND workspace_id=w AND authorized_by_member_id=m;
  IF d.id IS NULL OR d.status<>'running' OR NOT agentonic.deployment_online(d) OR NOT agentonic.deployment_authorized(d) OR NOT agentonic.can_agent(d.agent_id,'invoke') THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
  IF (SELECT count(*) FROM agentonic.staging_conversations WHERE owner_member_id=m AND created_at>clock_timestamp()-interval '1 minute')>=5 THEN RETURN '{"ok":false,"code":"rate_limit"}'; END IF;
  INSERT INTO agentonic.staging_conversations(workspace_id,agent_id,deployment_id,owner_member_id,title,expires_at)
   VALUES(w,d.agent_id,d.id,m,btrim(payload->>'title'),clock_timestamp()+interval '30 days') RETURNING * INTO c;
  RETURN jsonb_build_object('ok',true,'id',c.id);
 END IF;
 SELECT * INTO c FROM agentonic.staging_conversations WHERE id=(payload->>'conversationId')::uuid AND workspace_id=w AND owner_member_id=m FOR UPDATE;
 IF c.id IS NULL OR NOT agentonic.can_agent(c.agent_id,'invoke') THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 IF operation='close' THEN
  UPDATE agentonic.staging_conversations SET closed_at=clock_timestamp() WHERE id=c.id;
  UPDATE agentonic.staging_turns SET query='',answer=NULL,citations='[]',matches='[]',scrubbed_at=clock_timestamp(),status=CASE WHEN status IN ('queued','running') THEN 'cancelled' ELSE status END,lease_token=NULL,lease_until=NULL WHERE conversation_id=c.id;
  RETURN '{"ok":true}';
 END IF;
 IF NOT agentonic.staging_conversation_readable(c) THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 SELECT * INTO d FROM agentonic.deployments WHERE id=c.deployment_id;
 IF operation='turn' THEN
  IF NOT agentonic.staging_conversation_authorized(c) THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
  payload:=jsonb_build_object('model',agentonic.deployment_models(d)->0->>'model','reasoning',agentonic.deployment_models(d)->0->'reasoning')||payload;
  IF NOT agentonic.deployment_models(d) @> jsonb_build_array(jsonb_build_object('model',payload->>'model','reasoning',payload->'reasoning')) THEN RAISE insufficient_privilege; END IF;
  IF NOT agentonic.deployment_online(d) THEN RETURN '{"ok":false,"code":"offline"}'; END IF;
  SELECT * INTO t FROM agentonic.staging_turns WHERE conversation_id=c.id AND request_id=(payload->>'requestId')::uuid;
  IF t.id IS NOT NULL THEN
   IF t.query IS DISTINCT FROM btrim(payload->>'query') OR t.response_model IS DISTINCT FROM payload->>'model' OR t.reasoning_effort IS DISTINCT FROM payload->>'reasoning' THEN RETURN '{"ok":false,"code":"request_conflict"}'; END IF;
   RETURN jsonb_build_object('ok',true,'id',t.id); END IF;
  IF EXISTS(SELECT 1 FROM agentonic.staging_turns WHERE conversation_id=c.id AND status IN ('queued','running')) THEN RETURN '{"ok":false,"code":"busy"}'; END IF;
  IF length(btrim(payload->>'query')) NOT BETWEEN 1 AND 1000 OR payload->>'query' IS NULL THEN RAISE insufficient_privilege; END IF;
  SELECT coalesce(max(number),0)+1 INTO n FROM agentonic.staging_turns WHERE conversation_id=c.id;
  IF n>100 THEN RETURN '{"ok":false,"code":"turn_limit"}'; END IF;
  IF (SELECT count(*) FROM agentonic.staging_turns t1 JOIN agentonic.staging_conversations c1 ON c1.id=t1.conversation_id WHERE c1.owner_member_id=m AND t1.created_at>clock_timestamp()-interval '1 minute')>=10 THEN RETURN '{"ok":false,"code":"rate_limit"}'; END IF;
  INSERT INTO agentonic.staging_turns(workspace_id,conversation_id,request_id,number,query,response_model,reasoning_effort) VALUES(w,c.id,(payload->>'requestId')::uuid,n,btrim(payload->>'query'),payload->>'model',payload->>'reasoning') RETURNING * INTO t;
  RETURN jsonb_build_object('ok',true,'id',t.id);
 ELSIF operation='state' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',t1.id,'number',t1.number,'model',t1.response_model,'reasoning',t1.reasoning_effort,'query',t1.query,'answer',t1.answer,'partial',CASE WHEN t1.status='running' THEN t1.partial_answer END,'citations',t1.citations,'status',t1.status,'errorCode',t1.error_code,
   'version',(SELECT count(*)::int FROM agentonic.deployments dep JOIN agentonic.configuration_releases r ON r.id=dep.configuration_release_id JOIN agentonic.configuration_releases v ON v.agent_id=r.agent_id AND (v.created_at,v.id)<=(r.created_at,r.id) WHERE dep.id=coalesce(t1.deployment_id,c.deployment_id))) ORDER BY t1.number),'[]') INTO items FROM agentonic.staging_turns t1 WHERE t1.conversation_id=c.id;
  RETURN jsonb_build_object('ok',true,'id',c.id,'title',c.title,'agentId',c.agent_id,'expiresAt',c.expires_at,'canSend',agentonic.staging_conversation_authorized(c),'online',agentonic.deployment_online(d),'budgetUsd',d.budget_usd,'committedMicrousd',d.committed_microusd,'turns',items,'models',agentonic.deployment_models(d));
 END IF;
 RAISE insufficient_privilege;
END $function$;

-- Previews: partial answers and the style guide.
CREATE OR REPLACE FUNCTION agentonic.rag_worker(operation text, job_id uuid, token uuid, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
DECLARE j agentonic.background_jobs; p agentonic.agent_previews; r agentonic.configuration_releases; c agentonic.code_releases;
 response jsonb; assets jsonb; history jsonb; before_amount bigint; meter agentonic.retrieval_provider_operations;
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO j FROM agentonic.background_jobs WHERE id=job_id;
 IF j.id IS NULL THEN RAISE insufficient_privilege; END IF;
 IF j.preview_id IS NULL THEN RETURN agentonic.rag_worker_core_v8(operation,job_id,token,payload); END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=j.workspace_id FOR SHARE;
 SELECT * INTO p FROM agentonic.agent_previews WHERE id=j.preview_id FOR UPDATE;
 SELECT * INTO j FROM agentonic.background_jobs WHERE id=job_id FOR UPDATE;
 IF j.status<>'running' OR j.lease_token IS DISTINCT FROM token OR j.lease_until<=clock_timestamp() OR NOT agentonic.rag_job_authorized(j) THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=p.configuration_release_id;
 SELECT * INTO c FROM agentonic.code_releases WHERE id=p.code_release_id;
 IF operation='read' THEN
  RETURN jsonb_build_object('kind','retrieve','workspaceId',j.workspace_id,'query',j.payload->>'query','retrievalQuery',concat_ws(E'\n',(SELECT string_agg(previous.payload->>'query',E'\n' ORDER BY previous.turn_number) FROM (SELECT prior.payload,prior.turn_number FROM agentonic.background_jobs prior WHERE prior.preview_id=p.id AND prior.turn_number<j.turn_number AND prior.status='succeeded' ORDER BY prior.turn_number DESC LIMIT 2) previous),j.payload->>'query'),'generateAnswer',true,'preview',true,'hasCollections',jsonb_array_length(j.payload->'collectionIds')>0,
   'runtime',jsonb_build_object('gitCommit',c.git_commit_sha,'artifactSha256',c.artifact_sha256,'manifest',c.execution_manifest));
 ELSIF operation='empty-search' THEN
  IF jsonb_array_length(j.payload->'collectionIds')<>0 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.background_jobs SET result='{"matches":[]}' WHERE id=j.id;
  RETURN '{"ok":true}';
 ELSIF operation='partial' THEN
  -- The answer as it is written, shown while the preview turn runs (§68).
  IF c.execution_manifest->>'mailboxBatch' IS DISTINCT FROM '1' OR jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR length(payload->>'text')>30000 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.background_jobs SET partial_answer=payload->>'text' WHERE id=j.id;
  RETURN '{"ok":true}';
 ELSIF operation='context' THEN
  response:=agentonic.rag_worker_core_v8('context',job_id,token,'{}');
  SELECT coalesce(jsonb_agg(jsonb_build_object('path','skills/'||(s->>'name')||'.md','sha256',encode(sha256(convert_to(s->>'instructions','UTF8')),'hex')) ORDER BY s->>'name'),'[]') INTO assets FROM jsonb_array_elements(r.content->'skills') s;
  assets:=jsonb_build_array(jsonb_build_object('path','prompts/system.md','sha256',encode(sha256(convert_to(r.content->>'systemPrompt','UTF8')),'hex')))||assets;
  SELECT coalesce(jsonb_agg(jsonb_build_object('query',previous.payload->>'query','answer',previous.result->'answer'->>'text') ORDER BY previous.turn_number),'[]') INTO history FROM agentonic.background_jobs previous WHERE previous.preview_id=p.id AND previous.turn_number<j.turn_number AND previous.status='succeeded';
  RETURN response||jsonb_build_object('previewModel',j.response_model,'reasoningLevel',j.reasoning_effort,'environment','staging','audience','private','expiresAt',p.expires_at,'configurationJson',r.content::text,'contentSha256',r.content_sha256,'composedPromptSha256',r.composed_prompt_sha256,'assetManifestJson',assets::text,'assetManifestSha256',r.asset_manifest_sha256,'accessJson',r.requested_access_snapshot::text,'accessSha256',r.requested_access_sha256,'history',history)
    ||CASE WHEN c.execution_manifest->>'mailboxBatch'='1' THEN jsonb_strip_nulls(jsonb_build_object('styleGuide',agentonic.agent_style_guide(p.agent_id,r.requested_access_snapshot))) ELSE '{}'::jsonb END;
 ELSIF operation='reserve' THEN
  IF p.committed_microusd+(payload->>'microusd')::bigint>p.budget_usd*1000000 THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  response:=agentonic.rag_worker_core_v8(operation,job_id,token,payload);
  IF response->>'ok'='true' THEN
   UPDATE agentonic.agent_previews SET committed_microusd=committed_microusd+(payload->>'microusd')::bigint WHERE id=p.id;
   UPDATE agentonic.retrieval_provider_operations SET preview_id=p.id,agent_id=p.agent_id WHERE id=(payload->>'id')::uuid;
  END IF;
  RETURN response;
 ELSIF operation='settle' THEN
  SELECT * INTO meter FROM agentonic.retrieval_provider_operations WHERE id=(payload->>'id')::uuid AND job_id=j.id;
  response:=agentonic.rag_worker_core_v8(operation,job_id,token,payload);
  UPDATE agentonic.agent_previews SET committed_microusd=committed_microusd-meter.reserved_microusd+(payload->>'microusd')::bigint WHERE id=p.id;
  RETURN response;
 END IF;
 RETURN agentonic.rag_worker_core_v8(operation,job_id,token,payload);
END $function$;

CREATE OR REPLACE FUNCTION agentonic.preview_command(operation text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb;p agentonic.agent_previews;
BEGIN
 result:=agentonic.preview_command_v30(operation,payload);
 IF operation='state' AND result->>'ok'='true' THEN
  SELECT * INTO p FROM agentonic.agent_previews WHERE id=(result->>'id')::uuid;
  result:=result||jsonb_build_object('gmailEnabled',jsonb_array_length(agentonic.gmail_grants(p.execution_policy->'tools'))>0);
  -- A running turn shows its answer as it is written (§68).
  result:=jsonb_set(result,'{turns}',coalesce((SELECT jsonb_agg(x.turn||CASE WHEN j.status='running' AND j.partial_answer IS NOT NULL THEN jsonb_build_object('partial',j.partial_answer) ELSE '{}'::jsonb END ORDER BY x.n)
   FROM jsonb_array_elements(result->'turns') WITH ORDINALITY x(turn,n) LEFT JOIN agentonic.background_jobs j ON j.id=(x.turn->>'id')::uuid AND j.preview_id=p.id),'[]'::jsonb));
 END IF;
 RETURN result;
END $function$;

-- Evaluations: the style guide, as the version would have it.
CREATE OR REPLACE FUNCTION agentonic.evaluation_worker_v46(operation text, run_id uuid, token uuid, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
DECLARE e agentonic.evaluation_runs; worker agentonic.evaluation_workers; config agentonic.configuration_releases; code agentonic.code_releases;
 sources jsonb; hits jsonb; assets jsonb; test_case jsonb; checks jsonb; passed boolean; amount bigint;
 budget agentonic.retrieval_provider_budgets; meter agentonic.retrieval_provider_operations; p agentonic.evaluation_preparations; assessment jsonb; decision_id uuid; chosen agentonic.evaluation_runs;
BEGIN
 SELECT * INTO worker FROM agentonic.evaluation_workers WHERE database_role=agentonic.application_role() AND revoked_at IS NULL AND retired_at IS NULL AND verified_at>clock_timestamp()-interval '30 days';
 SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=run_id;
 IF worker.id IS NULL OR e.id IS NULL OR e.worker_id IS DISTINCT FROM worker.id THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=e.workspace_id FOR SHARE;
 SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=e.preparation_id FOR UPDATE;
 SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=run_id FOR UPDATE;
 IF e.preparation_id IS NOT NULL AND (worker.environment<>'azure_staging' OR NOT (worker.verification @> '{"reviewProtocol":2}' OR worker.verification @> '{"reviewProtocol":3}')) THEN RAISE insufficient_privilege; END IF;
 IF e.batch_id IS NOT NULL AND NOT worker.verification @> '{"reviewProtocol":3}' THEN RAISE insufficient_privilege; END IF;
 IF e.status<>'running' OR e.lease_token IS DISTINCT FROM token OR e.lease_until<=clock_timestamp() OR e.started_at<clock_timestamp()-interval '30 minutes' THEN RAISE insufficient_privilege; END IF;
 IF operation='fail' THEN
  UPDATE agentonic.evaluation_preparations SET status='error',finished_at=clock_timestamp() WHERE id=e.preparation_id AND status='evaluating';
  UPDATE agentonic.evaluation_runs SET status='error',error_code=CASE WHEN payload->>'code' IN ('provider_unavailable','budget_exhausted','configuration_required','lease_lost','runtime_mismatch') THEN payload->>'code' ELSE 'lease_lost' END,lease_token=NULL,lease_until=NULL,current_matches='[]',finished_at=clock_timestamp() WHERE id=e.id;
  RETURN '{"ok":true}';
 END IF;
 IF NOT agentonic.evaluation_authorized(e) THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO config FROM agentonic.configuration_releases WHERE id=e.configuration_release_id;
 SELECT * INTO code FROM agentonic.code_releases WHERE id=e.code_release_id;
 IF NOT agentonic.evaluator_runs(worker.id,code.artifact_sha256) THEN RAISE insufficient_privilege; END IF;
 test_case:=e.dataset_snapshot->e.next_case;
 IF operation='heartbeat' THEN
  UPDATE agentonic.evaluation_runs SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=e.id;
  RETURN '{"ok":true}';
 ELSIF operation='read' THEN
  RETURN jsonb_build_object('reviewProtocol',CASE WHEN e.preparation_id IS NULL THEN 1 ELSE 2 END,'kind','retrieve','workspaceId',e.workspace_id,'query',test_case->>'question','generateAnswer',true,'preview',true,'hasCollections',jsonb_array_length(config.requested_access_snapshot->'collectionIds')>0,
  'runtime',jsonb_build_object('gitCommit',code.git_commit_sha,'artifactSha256',code.artifact_sha256,'manifest',code.execution_manifest));
 ELSIF operation='reserve' THEN
  IF NOT coalesce((payload->>'provider'='voyage' AND (payload->>'model'='voyage-4' OR payload->>'model'='rerank-2.5-lite')) OR (payload->>'provider'='openai' AND payload->>'model' IN (e.response_model,e.grader_snapshot->>'model')),false) THEN RAISE insufficient_privilege; END IF;
  amount:=(payload->>'microusd')::bigint;
  IF amount IS NULL OR amount NOT BETWEEN 1 AND 5000000 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO budget FROM agentonic.retrieval_provider_budgets WHERE provider=payload->>'provider' FOR UPDATE;
  IF budget.provider IS NULL THEN RAISE insufficient_privilege; END IF;
  IF (p.id IS NOT NULL AND e.batch_id IS NULL AND p.committed_microusd+amount>p.budget_usd*1000000) OR e.committed_microusd+amount>e.budget_usd*1000000 OR budget.committed_microusd+amount>budget.cap_microusd THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  IF e.batch_id IS NOT NULL AND (SELECT coalesce(sum(committed_microusd),0) FROM agentonic.evaluation_runs WHERE batch_id=e.batch_id)+amount>e.budget_usd*1000000 THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  INSERT INTO agentonic.retrieval_provider_operations(id,job_id,workspace_id,provider,model,reserved_microusd,agent_id) VALUES((payload->>'id')::uuid,e.id,e.workspace_id,budget.provider,payload->>'model',amount,e.agent_id);
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd+amount,updated_at=clock_timestamp() WHERE provider=budget.provider;
  UPDATE agentonic.evaluation_runs SET committed_microusd=committed_microusd+amount WHERE id=e.id;
  UPDATE agentonic.evaluation_preparations SET committed_microusd=committed_microusd+amount WHERE id=p.id;
  RETURN '{"ok":true}';
 ELSIF operation='settle' THEN
  SELECT * INTO meter FROM agentonic.retrieval_provider_operations WHERE id=(payload->>'id')::uuid AND job_id=e.id AND status='reserved' FOR UPDATE;
  amount:=(payload->>'microusd')::bigint;
  IF meter.id IS NULL OR amount IS NULL OR amount<0 OR payload->>'tokens' IS NULL OR (payload->>'tokens')::bigint<0 OR coalesce((payload->>'outputTokens')::bigint,0)<0 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.retrieval_provider_operations SET status='settled',actual_microusd=amount,input_tokens=(payload->>'tokens')::bigint,output_tokens=coalesce((payload->>'outputTokens')::bigint,0) WHERE id=meter.id;
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd-meter.reserved_microusd+amount,updated_at=clock_timestamp() WHERE provider=meter.provider;
  UPDATE agentonic.evaluation_runs SET committed_microusd=committed_microusd-meter.reserved_microusd+amount WHERE id=e.id;
  UPDATE agentonic.evaluation_preparations SET committed_microusd=committed_microusd-meter.reserved_microusd+amount WHERE id=p.id;
  RETURN '{"ok":true}';
 ELSIF operation='empty-search' THEN
  IF jsonb_array_length(config.requested_access_snapshot->'collectionIds')<>0 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.evaluation_runs SET current_matches='[]' WHERE id=e.id;
  RETURN '{"ok":true}';
 ELSIF operation='search' THEN
  IF jsonb_typeof(payload->'embedding') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'embedding')<>1024 THEN RAISE insufficient_privilege; END IF;
  WITH eligible AS MATERIALIZED (
   SELECT c.* FROM agentonic.document_chunks c JOIN agentonic.document_versions v ON v.id=c.document_version_id JOIN agentonic.documents d ON d.id=v.document_id AND d.active_version_id=v.id JOIN agentonic.knowledge_sources s ON s.id=d.source_id
   WHERE c.workspace_id=e.workspace_id AND d.deleted_at IS NULL AND v.status='ready'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(config.requested_access_snapshot->'collections') col CROSS JOIN LATERAL jsonb_array_elements(col->'sources') src WHERE src->>'id'=s.id::text)
  ), semantic AS (
   SELECT id,row_number() OVER(ORDER BY embedding OPERATOR(public.<=>) (payload->'embedding')::text::public.vector,id) rank FROM eligible ORDER BY embedding OPERATOR(public.<=>) (payload->'embedding')::text::public.vector,id LIMIT 40
  ), lexical AS (
   SELECT id,row_number() OVER(ORDER BY ts_rank_cd(search_vector,q) DESC,id) rank FROM eligible,LATERAL(SELECT websearch_to_tsquery('pg_catalog.simple',test_case->>'question')||websearch_to_tsquery('pg_catalog.spanish',test_case->>'question')||websearch_to_tsquery('pg_catalog.english',test_case->>'question') q) query WHERE search_vector@@q ORDER BY ts_rank_cd(search_vector,q) DESC,id LIMIT 40
  ), ranked AS (
   SELECT coalesce(s.id,l.id) id,coalesce(1.0/(60+s.rank),0)+coalesce(1.0/(60+l.rank),0) score FROM semantic s FULL JOIN lexical l ON s.id=l.id ORDER BY score DESC,coalesce(s.id,l.id) LIMIT CASE WHEN payload->>'rerank'='true' THEN 32 ELSE 8 END
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'hash',c.content_sha256) ORDER BY r.score DESC,r.id),'[]') INTO hits FROM ranked r JOIN agentonic.document_chunks c ON c.id=r.id;
  UPDATE agentonic.evaluation_runs SET current_matches=hits WHERE id=e.id;
  RETURN '{"ok":true}';
 ELSIF operation IN ('context','grade-context','answer','rerank-context','select-matches') THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'text',c.content) ORDER BY hit.ordinality),'[]') INTO hits
  FROM jsonb_array_elements(e.current_matches) WITH ORDINALITY hit(value,ordinality)
  JOIN agentonic.document_chunks c ON c.id=(hit.value->>'id')::uuid AND c.workspace_id=e.workspace_id AND c.content_sha256=hit.value->>'hash'
  JOIN agentonic.document_versions v ON v.id=c.document_version_id JOIN agentonic.documents d ON d.id=v.document_id AND d.active_version_id=v.id
  WHERE d.deleted_at IS NULL AND v.status='ready';
  IF jsonb_array_length(hits)<>jsonb_array_length(e.current_matches) THEN RAISE insufficient_privilege; END IF;
  IF operation='rerank-context' THEN RETURN jsonb_build_object('passages',hits); END IF;
  IF operation='select-matches' THEN
   IF EXISTS(SELECT 1 FROM agentonic.retrieval_provider_operations op WHERE op.job_id=e.id AND op.status='reserved') THEN RAISE insufficient_privilege; END IF;
   hits:=agentonic.select_retrieval_matches(e.current_matches,payload->'ids');
   UPDATE agentonic.evaluation_runs SET current_matches=hits WHERE id=e.id;
   RETURN '{"ok":true}';
  END IF;
  IF jsonb_array_length(hits)>8 THEN RAISE insufficient_privilege; END IF;
  IF operation='grade-context' AND p.id IS NOT NULL THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'text',c.content)),'[]') INTO sources FROM agentonic.document_chunks c
   WHERE c.workspace_id=p.workspace_id AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(test_case->'sourceIds') src WHERE src=c.id::text);
   RETURN jsonb_build_object('criterion',test_case,'passages',hits,'references',sources,'configuration',config.content,'requestedAccess',config.requested_access_snapshot,'evaluationScope','isolated-readonly','rubricVersion',e.grader_snapshot->>'version');
  END IF;
  IF operation='context' THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('path','skills/'||(s->>'name')||'.md','sha256',encode(sha256(convert_to(s->>'instructions','UTF8')),'hex')) ORDER BY s->>'name'),'[]') INTO assets FROM jsonb_array_elements(config.content->'skills') s;
   assets:=jsonb_build_array(jsonb_build_object('path','prompts/system.md','sha256',encode(sha256(convert_to(config.content->>'systemPrompt','UTF8')),'hex')))||assets;
   RETURN jsonb_build_object('previewModel',e.response_model,'reasoningLevel',e.reasoning_effort,'query',test_case->>'question','passages',hits,'environment','staging','audience','private','expiresAt',least(e.expires_at,e.started_at+interval '30 minutes'),
   'configurationJson',config.content::text,'contentSha256',config.content_sha256,'composedPromptSha256',config.composed_prompt_sha256,'assetManifestJson',assets::text,'assetManifestSha256',config.asset_manifest_sha256,'accessJson',config.requested_access_snapshot::text,'accessSha256',config.requested_access_sha256,'history','[]'::jsonb)
    ||CASE WHEN code.execution_manifest->>'mailboxBatch'='1' THEN jsonb_strip_nulls(jsonb_build_object('styleGuide',agentonic.agent_style_guide(e.agent_id,config.requested_access_snapshot))) ELSE '{}'::jsonb END;
  END IF;
  IF jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR length(payload->>'text') NOT BETWEEN 1 AND 30000 OR jsonb_typeof(payload->'citations') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'citations')>8 OR jsonb_typeof(payload->'insufficientEvidence') IS DISTINCT FROM 'boolean' OR payload->>'model' IS DISTINCT FROM e.response_model
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(payload->'citations') citation WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(hits) h WHERE h->>'id'=citation)) THEN RAISE insufficient_privilege; END IF;
  IF (p.id IS NOT NULL AND e.batch_id IS NULL AND p.committed_microusd>p.budget_usd*1000000) OR e.committed_microusd>e.budget_usd*1000000 OR EXISTS(SELECT 1 FROM agentonic.retrieval_provider_operations WHERE job_id=e.id AND status='reserved') THEN RAISE insufficient_privilege; END IF;
  IF p.id IS NULL THEN
  checks:=jsonb_build_object('abstention',payload->'insufficientEvidence'=test_case->'insufficientEvidence','citations',payload->'insufficientEvidence'='true' OR jsonb_array_length(payload->'citations')>0,
  'requiredPhrases',NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(test_case->'requiredPhrases') phrase WHERE strpos(lower(payload->>'text'),lower(phrase))=0),
  'forbiddenPhrases',NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(test_case->'forbiddenPhrases') phrase WHERE strpos(lower(payload->>'text'),lower(phrase))>0));
  ELSE
   assessment:=payload->'assessment';
   IF jsonb_typeof(assessment) IS DISTINCT FROM 'object' OR NOT(assessment ?& ARRAY['verdict','explanation','suggestion','grounded','meetsExpectation','safe','routine','confidence'])
   OR assessment-ARRAY['verdict','explanation','suggestion','grounded','meetsExpectation','safe','routine','confidence']<>'{}'
   OR assessment->>'verdict' NOT IN ('passed','needs_changes','uncertain') OR assessment->>'confidence' NOT IN ('high','low')
   OR jsonb_typeof(assessment->'explanation') IS DISTINCT FROM 'string' OR length(assessment->>'explanation') NOT BETWEEN 1 AND 1500
   OR jsonb_typeof(assessment->'suggestion') IS DISTINCT FROM 'string' OR length(assessment->>'suggestion')>1500
   OR EXISTS(SELECT 1 FROM unnest(ARRAY['grounded','meetsExpectation','safe','routine']) k WHERE jsonb_typeof(assessment->k) IS DISTINCT FROM 'boolean') THEN RAISE insufficient_privilege; END IF;
   checks:=jsonb_build_object('semantic',assessment->>'verdict'='passed' AND assessment->>'confidence'='high',
   'grounded',assessment->'grounded','expectation',assessment->'meetsExpectation','safe',assessment->'safe',
   'platform',test_case->>'kind'<>'platform' OR payload->'insufficientEvidence'='true',
   'citations',payload->'insufficientEvidence'='true' OR test_case->>'kind'='platform' OR jsonb_array_length(test_case->'sourceIds')=0 OR jsonb_array_length(payload->'citations')>0);
  END IF;
  passed:=NOT EXISTS(SELECT 1 FROM jsonb_each(checks) c WHERE c.value<>'true'::jsonb);
  INSERT INTO agentonic.evaluation_results(workspace_id,evaluation_run_id,case_key,outcome,answer,citations,evidence_sources,checks,assessment)
  VALUES(e.workspace_id,e.id,test_case->>'key',CASE WHEN passed THEN 'passed' ELSE 'failed' END,payload->>'text',payload->'citations',e.current_matches,checks,assessment);
  IF e.next_case+1=jsonb_array_length(e.dataset_snapshot) THEN
   passed:=NOT EXISTS(SELECT 1 FROM agentonic.evaluation_results WHERE evaluation_run_id=e.id AND outcome<>'passed');
   SELECT jsonb_agg(jsonb_build_object('key',case_key,'outcome',outcome,'answer',answer,'citations',citations,'sources',evidence_sources,'checks',result.checks,'assessment',result.assessment) ORDER BY case_key) INTO sources FROM agentonic.evaluation_results result WHERE evaluation_run_id=e.id;
   UPDATE agentonic.evaluation_runs SET status=CASE WHEN passed THEN 'passed' ELSE 'failed' END,next_case=next_case+1,current_matches='[]',lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp(),
   evidence_sha256=agentonic.content_hash(jsonb_build_object('results',sources,'dataset',e.dataset_sha256,'grader',e.grader_sha256,'configuration',e.configuration_sha256,'access',e.requested_access_sha256,'runtime',code.artifact_sha256,'worker',worker.worker_sha256,'environment',worker.environment,'executionModel',e.response_model,'reasoning',e.reasoning_effort,'batch',e.batch_id)) WHERE id=e.id;

   IF p.id IS NOT NULL AND (e.batch_id IS NULL OR NOT EXISTS(SELECT 1 FROM agentonic.evaluation_runs WHERE batch_id=e.batch_id AND status IN ('queued','running'))) THEN
    SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=run_id;
    -- A batch is decided per model (§56): its evidence is the first run of the
    -- first model whose every level passed. Models that failed are left out.
    IF e.batch_id IS NOT NULL THEN
     SELECT r.* INTO chosen FROM agentonic.evaluation_runs r WHERE r.batch_id=e.batch_id AND r.status='passed'
     AND NOT EXISTS(SELECT 1 FROM agentonic.evaluation_runs other WHERE other.batch_id=r.batch_id AND other.response_model=r.response_model AND other.status<>'passed')
     ORDER BY r.created_at,r.id LIMIT 1;
     passed:=chosen.id IS NOT NULL;
     IF passed THEN
      e:=chosen;
      UPDATE agentonic.evaluation_preparations SET evaluation_id=chosen.id WHERE id=p.id;
     END IF;
    END IF;
    IF passed AND agentonic.review_auto_eligible(e,true) THEN
     INSERT INTO agentonic.submission_review_decisions(workspace_id,agent_id,submission_id,decision_number,decision,actor_policy_version,feedback,approval_expires_at,approved_access_sha256,assessment_snapshot)
     SELECT e.workspace_id,e.agent_id,e.submission_id,coalesce(max(decision_number),0)+1,'approved','readonly-review-v1','La versión superó los criterios confirmados y los controles de la plataforma.',least(clock_timestamp()+interval '24 hours',e.expires_at),e.requested_access_sha256,
     jsonb_build_object('version',3,'evaluationId',e.id,'evidenceHash',e.evidence_sha256,'configurationHash',e.configuration_sha256,'requestedAccessHash',e.requested_access_sha256,'evaluated',true,'humanReviewed',false,'policy','readonly-review-v1')
     FROM agentonic.submission_review_decisions WHERE submission_id=e.submission_id RETURNING id INTO decision_id;
     UPDATE agentonic.agent_submissions SET status='approved' WHERE id=e.submission_id;
     UPDATE agentonic.evaluation_preparations SET status='approved',finished_at=clock_timestamp() WHERE id=p.id;
    ELSE
     UPDATE agentonic.evaluation_preparations SET status=CASE WHEN NOT passed AND EXISTS(SELECT 1 FROM agentonic.evaluation_results r JOIN agentonic.evaluation_runs failed_run ON failed_run.id=r.evaluation_run_id WHERE (failed_run.id=e.id OR e.batch_id IS NOT NULL AND failed_run.batch_id=e.batch_id) AND r.outcome='failed' AND r.assessment->>'verdict'='needs_changes') THEN 'needs_changes' ELSE 'needs_attention' END,finished_at=clock_timestamp() WHERE id=p.id;
    END IF;
   END IF;
  ELSE
   UPDATE agentonic.evaluation_runs SET next_case=next_case+1,current_matches='[]' WHERE id=e.id;
  END IF;
  RETURN '{"ok":true}';
 END IF;
 RAISE insufficient_privilege;
END $function$;

REVOKE ALL ON FUNCTION agentonic.clear_partial_answer(),agentonic.gmail_tools_usable(jsonb),agentonic.agent_style_guide(uuid,jsonb) FROM PUBLIC;
COMMIT;
