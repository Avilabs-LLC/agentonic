BEGIN;
-- Qualify payload: the PL/pgSQL argument otherwise shadows the history column.
CREATE OR REPLACE FUNCTION agentonic.rag_worker(operation text,job_id uuid,token uuid,payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
 ELSIF operation='context' THEN
  response:=agentonic.rag_worker_core_v8('context',job_id,token,'{}');
  SELECT coalesce(jsonb_agg(jsonb_build_object('path','skills/'||(s->>'name')||'.md','sha256',encode(sha256(convert_to(s->>'instructions','UTF8')),'hex')) ORDER BY s->>'name'),'[]') INTO assets FROM jsonb_array_elements(r.content->'skills') s;
  assets:=jsonb_build_array(jsonb_build_object('path','prompts/system.md','sha256',encode(sha256(convert_to(r.content->>'systemPrompt','UTF8')),'hex')))||assets;
  SELECT coalesce(jsonb_agg(jsonb_build_object('query',previous.payload->>'query','answer',previous.result->'answer'->>'text') ORDER BY previous.turn_number),'[]') INTO history FROM agentonic.background_jobs previous WHERE previous.preview_id=p.id AND previous.turn_number<j.turn_number AND previous.status='succeeded';
  RETURN response||jsonb_build_object('environment','staging','audience','private','expiresAt',p.expires_at,'configurationJson',r.content::text,'contentSha256',r.content_sha256,'composedPromptSha256',r.composed_prompt_sha256,'assetManifestJson',assets::text,'assetManifestSha256',r.asset_manifest_sha256,'accessJson',r.requested_access_snapshot::text,'accessSha256',r.requested_access_sha256,'history',history);
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
END $$;

COMMIT;
