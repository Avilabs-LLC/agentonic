BEGIN;
-- Existing previews keep their no-tool policy. Live tools require an explicit new
-- start choice and remain bound to the owner's frozen scope and ten-minute session.
ALTER TABLE agentonic.gmail_invocations ADD COLUMN execution_context text NOT NULL DEFAULT 'staging' CHECK(execution_context IN ('staging','preview'));
ALTER FUNCTION agentonic.preview_authorized(agentonic.agent_previews) RENAME TO preview_authorized_v29;
CREATE FUNCTION agentonic.preview_authorized(p agentonic.agent_previews) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE base agentonic.agent_previews:=p; r agentonic.configuration_releases; tools jsonb:=p.execution_policy->'tools';
BEGIN
 base.execution_policy:=jsonb_set(p.execution_policy,'{tools}','[]');
 IF NOT agentonic.preview_authorized_v29(base) THEN RETURN false; END IF;
 IF tools='[]' THEN RETURN true; END IF;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=p.configuration_release_id;
 RETURN coalesce(tools=r.requested_access_snapshot->'tools' AND agentonic.gmail_deployment_scope(r,p.requested_by_member_id),false);
END $$;
REVOKE ALL ON FUNCTION agentonic.preview_authorized(agentonic.agent_previews),agentonic.preview_authorized_v29(agentonic.agent_previews) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
CREATE OR REPLACE FUNCTION agentonic.preview_command(operation text,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE w uuid:=agentonic.workspace_id(); m uuid:=agentonic.current_member(); p agentonic.agent_previews; r agentonic.configuration_releases;
 j agentonic.background_jobs; turns jsonb:='[]'; response jsonb; n integer;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR m IS NULL OR w IS NULL THEN RAISE insufficient_privilege; END IF;
 -- Exclusive workspace lock serializes starts/turns with revocation and deletion.
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 IF operation='start' THEN
  payload:=jsonb_build_object('enableTools',false)||payload;
  SELECT * INTO r FROM agentonic.configuration_releases WHERE id=(payload->>'candidateId')::uuid AND agent_id=(payload->>'agentId')::uuid AND workspace_id=w;
  IF r.id IS NULL OR NOT agentonic.can_agent(r.agent_id,'edit') OR NOT agentonic.can_use_code(r.code_release_id) THEN RAISE insufficient_privilege; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.requested_access_snapshot->'collectionIds') c WHERE NOT agentonic.can_collection(c::uuid,'read')) THEN RAISE insufficient_privilege; END IF;
  IF NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=r.code_release_id AND execution_manifest->>'previewContract'='1') THEN RETURN '{"ok":false,"code":"runtime_unavailable"}'; END IF;
  SELECT * INTO p FROM agentonic.agent_previews WHERE workspace_id=w AND agent_id=r.agent_id AND configuration_release_id=r.id AND requested_by_member_id=m AND status='running' AND expires_at>clock_timestamp() AND (jsonb_array_length(execution_policy->'tools')>0)=((payload->>'enableTools'='true') AND jsonb_array_length(r.requested_access_snapshot->'tools')>0) ORDER BY created_at DESC LIMIT 1;
  IF p.id IS NOT NULL AND agentonic.preview_authorized(p) THEN RETURN jsonb_build_object('ok',true,'id',p.id); END IF;
  IF (SELECT count(*) FROM agentonic.agent_previews WHERE workspace_id=w AND requested_by_member_id=m AND created_at>clock_timestamp()-interval '1 minute')>=3 THEN RETURN '{"ok":false,"code":"rate_limit"}'; END IF;
  INSERT INTO agentonic.agent_previews(workspace_id,agent_id,code_release_id,configuration_release_id,requested_by_member_id,execution_policy)
  VALUES(w,r.agent_id,r.code_release_id,r.id,m,jsonb_build_object('audience','private','tools',CASE WHEN payload->>'enableTools'='true' THEN r.requested_access_snapshot->'tools' ELSE '[]'::jsonb END,'collections',r.requested_access_snapshot->'collections')) RETURNING * INTO p;
  IF NOT agentonic.preview_authorized(p) THEN RAISE insufficient_privilege; END IF;
  RETURN jsonb_build_object('ok',true,'id',p.id);
 END IF;
 SELECT * INTO p FROM agentonic.agent_previews WHERE id=(payload->>'previewId')::uuid AND workspace_id=w AND requested_by_member_id=m AND agent_id=(payload->>'agentId')::uuid FOR UPDATE;
 IF p.id IS NULL THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 IF operation='cancel' THEN
  UPDATE agentonic.agent_previews SET status='cancelled' WHERE id=p.id;
  UPDATE agentonic.background_jobs SET status='cancelled',payload='{}',result='{}',lease_token=NULL,lease_until=NULL WHERE preview_id=p.id;
  RETURN '{"ok":true}';
 END IF;
 IF NOT agentonic.preview_authorized(p) THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 IF operation='turn' THEN
  IF length(btrim(payload->>'query')) NOT BETWEEN 1 AND 1000 OR payload->>'query' IS NULL OR payload->>'requestKey' IS NULL THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO j FROM agentonic.background_jobs WHERE preview_id=p.id AND request_key=(payload->>'requestKey')::uuid;
  IF j.id IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'id',j.id); END IF;
  IF EXISTS(SELECT 1 FROM agentonic.background_jobs WHERE preview_id=p.id AND status IN ('queued','running')) THEN RETURN '{"ok":false,"code":"busy"}'; END IF;
  SELECT coalesce(max(turn_number),0)+1 INTO n FROM agentonic.background_jobs WHERE preview_id=p.id;
  IF n>10 THEN RETURN '{"ok":false,"code":"turn_limit"}'; END IF;
  INSERT INTO agentonic.background_jobs(workspace_id,member_id,kind,preview_id,turn_number,request_key,payload)
  SELECT w,m,'retrieve',p.id,n,(payload->>'requestKey')::uuid,jsonb_build_object('query',btrim(payload->>'query'),'collectionIds',frozen.requested_access_snapshot->'collectionIds','generateAnswer',true)
  FROM agentonic.configuration_releases frozen WHERE frozen.id=p.configuration_release_id RETURNING * INTO j;
  RETURN jsonb_build_object('ok',true,'id',j.id);
 ELSIF operation='state' THEN
  FOR j IN SELECT * FROM agentonic.background_jobs WHERE preview_id=p.id ORDER BY turn_number LOOP
   response:=agentonic.rag_command('result',jsonb_build_object('id',j.id));
   IF response->>'status'='unavailable' THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
   turns:=turns||jsonb_build_array(response||jsonb_build_object('id',j.id,'number',j.turn_number,'query',j.payload->>'query'));
  END LOOP;
  RETURN jsonb_build_object('ok',true,'id',p.id,'expiresAt',p.expires_at,'budgetUsd',p.budget_usd,'committedMicrousd',p.committed_microusd,'toolsEnabled',jsonb_array_length(p.execution_policy->'tools')>0,'turns',turns);
 END IF;
 RAISE insufficient_privilege;
END $$;
-- Worker-only entry point: a leased customer preview job, never an evaluation,
-- background retrieval, or client-supplied account, determines the authority.
CREATE FUNCTION agentonic.gmail_preview_worker(operation text,job_id uuid,token uuid,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE j agentonic.background_jobs;p agentonic.agent_previews;c agentonic.gmail_connections;g jsonb;op text:=payload->>'operation';
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 PERFORM agentonic.rag_worker('heartbeat',job_id,token,'{}');
 SELECT * INTO j FROM agentonic.background_jobs WHERE id=job_id;
 SELECT * INTO p FROM agentonic.agent_previews WHERE id=j.preview_id AND workspace_id=j.workspace_id AND requested_by_member_id=j.member_id;
 IF p.id IS NULL OR NOT agentonic.preview_authorized(p) THEN RAISE insufficient_privilege; END IF;
 IF operation='gmail-tools' THEN RETURN jsonb_build_object('tools',p.execution_policy->'tools'); END IF;
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
 IF operation='gmail-propose' AND op IN ('gmail.drafts.create','gmail.drafts.update','gmail.drafts.delete','gmail.send') THEN
  IF (SELECT count(*) FROM agentonic.gmail_invocations WHERE turn_id=job_id)>=3 OR (SELECT count(*) FROM agentonic.gmail_invocations WHERE owner_member_id=p.requested_by_member_id AND created_at>clock_timestamp()-interval '1 hour')>=30 THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.gmail_invocations(id,workspace_id,agent_id,connection_id,owner_member_id,turn_id,conversation_id,operation,arguments_ciphertext,arguments_sha256,expires_at,execution_context)
  VALUES((payload->>'id')::uuid,p.workspace_id,p.agent_id,c.id,p.requested_by_member_id,job_id,p.id,op,payload->>'argumentsCiphertext',payload->>'hash',least(p.expires_at,clock_timestamp()+interval '10 minutes'),'preview');
  RETURN jsonb_build_object('pendingApproval',true,'id',payload->>'id');
 END IF;
 RAISE insufficient_privilege;
END $$;
REVOKE ALL ON FUNCTION agentonic.gmail_preview_worker(text,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.gmail_preview_worker(text,uuid,uuid,jsonb) TO agentonic_worker;

ALTER FUNCTION agentonic.gmail_command(text,jsonb) RENAME TO gmail_command_v29;
CREATE FUNCTION agentonic.gmail_command(operation text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();i agentonic.gmail_invocations;p agentonic.agent_previews;c agentonic.gmail_connections;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR w IS NULL OR m IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 IF operation IN ('inspect','confirm','cancel','complete') THEN
  SELECT * INTO i FROM agentonic.gmail_invocations WHERE id=(payload->>'id')::uuid AND workspace_id=w AND owner_member_id=m FOR UPDATE;
 END IF;
 IF NOT (coalesce(operation='invocations' AND payload->>'context'='preview',false) OR coalesce(i.execution_context='preview',false)) THEN
  RETURN agentonic.gmail_command_v29(operation,payload);
 END IF;
 UPDATE agentonic.gmail_invocations SET status=CASE WHEN status='pending' THEN 'expired' WHEN status='executing' THEN 'uncertain' ELSE status END,arguments_ciphertext=NULL
 WHERE workspace_id=w AND expires_at<=clock_timestamp() AND arguments_ciphertext IS NOT NULL;
 IF operation='invocations' THEN
  SELECT * INTO p FROM agentonic.agent_previews WHERE id=(payload->>'conversationId')::uuid AND workspace_id=w AND requested_by_member_id=m;
  IF p.id IS NULL OR NOT agentonic.preview_authorized(p) THEN RAISE insufficient_privilege; END IF;
  RETURN jsonb_build_object('items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'operation',v.operation,'account',gc.account,'status',v.status,'hash',v.arguments_sha256,'expiresAt',v.expires_at,'argumentsCiphertext',v.arguments_ciphertext,'result',v.result) ORDER BY v.created_at) FROM agentonic.gmail_invocations v JOIN agentonic.gmail_connections gc ON gc.id=v.connection_id WHERE v.conversation_id=p.id AND v.execution_context='preview' AND v.owner_member_id=m AND gc.status='connected'),'[]'));
 END IF;
 -- An already attempted provider call must be recordable even if the preview was
 -- cancelled meanwhile. This only records a result, never repeats a side effect.
 IF operation='complete' THEN
  IF i.status<>'executing' OR payload->>'status' NOT IN ('succeeded','failed','uncertain') THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.gmail_invocations SET status=payload->>'status',result=payload->'result',finished_at=clock_timestamp(),arguments_ciphertext=NULL WHERE id=i.id AND status='executing';
  RETURN '{"ok":true}';
 END IF;
 SELECT * INTO p FROM agentonic.agent_previews WHERE id=i.conversation_id AND workspace_id=w AND requested_by_member_id=m AND agent_id=i.agent_id;
 SELECT * INTO c FROM agentonic.gmail_connections WHERE id=i.connection_id;
 IF p.id IS NULL OR NOT agentonic.preview_authorized(p) OR NOT agentonic.gmail_allowed(c,m,p.agent_id,i.operation)
  OR NOT p.execution_policy->'tools' @> jsonb_build_array(jsonb_build_object('connectionId',c.id,'operations',jsonb_build_array(i.operation))) THEN RAISE insufficient_privilege; END IF;
 IF operation='cancel' THEN
  IF i.status<>'pending' THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.gmail_invocations SET status='cancelled',arguments_ciphertext=NULL WHERE id=i.id; RETURN '{"ok":true}';
 END IF;
 IF operation NOT IN ('inspect','confirm') OR i.status<>'pending' OR i.expires_at<=clock_timestamp() OR i.arguments_ciphertext IS NULL OR i.arguments_sha256 IS DISTINCT FROM payload->>'hash' THEN RAISE insufficient_privilege; END IF;
 IF operation='confirm' THEN UPDATE agentonic.gmail_invocations SET status='executing',approved_at=clock_timestamp() WHERE id=i.id; END IF;
 RETURN jsonb_build_object('credential',c.credential_ciphertext,'connectionId',c.id,'account',c.account,'argumentsCiphertext',i.arguments_ciphertext,'operation',i.operation);
END $$;
REVOKE ALL ON FUNCTION agentonic.gmail_command_v29(text,jsonb),agentonic.gmail_command(text,jsonb) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.gmail_command(text,jsonb) TO agentonic_customer;
CREATE FUNCTION agentonic.gmail_preview_scrub() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.status<>'running' THEN
  UPDATE agentonic.gmail_invocations SET arguments_ciphertext=NULL,status=CASE WHEN status='pending' THEN 'cancelled' WHEN status='executing' THEN 'uncertain' ELSE status END WHERE conversation_id=OLD.id AND execution_context='preview';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION agentonic.gmail_preview_scrub() FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
CREATE TRIGGER gmail_preview_cleanup AFTER UPDATE OR DELETE ON agentonic.agent_previews FOR EACH ROW EXECUTE FUNCTION agentonic.gmail_preview_scrub();
COMMIT;
