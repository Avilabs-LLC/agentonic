BEGIN;
-- Bounded research for newly published runtimes. Preserve old registry limits,
-- budgets, reservations, authorization wrappers and their restricted grants.
CREATE OR REPLACE FUNCTION agentonic.web_register_tools() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op text;
BEGIN
 IF NEW.execution_manifest->>'webContract' IS DISTINCT FROM '1' THEN RETURN NEW; END IF;
 FOREACH op IN ARRAY ARRAY['web.search','web.read'] LOOP
  INSERT INTO agentonic.code_tools(code_release_id,package_key,name,implementation_path,input_schema,read_only,requires_confirmation,expose_over_http,policy_contract)
  VALUES(NEW.id,'web-v1',op,'broker/web-v1','{"contract":"web-v1"}',true,false,false,jsonb_build_object('publicOnly',true,'maxCallsPerTurn',CASE WHEN NEW.execution_manifest->>'webResearch'='1' THEN 8 ELSE 3 END));
 END LOOP;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION agentonic.web_meter(operation text,job uuid,w uuid,aid uuid,preview uuid,deployment uuid,conversation uuid,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE budget agentonic.retrieval_provider_budgets; meter agentonic.retrieval_provider_operations; amount bigint; committed bigint; cap numeric; call_limit integer;
BEGIN
 IF operation='web-check' THEN RETURN '{"ok":true}'; END IF;
 IF operation NOT IN ('web-reserve','web-settle') OR payload->>'operation' NOT IN ('web.search','web.read') OR payload->>'operation' IS NULL THEN RAISE insufficient_privilege; END IF;
 amount:=CASE WHEN payload->>'operation'='web.search' THEN 7000 ELSE 4000 END;
 SELECT * INTO budget FROM agentonic.retrieval_provider_budgets WHERE provider='browserbase' FOR UPDATE;
 IF operation='web-reserve' THEN
  -- Resolve the immutable release's reviewed ceiling; old releases keep three.
  SELECT least(8,coalesce(min((ct.policy_contract->>'maxCallsPerTurn')::integer),3)) INTO call_limit
  FROM agentonic.code_tools ct WHERE ct.package_key='web-v1' AND ct.code_release_id=CASE WHEN preview IS NOT NULL
   THEN (SELECT code_release_id FROM agentonic.agent_previews WHERE id=preview)
   ELSE (SELECT code_release_id FROM agentonic.deployments WHERE id=deployment) END;
  IF (SELECT count(*) FROM agentonic.retrieval_provider_operations WHERE job_id=job AND provider='browserbase')>=call_limit THEN RETURN '{"ok":false,"code":"call_limit"}'; END IF;
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
COMMIT;
