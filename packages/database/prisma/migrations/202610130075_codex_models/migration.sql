BEGIN;
-- The Codex models (architecture §77, owner decision 13 October 2026): agents
-- are offered the models the Codex app offers, GPT-6.1 Sol, GPT-6 Astra,
-- GPT-6 Sol, GPT-6 Luna, GPT-5.6 Sol, GPT-5.6 Terra and GPT-5.6 Luna.
-- GPT-5.4 and GPT-5.4 mini join GPT-4.1 mini in retirement: new evaluations
-- and test chats refuse them, while earlier results, approvals and the chats
-- of approved versions keep them, and GPT-5.4 mini still drafts criteria,
-- grades and writes style guides.
--
-- Runtimes before 0.8.0 name the models their turn spec accepts, so a version
-- frozen on them can run only those. Runtime 0.8.0 declares openModels and
-- accepts any model the broker offers.

-- 1. The new models and their reasoning levels. Every configuration valid
-- before stays valid, so existing rows keep satisfying the CHECKs that call it.
CREATE OR REPLACE FUNCTION agentonic.valid_model_configuration(model text,effort text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce((model='gpt-4.1-mini-2025-04-14' AND effort IS NULL)
 OR (model IN ('gpt-5.4-mini','gpt-5.4') AND effort IN ('none','low','medium','high','xhigh'))
 OR (model IN ('gpt-6.1-sol','gpt-6-astra') AND effort IN ('low','medium','high','xhigh','max'))
 OR (model IN ('gpt-6-sol','gpt-6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna') AND effort IN ('none','low','medium','high','xhigh','max')),false)
$$;

-- 2. Whether a version's runtime can run a model.
CREATE FUNCTION agentonic.runtime_runs_model(code uuid,model text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT model IN ('gpt-5.4-mini','gpt-5.4','gpt-6-astra','gpt-4.1-mini-2025-04-14')
  OR EXISTS(SELECT 1 FROM agentonic.code_releases c WHERE c.id=code AND c.execution_manifest->>'openModels'='1')
$$;
REVOKE ALL ON FUNCTION agentonic.runtime_runs_model(uuid,text) FROM PUBLIC,anon,authenticated,service_role,agentonic_customer,agentonic_admin,agentonic_worker,agentonic_eval_local,agentonic_eval_azure;

-- 3. New evaluations and test chats refuse retired models and models the
-- version's runtime cannot run (the triggers of migration 60).
CREATE OR REPLACE FUNCTION agentonic.refuse_retired_evaluation_models() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.models) choice
  WHERE choice->>'model' IN ('gpt-4.1-mini-2025-04-14','gpt-5.4-mini','gpt-5.4')
   OR NOT agentonic.runtime_runs_model((SELECT p.code_release_id FROM agentonic.evaluation_preparations p WHERE p.id=NEW.preparation_id),choice->>'model')) THEN
  RAISE insufficient_privilege;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION agentonic.refuse_retired_preview_models() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.response_model IN ('gpt-4.1-mini-2025-04-14','gpt-5.4-mini','gpt-5.4')
  OR NOT agentonic.runtime_runs_model((SELECT p.code_release_id FROM agentonic.agent_previews p WHERE p.id=NEW.preview_id),NEW.response_model) THEN
  RAISE insufficient_privilege;
 END IF;
 RETURN NEW;
END $$;
-- 4. A test-chat turn that names no model gets the default its version's
-- runtime can run: GPT-6.1 Sol at medium, or GPT-6 Astra at low on runtimes
-- before 0.8.0 (it was GPT-5.4 mini, migration 36). The apps always name one.
-- Otherwise the wrapper of migration 73, verbatim.
CREATE OR REPLACE FUNCTION agentonic.preview_command(operation text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;p agentonic.agent_previews;code uuid;
BEGIN
 IF operation='turn' AND NOT payload ? 'model' THEN
  IF payload->>'previewId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
   SELECT code_release_id INTO code FROM agentonic.agent_previews WHERE id=(payload->>'previewId')::uuid;
  END IF;
  payload:=payload||CASE WHEN agentonic.runtime_runs_model(code,'gpt-6.1-sol') THEN '{"model":"gpt-6.1-sol","reasoning":"medium"}' ELSE '{"model":"gpt-6-astra","reasoning":"low"}' END::jsonb;
 END IF;
 result:=agentonic.preview_command_v30(operation,payload);
 IF operation='state' AND result->>'ok'='true' THEN
  SELECT * INTO p FROM agentonic.agent_previews WHERE id=(result->>'id')::uuid;
  result:=result||jsonb_build_object('gmailEnabled',jsonb_array_length(agentonic.gmail_grants(p.execution_policy->'tools'))>0);
  -- A running turn shows its answer as it is written (§68), and every turn its steps (§74).
  result:=jsonb_set(result,'{turns}',coalesce((SELECT jsonb_agg(x.turn||CASE WHEN j.status='running' AND j.partial_answer IS NOT NULL THEN jsonb_build_object('partial',j.partial_answer) ELSE '{}'::jsonb END||CASE WHEN j.steps IS NOT NULL THEN jsonb_build_object('steps',j.steps) ELSE '{}'::jsonb END ORDER BY x.n)
   FROM jsonb_array_elements(result->'turns') WITH ORDINALITY x(turn,n) LEFT JOIN agentonic.background_jobs j ON j.id=(x.turn->>'id')::uuid AND j.preview_id=p.id),'[]'::jsonb));
 END IF;
 RETURN result;
END $$;
COMMIT;
