BEGIN;
-- What each turn cost (architecture §82, owner request 14 October 2026): Chats
-- and Probar agente show under each answer what that turn cost and what the
-- conversation has cost so far, as Corby does in Slack. The figures come from
-- the provider ledger: every paid call of a turn is metered under its job.

-- A turn's calls are found by their job.
CREATE INDEX retrieval_provider_operations_job ON agentonic.retrieval_provider_operations(job_id);

-- One turn's spend: what its settled calls cost, and what calls still hold
-- without a settled amount, whose cost is unknown up to that hold (§50).
CREATE FUNCTION agentonic.turn_spend(job uuid,w uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object(
  'spentMicrousd',coalesce(sum(o.actual_microusd) FILTER (WHERE o.status='settled'),0),
  'heldMicrousd',coalesce(sum(o.reserved_microusd) FILTER (WHERE o.status='reserved'),0))
 FROM agentonic.retrieval_provider_operations o WHERE o.job_id=job AND o.workspace_id=w
$$;

-- Each chat turn carries its spend. The function that answered until now is
-- kept as it runs live and called first.
ALTER FUNCTION agentonic.staging_chat(text,jsonb) RENAME TO staging_chat_v76;
CREATE FUNCTION agentonic.staging_chat(operation text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 result:=agentonic.staging_chat_v76(operation,payload);
 IF operation='state' AND result->>'ok'='true' THEN
  result:=jsonb_set(result,'{turns}',coalesce((SELECT jsonb_agg(x.turn||agentonic.turn_spend((x.turn->>'id')::uuid,agentonic.workspace_id()) ORDER BY x.n)
   FROM jsonb_array_elements(result->'turns') WITH ORDINALITY x(turn,n)),'[]'::jsonb));
 END IF;
 RETURN result;
END $$;

-- And so does each Probar agente turn.
ALTER FUNCTION agentonic.preview_command(text,jsonb) RENAME TO preview_command_v76;
CREATE FUNCTION agentonic.preview_command(operation text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 result:=agentonic.preview_command_v76(operation,payload);
 IF operation='state' AND result->>'ok'='true' THEN
  result:=jsonb_set(result,'{turns}',coalesce((SELECT jsonb_agg(x.turn||agentonic.turn_spend((x.turn->>'id')::uuid,agentonic.workspace_id()) ORDER BY x.n)
   FROM jsonb_array_elements(result->'turns') WITH ORDINALITY x(turn,n)),'[]'::jsonb));
 END IF;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION agentonic.turn_spend(uuid,uuid),agentonic.staging_chat_v76(text,jsonb),agentonic.staging_chat(text,jsonb),agentonic.preview_command_v76(text,jsonb),agentonic.preview_command(text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.staging_chat(text,jsonb),agentonic.preview_command(text,jsonb) TO agentonic_customer;
COMMIT;
