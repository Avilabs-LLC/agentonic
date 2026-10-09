-- Careful grading (architecture §61, owner request, 9 October 2026).
-- A customer's mail agent failed one case on GPT-5.4 mini while GPT-6 Astra
-- passed: rubric 5 failed a reply titled "Borrador de respuesta" for not saying
-- it was a draft, and the case asked for a notice that nothing would be sent in
-- a run that cannot send. Each function below is its current definition
-- (migration 60) with only the noted change.
--
-- 1. Grader version 6: GPT-5.4 mini at medium reasoning, with rules for
--    alternatives in an expectation, drafts, and failures that name what is
--    missing. Runs created under rubric 5 keep it.
-- 2. New runs get rubric 6 only while the Azure evaluator advertises
--    reviewRubric 6; an evaluator advertising 5 still gives rubric 5.

-- 1. Runs may carry the rubric 6 grader.
ALTER TABLE agentonic.evaluation_runs DROP CONSTRAINT evaluation_runs_grader;
ALTER TABLE agentonic.evaluation_runs ADD CONSTRAINT evaluation_runs_grader CHECK(grader_sha256=agentonic.content_hash(grader_snapshot) AND ((preparation_id IS NULL AND grader_snapshot='{"version":"phrases-citations-v1","threshold":1}') OR (preparation_id IS NOT NULL AND grader_snapshot IN ('{"version":"grounded-review-v2","model":"gpt-4.1-mini-2025-04-14","policy":"readonly-review-v1"}'::jsonb,'{"version":"grounded-review-v3","model":"gpt-4.1-mini-2025-04-14","policy":"readonly-review-v1"}'::jsonb,'{"version":"grounded-review-v4","model":"gpt-4.1-mini-2025-04-14","policy":"readonly-review-v1"}'::jsonb,'{"version":"grounded-review-v5","model":"gpt-5.4-mini","reasoning":"low","policy":"readonly-review-v1"}'::jsonb,'{"version":"grounded-review-v6","model":"gpt-5.4-mini","reasoning":"medium","policy":"readonly-review-v1"}'::jsonb))));

-- 2. New runs use the newest rubric the evaluator can grade with.
CREATE OR REPLACE FUNCTION agentonic.evaluation_tool_cases()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE cases jsonb; v4 jsonb:='{"version":"grounded-review-v4","model":"gpt-4.1-mini-2025-04-14","policy":"readonly-review-v1"}'; v5 jsonb:='{"version":"grounded-review-v5","model":"gpt-5.4-mini","reasoning":"low","policy":"readonly-review-v1"}'; v6 jsonb:='{"version":"grounded-review-v6","model":"gpt-5.4-mini","reasoning":"medium","policy":"readonly-review-v1"}'; grader jsonb; fixtures boolean; rubric5 boolean; rubric6 boolean;
BEGIN
 IF NEW.preparation_id IS NULL OR NEW.environment<>'azure_staging' OR NEW.grader_snapshot->>'version' IS DISTINCT FROM 'grounded-review-v3' THEN RETURN NEW; END IF;
 -- What the registered Azure evaluator that runs this runtime can do.
 SELECT coalesce(bool_or(worker.verification @> '{"toolFixtures":1}'),false),coalesce(bool_or(worker.verification @> '{"reviewRubric":5}'),false),coalesce(bool_or(worker.verification @> '{"reviewRubric":6}'),false) INTO fixtures,rubric5,rubric6
 FROM agentonic.evaluation_workers worker JOIN agentonic.code_releases code ON code.id=NEW.code_release_id AND agentonic.evaluator_runs(worker.id,code.artifact_sha256)
 WHERE worker.environment='azure_staging' AND worker.revoked_at IS NULL AND worker.retired_at IS NULL AND worker.verified_at>clock_timestamp()-interval '30 days'
 AND worker.verification @> '{"reviewProtocol":3}';
 IF fixtures THEN
  SELECT agentonic.platform_tool_cases(r.requested_access_snapshot) INTO cases FROM agentonic.configuration_releases r WHERE r.id=NEW.configuration_release_id;
 END IF;
 IF coalesce(jsonb_array_length(cases),0)>0 THEN
  NEW.dataset_snapshot:=NEW.dataset_snapshot||cases;
  NEW.dataset_sha256:=agentonic.content_hash(NEW.dataset_snapshot);
  grader:=v4;
 END IF;
 -- Rubrics 5 and 6 contain version 4's tool rules, so they grade runs with or without tool cases.
 IF rubric6 THEN grader:=v6; ELSIF rubric5 THEN grader:=v5; END IF;
 IF grader IS NOT NULL THEN
  NEW.grader_snapshot:=grader;
  NEW.grader_sha256:=agentonic.content_hash(grader);
 END IF;
 RETURN NEW;
END $function$;
