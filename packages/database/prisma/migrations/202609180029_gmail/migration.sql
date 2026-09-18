BEGIN;
-- Personal staging Gmail connections. Ciphertexts are opaque to all database roles;
-- the broker's separately protected AES key never enters this database.
CREATE TABLE agentonic.gmail_connections (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES agentonic.workspaces(id), agent_id uuid NOT NULL,
 owner_member_id uuid NOT NULL, account text NOT NULL CHECK(length(account)<=254),
 status text NOT NULL DEFAULT 'connected' CHECK(status IN ('connected','reconnect','disconnected')),
 credential_ciphertext text, operations jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,agent_id,id),
 FOREIGN KEY(workspace_id,agent_id) REFERENCES agentonic.agents(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_member_id) REFERENCES agentonic.workspace_members(workspace_id,id),
 CHECK(jsonb_typeof(operations)='array' AND jsonb_array_length(operations)<=8)
);
CREATE TABLE agentonic.gmail_oauth_states (
 state_hash text PRIMARY KEY CHECK(state_hash ~ '^[a-f0-9]{64}$'), workspace_id uuid NOT NULL, agent_id uuid NOT NULL,
 owner_member_id uuid NOT NULL, connection_id uuid NOT NULL UNIQUE, verifier_ciphertext text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT (now()+interval '10 minutes'), consumed_at timestamptz, finished_at timestamptz,
 FOREIGN KEY(workspace_id,agent_id) REFERENCES agentonic.agents(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_member_id) REFERENCES agentonic.workspace_members(workspace_id,id)
);
CREATE TABLE agentonic.gmail_invocations (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, agent_id uuid NOT NULL, connection_id uuid NOT NULL, owner_member_id uuid NOT NULL,
 turn_id uuid NOT NULL, conversation_id uuid NOT NULL, operation text NOT NULL,
 arguments_ciphertext text, arguments_sha256 text NOT NULL CHECK(arguments_sha256 ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','executing','succeeded','failed','uncertain','cancelled','expired')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT(now()+interval '10 minutes'),
 approved_at timestamptz, finished_at timestamptz, result jsonb,
 FOREIGN KEY(workspace_id,agent_id,connection_id) REFERENCES agentonic.gmail_connections(workspace_id,agent_id,id),
 FOREIGN KEY(workspace_id,owner_member_id) REFERENCES agentonic.workspace_members(workspace_id,id)
 -- Deliberately no FK to ephemeral chat: content-free audit survives chat erasure.
);
CREATE INDEX gmail_invocations_conversation ON agentonic.gmail_invocations(conversation_id,created_at);
ALTER TABLE agentonic.gmail_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentonic.gmail_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentonic.gmail_invocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.gmail_connections,agentonic.gmail_oauth_states,agentonic.gmail_invocations FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;

CREATE FUNCTION agentonic.valid_gmail_tools(tools jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE g jsonb; op text;
BEGIN
 IF jsonb_typeof(tools) IS DISTINCT FROM 'array' OR jsonb_array_length(tools)>1 THEN RETURN false; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(tools) LOOP
  IF jsonb_typeof(g) IS DISTINCT FROM 'object' OR g-ARRAY['connectionId','operations']<>'{}' OR coalesce(g->>'connectionId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(g->'operations') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(g->'operations') NOT BETWEEN 1 AND 8 OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(g->'operations')) THEN RETURN false; END IF;
  FOR op IN SELECT jsonb_array_elements_text(g->'operations') LOOP
   IF op NOT IN ('gmail.search','gmail.read','gmail.drafts.list','gmail.drafts.read','gmail.drafts.create','gmail.drafts.update','gmail.drafts.delete','gmail.send') THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $$;
ALTER FUNCTION agentonic.valid_draft(jsonb,jsonb) RENAME TO valid_draft_v28;
CREATE FUNCTION agentonic.valid_draft(content jsonb,requested jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT agentonic.valid_draft_v28(content,jsonb_set(requested,'{tools}','[]')) AND agentonic.valid_gmail_tools(requested->'tools')
$$;
-- The existing CHECK is bound to the renamed function OID: explicitly replace it.
DO $$ DECLARE n text; BEGIN
 SELECT conname INTO n FROM pg_constraint WHERE conrelid='agentonic.configuration_drafts'::regclass AND pg_get_constraintdef(oid) LIKE '%valid_draft%';
 EXECUTE format('ALTER TABLE agentonic.configuration_drafts DROP CONSTRAINT %I',n);
END $$;
ALTER TABLE agentonic.configuration_drafts ADD CONSTRAINT configuration_drafts_gmail_check CHECK(agentonic.valid_draft(content,requested_access));
CREATE FUNCTION agentonic.gmail_allowed(c agentonic.gmail_connections,m uuid,aid uuid,op text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(c.id IS NOT NULL AND c.status='connected' AND c.credential_ciphertext IS NOT NULL AND c.agent_id=aid AND c.owner_member_id=m
 AND agentonic.member_can_author(m,aid) AND c.operations ? op,false)
$$;
CREATE FUNCTION agentonic.gmail_scope_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE tools jsonb; g jsonb; c agentonic.gmail_connections; m uuid;
BEGIN
 tools:=CASE WHEN TG_TABLE_NAME='configuration_drafts' THEN to_jsonb(NEW)->'requested_access'->'tools' ELSE to_jsonb(NEW)->'requested_access_snapshot'->'tools' END;
 m:=agentonic.current_member();
 IF NOT agentonic.valid_gmail_tools(tools) THEN RAISE insufficient_privilege; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(tools) LOOP
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=(g->>'connectionId')::uuid AND workspace_id=NEW.workspace_id AND agent_id=NEW.agent_id;
  IF c.id IS NULL OR c.owner_member_id IS DISTINCT FROM m OR c.status<>'connected' OR NOT agentonic.member_can_author(m,NEW.agent_id)
   OR NOT (c.operations @> (g->'operations')) THEN RAISE insufficient_privilege; END IF;
  IF TG_TABLE_NAME='configuration_releases' AND NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=(to_jsonb(NEW)->>'code_release_id')::uuid AND execution_manifest->>'gmailContract'='1') THEN RAISE EXCEPTION 'Gmail runtime required'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER gmail_scope BEFORE INSERT OR UPDATE ON agentonic.configuration_drafts FOR EACH ROW EXECUTE FUNCTION agentonic.gmail_scope_guard();
CREATE TRIGGER gmail_scope BEFORE INSERT ON agentonic.configuration_releases FOR EACH ROW EXECUTE FUNCTION agentonic.gmail_scope_guard();

CREATE FUNCTION agentonic.gmail_command(operation text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
  RETURN jsonb_build_object('connections',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'account',account,'status',status,'operations',operations) ORDER BY created_at) FROM agentonic.gmail_connections WHERE workspace_id=w AND agent_id=aid AND owner_member_id=m AND status<>'disconnected'),'[]'));
 ELSIF operation='oauth.start' THEN
  IF (SELECT count(*) FROM agentonic.gmail_oauth_states WHERE owner_member_id=m AND expires_at>clock_timestamp())>=5 THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.gmail_oauth_states(state_hash,workspace_id,agent_id,owner_member_id,connection_id,verifier_ciphertext) VALUES(payload->>'state',w,aid,m,(payload->>'connectionId')::uuid,payload->>'verifier'); RETURN '{"ok":true}';
 ELSIF operation IN ('oauth.consume','oauth.finish') THEN
  SELECT * INTO s FROM agentonic.gmail_oauth_states WHERE state_hash=payload->>'state' AND workspace_id=w AND owner_member_id=m FOR UPDATE;
  IF s.state_hash IS NULL OR s.expires_at<=clock_timestamp() OR s.finished_at IS NOT NULL OR NOT agentonic.can_agent(s.agent_id,'edit') THEN RAISE insufficient_privilege; END IF;
  IF operation='oauth.consume' THEN
   IF s.consumed_at IS NOT NULL THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_oauth_states SET consumed_at=clock_timestamp() WHERE state_hash=s.state_hash;
   RETURN jsonb_build_object('agentId',s.agent_id,'connectionId',s.connection_id,'verifier',s.verifier_ciphertext);
  END IF;
  IF s.consumed_at IS NULL THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.gmail_connections(id,workspace_id,agent_id,owner_member_id,account,credential_ciphertext) VALUES(s.connection_id,w,s.agent_id,m,payload->>'account',payload->>'credential');
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
   IF c.agent_id<>aid OR c.status<>'connected' OR NOT agentonic.valid_gmail_tools(jsonb_build_array(jsonb_build_object('connectionId',c.id,'operations',payload->'operations'))) AND payload->'operations'<>'[]' THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_connections SET operations=payload->'operations' WHERE id=c.id; RETURN '{"ok":true}';
  ELSE RAISE insufficient_privilege; END IF;
 ELSIF operation IN ('invocations','inspect','confirm','cancel','complete') THEN
  IF operation='invocations' THEN
   SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=(payload->>'conversationId')::uuid AND workspace_id=w AND owner_member_id=m;
   IF conv.id IS NULL OR NOT agentonic.staging_conversation_authorized(conv) THEN RAISE insufficient_privilege; END IF;
   RETURN jsonb_build_object('items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'operation',v.operation,'account',gc.account,'status',v.status,'hash',v.arguments_sha256,'expiresAt',v.expires_at,'argumentsCiphertext',v.arguments_ciphertext,'result',v.result) ORDER BY v.created_at) FROM agentonic.gmail_invocations v JOIN agentonic.gmail_connections gc ON gc.id=v.connection_id WHERE v.conversation_id=conv.id AND v.owner_member_id=m AND gc.status='connected'),'[]'));
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
  IF i.status<>'pending' OR i.expires_at<=clock_timestamp() OR i.arguments_ciphertext IS NULL OR i.arguments_sha256 IS DISTINCT FROM payload->>'hash' THEN RAISE insufficient_privilege; END IF;
  IF operation='confirm' THEN
   UPDATE agentonic.gmail_invocations SET status='executing',approved_at=clock_timestamp() WHERE id=i.id;
  END IF;
  RETURN jsonb_build_object('credential',c.credential_ciphertext,'connectionId',c.id,'account',c.account,'argumentsCiphertext',i.arguments_ciphertext,'operation',i.operation);
 END IF;
 RAISE insufficient_privilege;
END $$;

-- Only a leased deployed turn may request live reads or propose a write. The
-- original worker heartbeat verifies service token, host, actor, lease and consent.
CREATE FUNCTION agentonic.gmail_staging(operation text,deployment_id uuid,secret text,job_id uuid,token uuid,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE d agentonic.deployments;conv agentonic.staging_conversations;t agentonic.staging_turns;r agentonic.configuration_releases;c agentonic.gmail_connections;g jsonb;op text:=payload->>'operation';
BEGIN
 PERFORM agentonic.staging_worker('heartbeat',deployment_id,secret,job_id,token,'{}');
 SELECT * INTO d FROM agentonic.deployments WHERE id=deployment_id;
 SELECT * INTO t FROM agentonic.staging_turns WHERE id=job_id;
 SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=t.conversation_id;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
 IF NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=r.code_release_id AND execution_manifest->>'gmailContract'='1') THEN RAISE insufficient_privilege; END IF;
 IF operation='gmail-tools' THEN RETURN jsonb_build_object('tools',r.requested_access_snapshot->'tools'); END IF;
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
 IF operation='gmail-propose' AND op IN ('gmail.drafts.create','gmail.drafts.update','gmail.drafts.delete','gmail.send') THEN
  IF (SELECT count(*) FROM agentonic.gmail_invocations WHERE turn_id=job_id)>=3 OR (SELECT count(*) FROM agentonic.gmail_invocations WHERE owner_member_id=conv.owner_member_id AND created_at>clock_timestamp()-interval '1 hour')>=30 THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.gmail_invocations(id,workspace_id,agent_id,connection_id,owner_member_id,turn_id,conversation_id,operation,arguments_ciphertext,arguments_sha256)
  VALUES((payload->>'id')::uuid,d.workspace_id,d.agent_id,c.id,conv.owner_member_id,job_id,conv.id,op,payload->>'argumentsCiphertext',payload->>'hash');
  RETURN jsonb_build_object('pendingApproval',true,'id',payload->>'id');
 END IF;
 RAISE insufficient_privilege;
END $$;
CREATE FUNCTION agentonic.gmail_register_tools() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text; ro boolean;
BEGIN
 IF NEW.execution_manifest->>'gmailContract' IS DISTINCT FROM '1' THEN RETURN NEW; END IF;
 FOREACH op IN ARRAY ARRAY['gmail.search','gmail.read','gmail.drafts.list','gmail.drafts.read','gmail.drafts.create','gmail.drafts.update','gmail.drafts.delete','gmail.send'] LOOP
  ro:=op IN ('gmail.search','gmail.read','gmail.drafts.list','gmail.drafts.read');
  INSERT INTO agentonic.code_tools(code_release_id,package_key,name,implementation_path,input_schema,read_only,requires_confirmation,expose_over_http,policy_contract)
   VALUES(NEW.id,'gmail-v1',op,'broker/gmail-v1','{"contract":"gmail-v1"}',ro,NOT ro,false,jsonb_build_object('environment','staging','ownerOnly',true,'humanConfirmation',NOT ro,'maxCallsPerTurn',3));
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER gmail_registry AFTER INSERT ON agentonic.code_releases FOR EACH ROW EXECUTE FUNCTION agentonic.gmail_register_tools();
CREATE FUNCTION agentonic.gmail_freeze_tools() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE g jsonb; op text; ct uuid;
BEGIN
 FOR g IN SELECT value FROM jsonb_array_elements(NEW.requested_access_snapshot->'tools') LOOP
  FOR op IN SELECT jsonb_array_elements_text(g->'operations') LOOP
   SELECT id INTO ct FROM agentonic.code_tools WHERE code_release_id=NEW.code_release_id AND package_key='gmail-v1' AND name=op;
   IF ct IS NULL THEN RAISE insufficient_privilege; END IF;
   INSERT INTO agentonic.configuration_tools(workspace_id,agent_id,code_release_id,configuration_release_id,code_tool_id,enabled,effective_policy)
    VALUES(NEW.workspace_id,NEW.agent_id,NEW.code_release_id,NEW.id,ct,true,jsonb_build_object('connectionId',g->>'connectionId','environment','staging','ownerOnly',true));
  END LOOP;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER gmail_frozen_tools AFTER INSERT ON agentonic.configuration_releases FOR EACH ROW EXECUTE FUNCTION agentonic.gmail_freeze_tools();
-- Erase pending private payloads on ordinary chat closure/stop and offboarding.
CREATE FUNCTION agentonic.gmail_scrub() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='staging_conversations' THEN
  IF to_jsonb(NEW)->>'closed_at' IS NOT NULL THEN
   UPDATE agentonic.gmail_invocations SET arguments_ciphertext=NULL,status=CASE WHEN status='pending' THEN 'cancelled' WHEN status='executing' THEN 'uncertain' ELSE status END WHERE conversation_id=NEW.id;
  END IF;
 ELSE
  IF to_jsonb(NEW)->>'status'<>'active' OR to_jsonb(NEW)->>'removed_at' IS NOT NULL THEN
   UPDATE agentonic.gmail_connections SET status='disconnected',credential_ciphertext=NULL,operations='[]' WHERE owner_member_id=NEW.id;
   UPDATE agentonic.gmail_invocations SET arguments_ciphertext=NULL,status=CASE WHEN status='pending' THEN 'cancelled' WHEN status='executing' THEN 'uncertain' ELSE status END WHERE owner_member_id=NEW.id;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gmail_chat_cleanup AFTER UPDATE ON agentonic.staging_conversations FOR EACH ROW EXECUTE FUNCTION agentonic.gmail_scrub();
CREATE TRIGGER gmail_offboarding AFTER UPDATE ON agentonic.workspace_members FOR EACH ROW EXECUTE FUNCTION agentonic.gmail_scrub();
REVOKE ALL ON FUNCTION agentonic.gmail_register_tools(),agentonic.gmail_freeze_tools(),agentonic.gmail_scrub() FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
ALTER FUNCTION agentonic.approved_review_receipt(uuid,uuid) RENAME TO approved_review_receipt_v28;
CREATE FUNCTION agentonic.approved_review_receipt(target uuid,trace_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; tools jsonb;
BEGIN
 result:=agentonic.approved_review_receipt_v28(target,trace_id);
 IF result IS NULL THEN RETURN NULL; END IF;
 IF result->'contentAvailable'='true' THEN
  SELECT r.requested_access_snapshot->'tools' INTO tools FROM agentonic.agent_submissions s JOIN agentonic.configuration_releases r ON r.id=s.configuration_release_id WHERE s.id=target AND s.workspace_id=agentonic.workspace_id();
 END IF;
 RETURN result||jsonb_build_object('tools',coalesce(tools,'[]'));
END $$;
REVOKE ALL ON FUNCTION agentonic.approved_review_receipt(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.approved_review_receipt(uuid,uuid) TO agentonic_admin;
REVOKE ALL ON FUNCTION agentonic.valid_gmail_tools(jsonb),agentonic.valid_draft(jsonb,jsonb),agentonic.gmail_allowed(agentonic.gmail_connections,uuid,uuid,text),agentonic.gmail_scope_guard(),agentonic.gmail_command(text,jsonb),agentonic.gmail_staging(text,uuid,text,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.gmail_command(text,jsonb) TO agentonic_customer;
GRANT EXECUTE ON FUNCTION agentonic.valid_draft(jsonb,jsonb),agentonic.valid_gmail_tools(jsonb) TO agentonic_customer,agentonic_admin;
GRANT EXECUTE ON FUNCTION agentonic.gmail_staging(text,uuid,text,uuid,uuid,jsonb) TO agentonic_runtime_local,agentonic_runtime_azure;
CREATE FUNCTION agentonic.gmail_deployment_scope(r agentonic.configuration_releases,m uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE g jsonb; op text;c agentonic.gmail_connections;
BEGIN
 IF NOT agentonic.valid_gmail_tools(r.requested_access_snapshot->'tools') THEN RETURN false; END IF;
 IF r.requested_access_snapshot->'tools'='[]' THEN RETURN true; END IF;
 IF NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=r.code_release_id AND execution_manifest->>'gmailContract'='1') THEN RETURN false; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(r.requested_access_snapshot->'tools') LOOP
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=(g->>'connectionId')::uuid AND workspace_id=r.workspace_id AND agent_id=r.agent_id;
  FOR op IN SELECT jsonb_array_elements_text(g->'operations') LOOP
   IF NOT agentonic.gmail_allowed(c,m,r.agent_id,op) OR NOT EXISTS(SELECT 1 FROM agentonic.configuration_tools config JOIN agentonic.code_tools code ON code.id=config.code_tool_id AND code.code_release_id=config.code_release_id WHERE config.configuration_release_id=r.id AND config.enabled AND code.package_key='gmail-v1' AND code.name=op AND config.effective_policy->>'connectionId'=c.id::text) THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION agentonic.gmail_deployment_scope(agentonic.configuration_releases,uuid) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
CREATE OR REPLACE FUNCTION agentonic.deployment_authorized(d agentonic.deployments) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r agentonic.configuration_releases;decision agentonic.submission_review_decisions;
BEGIN
 IF d.id IS NULL OR d.revoked_at IS NOT NULL OR d.authorized_until<=clock_timestamp() OR NOT agentonic.member_can_author(d.authorized_by_member_id,d.agent_id) THEN RETURN false; END IF;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id AND workspace_id=d.workspace_id;
 SELECT * INTO decision FROM agentonic.submission_review_decisions WHERE id=d.approval_id;
 RETURN coalesce(r.retired_at IS NULL AND r.id IS NOT NULL AND agentonic.gmail_deployment_scope(r,d.authorized_by_member_id)
 AND decision.decision='approved' AND decision.approved_access_sha256=r.requested_access_sha256
 AND NOT EXISTS(SELECT 1 FROM agentonic.submission_review_decisions later WHERE later.submission_id=d.submission_id AND later.decision_number>decision.decision_number)
 AND EXISTS(SELECT 1 FROM agentonic.agent_submissions s WHERE s.id=d.submission_id AND s.status='approved')
 AND EXISTS(SELECT 1 FROM agentonic.evaluation_runs e WHERE e.id=(decision.assessment_snapshot->>'evaluationId')::uuid AND e.consent_revoked_at IS NULL)
 AND (decision.actor_staff_id IS NULL OR EXISTS(SELECT 1 FROM agentonic.platform_staff st JOIN agentonic.users u ON u.id=st.user_id WHERE st.id=decision.actor_staff_id AND st.disabled_at IS NULL AND st.role IN ('administrator','operator') AND u.deleted_at IS NULL))
 AND EXISTS(SELECT 1 FROM agentonic.code_releases code JOIN agentonic.workspace_code_release_grants g ON g.code_release_id=code.id AND g.workspace_id=d.workspace_id
  JOIN agentonic.code_repositories repo ON repo.id=code.code_repository_id JOIN agentonic.runtime_hosts h ON h.id=d.host_id
  WHERE code.id=d.code_release_id AND code.revoked_at IS NULL AND code.retired_at IS NULL AND g.revoked_at IS NULL
  AND repo.provisioning_status='ready' AND (repo.visibility='platform' OR repo.workspace_id=d.workspace_id)
  AND code.execution_manifest->>'previewContract'='1' AND h.environment=d.environment AND h.revoked_at IS NULL AND h.verified_at>clock_timestamp()-interval '7 days' AND h.runtime_sha256=code.artifact_sha256)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.requested_access_snapshot->'collectionIds') c WHERE NOT agentonic.member_can_collection(d.authorized_by_member_id,c::uuid,'read'))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.requested_access_snapshot->'collections') col CROSS JOIN LATERAL jsonb_array_elements(col->'sources') src
  WHERE NOT EXISTS(SELECT 1 FROM agentonic.knowledge_sources k WHERE k.id=(src->>'id')::uuid AND k.workspace_id=d.workspace_id AND k.collection_id=(col->>'id')::uuid
   AND k.definition_sha256=src->>'hash' AND k.definition_revision=(src->>'revision')::bigint AND k.environment='staging' AND k.kind='upload' AND k.access_mode='collection'
   AND k.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb AND agentonic.member_can_collection(k.authorized_by_member_id,k.collection_id,'curate')))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.evidence_sources) hit WHERE NOT EXISTS(
  SELECT 1 FROM agentonic.document_chunks c JOIN agentonic.document_versions v ON v.id=c.document_version_id JOIN agentonic.documents doc ON doc.id=v.document_id
  WHERE c.workspace_id=d.workspace_id AND c.id=(hit->>'id')::uuid AND c.content_sha256=hit->>'hash' AND v.status='ready' AND doc.active_version_id=v.id AND doc.deleted_at IS NULL)),false);
END $$;
COMMIT;
