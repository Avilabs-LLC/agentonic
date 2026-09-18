BEGIN;
-- Web is a platform capability, not an OAuth connection. Existing Gmail grants
-- retain their shape; both are frozen in the same reviewed access snapshot.
CREATE FUNCTION agentonic.gmail_grants(tools jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(value),'[]') FROM jsonb_array_elements(tools) WHERE value ? 'connectionId'
$$;
CREATE FUNCTION agentonic.has_web(tools jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce(tools @> '[{"capability":"web","operations":["web.search","web.read"]}]'::jsonb,false)
$$;
CREATE FUNCTION agentonic.valid_tools(tools jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE g jsonb; web_count integer:=0;
BEGIN
 IF jsonb_typeof(tools) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(tools)>2 THEN RETURN false; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(tools) LOOP
  IF g ? 'capability' THEN
   IF g <> '{"capability":"web","operations":["web.search","web.read"]}'::jsonb THEN RETURN false; END IF;
   web_count:=web_count+1;
  ELSIF NOT agentonic.valid_gmail_tools(jsonb_build_array(g)) THEN RETURN false;
  END IF;
 END LOOP;
 RETURN web_count<=1 AND agentonic.valid_gmail_tools(agentonic.gmail_grants(tools));
END $$;
CREATE OR REPLACE FUNCTION agentonic.valid_draft(content jsonb,requested jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT agentonic.valid_draft_v28(content,jsonb_set(requested,'{tools}','[]')) AND agentonic.valid_tools(requested->'tools')
$$;
CREATE OR REPLACE FUNCTION agentonic.gmail_scope_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE tools jsonb; g jsonb; c agentonic.gmail_connections; m uuid;
BEGIN
 tools:=CASE WHEN TG_TABLE_NAME='configuration_drafts' THEN to_jsonb(NEW)->'requested_access'->'tools' ELSE to_jsonb(NEW)->'requested_access_snapshot'->'tools' END;
 m:=agentonic.current_member();
 IF NOT agentonic.valid_tools(tools) THEN RAISE insufficient_privilege; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(agentonic.gmail_grants(tools)) LOOP
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=(g->>'connectionId')::uuid AND workspace_id=NEW.workspace_id AND agent_id=NEW.agent_id;
  IF c.id IS NULL OR c.owner_member_id IS DISTINCT FROM m OR c.status<>'connected' OR NOT agentonic.member_can_author(m,NEW.agent_id)
   OR NOT (c.operations @> (g->'operations')) THEN RAISE insufficient_privilege; END IF;
  IF TG_TABLE_NAME='configuration_releases' AND NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=(to_jsonb(NEW)->>'code_release_id')::uuid AND execution_manifest->>'gmailContract'='1') THEN RAISE EXCEPTION 'Gmail runtime required'; END IF;
 END LOOP;
 IF agentonic.has_web(tools) AND TG_TABLE_NAME='configuration_releases' AND NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=(to_jsonb(NEW)->>'code_release_id')::uuid AND execution_manifest->>'webContract'='1') THEN RAISE EXCEPTION 'Web runtime required'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION agentonic.gmail_freeze_tools() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE g jsonb; op text; ct uuid;
BEGIN
 FOR g IN SELECT value FROM jsonb_array_elements(agentonic.gmail_grants(NEW.requested_access_snapshot->'tools')) LOOP
  FOR op IN SELECT jsonb_array_elements_text(g->'operations') LOOP
   SELECT id INTO ct FROM agentonic.code_tools WHERE code_release_id=NEW.code_release_id AND package_key='gmail-v1' AND name=op;
   IF ct IS NULL THEN RAISE insufficient_privilege; END IF;
   INSERT INTO agentonic.configuration_tools(workspace_id,agent_id,code_release_id,configuration_release_id,code_tool_id,enabled,effective_policy)
    VALUES(NEW.workspace_id,NEW.agent_id,NEW.code_release_id,NEW.id,ct,true,jsonb_build_object('connectionId',g->>'connectionId','environment','staging','ownerOnly',true));
  END LOOP;
 END LOOP;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION agentonic.gmail_deployment_scope(r agentonic.configuration_releases,m uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE g jsonb; op text;c agentonic.gmail_connections;
BEGIN
 IF NOT agentonic.valid_gmail_tools(agentonic.gmail_grants(r.requested_access_snapshot->'tools')) THEN RETURN false; END IF;
 IF agentonic.gmail_grants(r.requested_access_snapshot->'tools')='[]' THEN RETURN true; END IF;
 IF NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=r.code_release_id AND execution_manifest->>'gmailContract'='1') THEN RETURN false; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(agentonic.gmail_grants(r.requested_access_snapshot->'tools')) LOOP
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=(g->>'connectionId')::uuid AND workspace_id=r.workspace_id AND agent_id=r.agent_id;
  FOR op IN SELECT jsonb_array_elements_text(g->'operations') LOOP
   IF NOT agentonic.gmail_allowed(c,m,r.agent_id,op) OR NOT EXISTS(SELECT 1 FROM agentonic.configuration_tools config JOIN agentonic.code_tools code ON code.id=config.code_tool_id AND code.code_release_id=config.code_release_id WHERE config.configuration_release_id=r.id AND config.enabled AND code.package_key='gmail-v1' AND code.name=op AND config.effective_policy->>'connectionId'=c.id::text) THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $$;

CREATE FUNCTION agentonic.web_register_tools() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text;
BEGIN
 IF NEW.execution_manifest->>'webContract' IS DISTINCT FROM '1' THEN RETURN NEW; END IF;
 FOREACH op IN ARRAY ARRAY['web.search','web.read'] LOOP
  INSERT INTO agentonic.code_tools(code_release_id,package_key,name,implementation_path,input_schema,read_only,requires_confirmation,expose_over_http,policy_contract)
  VALUES(NEW.id,'web-v1',op,'broker/web-v1','{"contract":"web-v1"}',true,false,false,'{"publicOnly":true,"maxCallsPerTurn":3}');
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER web_registry AFTER INSERT ON agentonic.code_releases FOR EACH ROW EXECUTE FUNCTION agentonic.web_register_tools();
CREATE FUNCTION agentonic.web_freeze_tools() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text;ct uuid;
BEGIN
 IF NOT agentonic.has_web(NEW.requested_access_snapshot->'tools') THEN RETURN NEW; END IF;
 FOREACH op IN ARRAY ARRAY['web.search','web.read'] LOOP
  SELECT id INTO ct FROM agentonic.code_tools WHERE code_release_id=NEW.code_release_id AND package_key='web-v1' AND name=op;
  IF ct IS NULL THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.configuration_tools(workspace_id,agent_id,code_release_id,configuration_release_id,code_tool_id,enabled,effective_policy)
  VALUES(NEW.workspace_id,NEW.agent_id,NEW.code_release_id,NEW.id,ct,true,'{"publicOnly":true}');
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER web_frozen_tools AFTER INSERT ON agentonic.configuration_releases FOR EACH ROW EXECUTE FUNCTION agentonic.web_freeze_tools();
CREATE FUNCTION agentonic.web_scope(r agentonic.configuration_releases) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT NOT agentonic.has_web(r.requested_access_snapshot->'tools') OR (
 EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=r.code_release_id AND execution_manifest->>'webContract'='1')
 AND EXISTS(SELECT 1 FROM agentonic.configuration_drafts WHERE agent_id=r.agent_id AND workspace_id=r.workspace_id AND agentonic.has_web(requested_access->'tools'))
 AND (SELECT count(*)=2 FROM agentonic.configuration_tools c JOIN agentonic.code_tools t ON t.id=c.code_tool_id AND t.code_release_id=c.code_release_id WHERE c.configuration_release_id=r.id AND c.enabled AND t.package_key='web-v1' AND t.name IN ('web.search','web.read')))
$$;
ALTER FUNCTION agentonic.deployment_authorized(agentonic.deployments) RENAME TO deployment_authorized_v30;
CREATE FUNCTION agentonic.deployment_authorized(d agentonic.deployments) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT agentonic.deployment_authorized_v30(d) AND EXISTS(SELECT 1 FROM agentonic.configuration_releases r WHERE r.id=d.configuration_release_id AND agentonic.valid_tools(r.requested_access_snapshot->'tools') AND agentonic.web_scope(r))
$$;
ALTER FUNCTION agentonic.preview_authorized(agentonic.agent_previews) RENAME TO preview_authorized_v30;
CREATE FUNCTION agentonic.preview_authorized(p agentonic.agent_previews) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT agentonic.preview_authorized_v30(p) AND (NOT agentonic.has_web(p.execution_policy->'tools') OR EXISTS(SELECT 1 FROM agentonic.configuration_releases r WHERE r.id=p.configuration_release_id AND agentonic.web_scope(r)))
$$;
ALTER FUNCTION agentonic.preview_command(text,jsonb) RENAME TO preview_command_v30;
CREATE FUNCTION agentonic.preview_command(operation text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;p agentonic.agent_previews;
BEGIN
 result:=agentonic.preview_command_v30(operation,payload);
 IF operation='state' AND result->>'ok'='true' THEN
  SELECT * INTO p FROM agentonic.agent_previews WHERE id=(result->>'id')::uuid;
  result:=result||jsonb_build_object('gmailEnabled',jsonb_array_length(agentonic.gmail_grants(p.execution_policy->'tools'))>0);
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION agentonic.preview_command_v30(text,jsonb),agentonic.preview_command(text,jsonb) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.preview_command(text,jsonb) TO agentonic_customer;
ALTER TABLE agentonic.retrieval_provider_budgets DROP CONSTRAINT retrieval_provider_budgets_provider_check;
ALTER TABLE agentonic.retrieval_provider_budgets ADD CONSTRAINT retrieval_provider_budgets_provider_check CHECK(provider IN ('voyage','openai','browserbase'));
-- An operator provisions a bounded budget; the migration itself enables no spend.
INSERT INTO agentonic.retrieval_provider_budgets(provider) VALUES('browserbase');
-- Only authenticated, currently leased preview/staging wrappers can invoke this.
-- Reserve the public overage estimate once, before the provider request. Unknown
-- outcomes retain reservations. No provider request arguments/content are stored.
CREATE FUNCTION agentonic.web_meter(operation text,job uuid,w uuid,aid uuid,preview uuid,deployment uuid,conversation uuid,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE budget agentonic.retrieval_provider_budgets; meter agentonic.retrieval_provider_operations; amount bigint; committed bigint; cap numeric;
BEGIN
 IF operation='web-check' THEN RETURN '{"ok":true}'; END IF;
 IF operation NOT IN ('web-reserve','web-settle') OR payload->>'operation' NOT IN ('web.search','web.read') OR payload->>'operation' IS NULL THEN RAISE insufficient_privilege; END IF;
 amount:=CASE WHEN payload->>'operation'='web.search' THEN 7000 ELSE 4000 END;
 SELECT * INTO budget FROM agentonic.retrieval_provider_budgets WHERE provider='browserbase' FOR UPDATE;
 IF operation='web-reserve' THEN
  IF (SELECT count(*) FROM agentonic.retrieval_provider_operations WHERE job_id=job AND provider='browserbase')>=3 THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  IF (SELECT count(*) FROM agentonic.retrieval_provider_operations WHERE provider='browserbase' AND model=payload->>'operation' AND created_at>clock_timestamp()-interval '1 second')>=(CASE WHEN payload->>'operation'='web.search' THEN 2 ELSE 5 END) THEN RETURN '{"ok":false,"code":"rate_limit"}'; END IF;
  IF preview IS NOT NULL THEN SELECT committed_microusd,budget_usd*1000000 INTO committed,cap FROM agentonic.agent_previews WHERE id=preview;
  ELSE SELECT committed_microusd,budget_usd*1000000 INTO committed,cap FROM agentonic.deployments WHERE id=deployment; END IF;
  IF budget.provider IS NULL OR cap IS NULL OR committed+amount>cap OR budget.committed_microusd+amount>budget.cap_microusd THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  INSERT INTO agentonic.retrieval_provider_operations(id,job_id,workspace_id,provider,model,reserved_microusd,agent_id,preview_id,deployment_id,conversation_id)
  VALUES((payload->>'id')::uuid,job,w,'browserbase',payload->>'operation',amount,aid,preview,deployment,conversation);
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd+amount,updated_at=clock_timestamp() WHERE provider='browserbase';
  IF preview IS NOT NULL THEN UPDATE agentonic.agent_previews SET committed_microusd=committed_microusd+amount WHERE id=preview;
  ELSE UPDATE agentonic.deployments SET committed_microusd=committed_microusd+amount WHERE id=deployment; END IF;
 ELSE
  SELECT * INTO meter FROM agentonic.retrieval_provider_operations WHERE id=(payload->>'id')::uuid AND job_id=job AND provider='browserbase' AND model=payload->>'operation' AND status='reserved' FOR UPDATE;
  IF meter.id IS NULL THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.retrieval_provider_operations SET status='settled',actual_microusd=reserved_microusd,input_tokens=0,output_tokens=0 WHERE id=meter.id;
 END IF;
 RETURN '{"ok":true}';
END $$;
CREATE FUNCTION agentonic.web_preview_worker(operation text,job_id uuid,token uuid,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j agentonic.background_jobs;p agentonic.agent_previews;
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 PERFORM agentonic.rag_worker('heartbeat',job_id,token,'{}');
 SELECT * INTO j FROM agentonic.background_jobs WHERE id=job_id;
 SELECT * INTO p FROM agentonic.agent_previews WHERE id=j.preview_id AND workspace_id=j.workspace_id AND requested_by_member_id=j.member_id;
 IF p.id IS NULL OR NOT agentonic.preview_authorized(p) THEN RAISE insufficient_privilege; END IF;
 IF operation='web-tools' THEN RETURN jsonb_build_object('enabled',agentonic.has_web(p.execution_policy->'tools')); END IF;
 IF NOT agentonic.has_web(p.execution_policy->'tools') THEN RAISE insufficient_privilege; END IF;
 RETURN agentonic.web_meter(operation,j.id,p.workspace_id,p.agent_id,p.id,NULL,NULL,payload);
END $$;
CREATE FUNCTION agentonic.web_staging(operation text,deployment_id uuid,secret text,job_id uuid,token uuid,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d agentonic.deployments;t agentonic.staging_turns;r agentonic.configuration_releases;
BEGIN
 PERFORM agentonic.staging_worker('heartbeat',deployment_id,secret,job_id,token,'{}');
 SELECT * INTO d FROM agentonic.deployments WHERE id=deployment_id;
 SELECT * INTO t FROM agentonic.staging_turns WHERE id=job_id;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
 IF operation='web-tools' THEN RETURN jsonb_build_object('enabled',agentonic.has_web(r.requested_access_snapshot->'tools')); END IF;
 IF NOT agentonic.has_web(r.requested_access_snapshot->'tools') OR NOT agentonic.web_scope(r) THEN RAISE insufficient_privilege; END IF;
 RETURN agentonic.web_meter(operation,t.id,d.workspace_id,d.agent_id,NULL,d.id,t.conversation_id,payload);
END $$;
REVOKE ALL ON FUNCTION agentonic.gmail_grants(jsonb),agentonic.has_web(jsonb),agentonic.valid_tools(jsonb),agentonic.web_register_tools(),agentonic.web_freeze_tools(),agentonic.web_scope(agentonic.configuration_releases),agentonic.deployment_authorized_v30(agentonic.deployments),agentonic.deployment_authorized(agentonic.deployments),agentonic.preview_authorized_v30(agentonic.agent_previews),agentonic.preview_authorized(agentonic.agent_previews),agentonic.web_meter(text,uuid,uuid,uuid,uuid,uuid,uuid,jsonb),agentonic.web_preview_worker(text,uuid,uuid,jsonb),agentonic.web_staging(text,uuid,text,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_runtime_local,agentonic_runtime_azure;
GRANT EXECUTE ON FUNCTION agentonic.valid_tools(jsonb),agentonic.gmail_grants(jsonb),agentonic.has_web(jsonb) TO agentonic_customer,agentonic_admin;
GRANT EXECUTE ON FUNCTION agentonic.web_preview_worker(text,uuid,uuid,jsonb) TO agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.web_staging(text,uuid,text,uuid,uuid,jsonb) TO agentonic_runtime_local,agentonic_runtime_azure;
COMMIT;
