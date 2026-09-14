BEGIN;
GRANT USAGE ON SCHEMA agentonic TO agentonic_worker;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
-- One immutable embedding space. A model change requires an explicit reindex.
CREATE TABLE agentonic.retrieval_profile (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), singleton_key boolean NOT NULL UNIQUE DEFAULT true CHECK(singleton_key),
 provider text NOT NULL CHECK(provider='voyage'), model_identifier text NOT NULL CHECK(model_identifier='voyage-4'),
 dimensions integer NOT NULL CHECK(dimensions=1024), configuration jsonb NOT NULL, profile_sha256 text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO agentonic.retrieval_profile(provider,model_identifier,dimensions,configuration,profile_sha256)
 VALUES('voyage','voyage-4',1024,'{"version":1,"inputType":"document","chunker":"sections-v1","parser":"pdf-parse-2.4.5/text-v1"}',encode(sha256(convert_to('voyage-4:1024:sections-v1:pdf-parse-2.4.5/text-v1','UTF8')),'hex'));
CREATE TABLE agentonic.document_chunks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES agentonic.workspaces(id),
 document_version_id uuid NOT NULL, ordinal integer NOT NULL CHECK(ordinal>=0), content text NOT NULL CHECK(length(content) BETWEEN 1 AND 12000),
 content_sha256 text NOT NULL, locator jsonb NOT NULL, search_vector tsvector NOT NULL,
 embedding public.vector(1024) NOT NULL, embedded_at timestamptz NOT NULL DEFAULT now(), embedding_profile_id uuid NOT NULL REFERENCES agentonic.retrieval_profile(id),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,id), UNIQUE(workspace_id,document_version_id,ordinal),
 FOREIGN KEY(workspace_id,document_version_id) REFERENCES agentonic.document_versions(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX document_chunks_fts_idx ON agentonic.document_chunks USING gin(search_vector);
CREATE INDEX document_chunks_embedding_idx ON agentonic.document_chunks USING hnsw(embedding public.vector_cosine_ops);
-- This first queue consumer supports knowledge operations only. No runtime impersonation.
CREATE TABLE agentonic.background_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES agentonic.workspaces(id),
 kind text NOT NULL CHECK(kind IN ('ingest','purge','retrieve')), status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 member_id uuid, object_id uuid, payload jsonb NOT NULL DEFAULT '{}', result jsonb NOT NULL DEFAULT '{}',
 attempts integer NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz, available_at timestamptz NOT NULL DEFAULT now(),
 error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,member_id) REFERENCES agentonic.workspace_members(workspace_id,id),
 CHECK((status='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE UNIQUE INDEX knowledge_object_job ON agentonic.background_jobs(object_id,kind) WHERE object_id IS NOT NULL AND status IN ('queued','running');
CREATE INDEX background_jobs_claim ON agentonic.background_jobs(kind,available_at) WHERE status IN ('queued','running');
CREATE TABLE agentonic.ingestion_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES agentonic.workspaces(id), source_id uuid NOT NULL,
 background_job_id uuid NOT NULL UNIQUE, job_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,source_id,job_key), UNIQUE(workspace_id,background_job_id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES agentonic.knowledge_sources(workspace_id,id),
 FOREIGN KEY(workspace_id,background_job_id) REFERENCES agentonic.background_jobs(workspace_id,id) ON DELETE CASCADE
);
-- Narrow provider budget/ledger slice; amounts are micro-USD and unknown attempts
-- retain their entire reservation. No document/query text or credentials are recorded.
CREATE TABLE agentonic.retrieval_provider_budgets (
 provider text PRIMARY KEY CHECK(provider IN ('voyage','openai')), cap_microusd bigint NOT NULL DEFAULT 0 CHECK(cap_microusd>=0),
 committed_microusd bigint NOT NULL DEFAULT 0 CHECK(committed_microusd>=0), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO agentonic.retrieval_provider_budgets(provider) VALUES('voyage'),('openai');
CREATE TABLE agentonic.retrieval_provider_operations (
 id uuid PRIMARY KEY, job_id uuid NOT NULL, workspace_id uuid NOT NULL REFERENCES agentonic.workspaces(id), provider text NOT NULL REFERENCES agentonic.retrieval_provider_budgets(provider),
 model text NOT NULL, reserved_microusd bigint NOT NULL CHECK(reserved_microusd>0), actual_microusd bigint CHECK(actual_microusd>=0),
 input_tokens bigint CHECK(input_tokens>=0), output_tokens bigint CHECK(output_tokens>=0), status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','settled')),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE agentonic.retrieval_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentonic.document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentonic.background_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentonic.ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentonic.retrieval_provider_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentonic.retrieval_provider_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.retrieval_profile,agentonic.document_chunks,agentonic.background_jobs,agentonic.ingestion_jobs,agentonic.retrieval_provider_budgets,agentonic.retrieval_provider_operations FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;

CREATE FUNCTION agentonic.rag_job_authorized(j agentonic.background_jobs) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT CASE WHEN j.kind='purge' THEN EXISTS(SELECT 1 FROM agentonic.stored_objects o WHERE o.id=j.object_id AND o.workspace_id=j.workspace_id AND o.deleted_at IS NOT NULL)
 ELSE EXISTS(SELECT 1 FROM agentonic.workspace_members m JOIN agentonic.users u ON u.id=m.user_id JOIN agentonic.workspaces w ON w.id=m.workspace_id
 WHERE m.id=j.member_id AND m.workspace_id=j.workspace_id AND m.status='active' AND m.removed_at IS NULL AND u.deleted_at IS NULL AND w.status='active' AND w.deleted_at IS NULL)
 AND CASE WHEN j.kind='ingest' THEN EXISTS(SELECT 1 FROM agentonic.document_versions v JOIN agentonic.documents d ON d.id=v.document_id JOIN agentonic.knowledge_sources s ON s.id=d.source_id JOIN agentonic.stored_objects o ON o.id=v.object_id
 WHERE o.id=j.object_id AND o.workspace_id=j.workspace_id AND o.deleted_at IS NULL AND d.deleted_at IS NULL AND s.environment='staging' AND s.kind='upload' AND s.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb AND v.metadata->>'uploadStatus'='uploaded' AND agentonic.member_can_collection(j.member_id,s.collection_id,'curate'))
 ELSE j.created_at>clock_timestamp()-interval '10 minutes'
 AND jsonb_array_length(j.payload->'collectionIds')>0
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(j.payload->'collectionIds') c(id) WHERE NOT agentonic.member_can_collection(j.member_id,c.id::uuid,'read')) END END
$$;
REVOKE ALL ON FUNCTION agentonic.rag_job_authorized(agentonic.background_jobs) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;

CREATE FUNCTION agentonic.enqueue_ingestion(target uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id(); m uuid:=agentonic.current_member(); src uuid; job uuid;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR m IS NULL THEN RAISE insufficient_privilege; END IF;
 SELECT s.id INTO src FROM agentonic.document_versions v JOIN agentonic.documents d ON d.id=v.document_id JOIN agentonic.knowledge_sources s ON s.id=d.source_id JOIN agentonic.stored_objects o ON o.id=v.object_id
 WHERE o.id=target AND o.workspace_id=w AND o.deleted_at IS NULL AND d.deleted_at IS NULL AND s.kind='upload' AND s.environment='staging' AND s.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb AND v.metadata->>'uploadStatus'='uploaded' AND agentonic.can_collection(s.collection_id,'curate');
 IF src IS NULL THEN RAISE insufficient_privilege; END IF;
 INSERT INTO agentonic.background_jobs(workspace_id,member_id,object_id,kind) VALUES(w,m,target,'ingest') ON CONFLICT DO NOTHING RETURNING id INTO job;
 IF job IS NULL THEN SELECT id INTO job FROM agentonic.background_jobs WHERE object_id=target AND kind='ingest' AND status IN ('queued','running');
 ELSE
 INSERT INTO agentonic.ingestion_jobs(workspace_id,source_id,background_job_id,job_key) VALUES(w,src,job,job::text);
 UPDATE agentonic.document_versions SET status='processing',metadata=metadata-'processingError' WHERE object_id=target;
 END IF;
 RETURN job;
END $$;
REVOKE ALL ON FUNCTION agentonic.enqueue_ingestion(uuid) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;

-- Retain the reviewed authoring boundary; only the wrapper is callable by apps.
ALTER FUNCTION agentonic.authoring_command(text,jsonb,uuid) RENAME TO authoring_command_v6;
REVOKE ALL ON FUNCTION agentonic.authoring_command_v6(text,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
CREATE FUNCTION agentonic.authoring_command(operation text,payload jsonb,trace_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r jsonb; target uuid; doc uuid; src uuid; item jsonb; docs jsonb:='[]';
BEGIN
 r:=agentonic.authoring_command_v6(operation,payload,trace_id);
 IF r->>'ok'<>'true' THEN RETURN r; END IF;
 IF operation='upload.complete' THEN
  PERFORM agentonic.enqueue_ingestion((payload->>'objectId')::uuid);
 ELSIF operation IN ('document.remove','upload.fail') THEN
  target:=(payload->>'objectId')::uuid;
  SELECT d.id,d.source_id INTO doc,src FROM agentonic.documents d JOIN agentonic.document_versions v ON v.document_id=d.id WHERE v.object_id=target AND d.workspace_id=agentonic.workspace_id();
  UPDATE agentonic.documents SET active_version_id=NULL WHERE id=doc;
  DELETE FROM agentonic.document_chunks WHERE document_version_id IN (SELECT id FROM agentonic.document_versions WHERE document_id=doc);
  UPDATE agentonic.background_jobs SET status='cancelled',payload='{}',result='{}',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE workspace_id=agentonic.workspace_id() AND (object_id=target AND kind='ingest' OR kind='retrieve');
  INSERT INTO agentonic.background_jobs(workspace_id,object_id,kind) VALUES(agentonic.workspace_id(),target,'purge') ON CONFLICT DO NOTHING;
 ELSIF operation='list' THEN
  FOR item IN SELECT value FROM jsonb_array_elements(r->'data'->'documents') LOOP
   docs:=docs||jsonb_build_array(item||jsonb_build_object('chunkCount',(SELECT count(*) FROM agentonic.document_chunks c JOIN agentonic.document_versions v ON v.id=c.document_version_id WHERE v.object_id=(item->>'id')::uuid),
    'processingError',(SELECT metadata->>'processingError' FROM agentonic.document_versions WHERE object_id=(item->>'id')::uuid),
    'processingStatus',coalesce((SELECT status FROM agentonic.background_jobs WHERE object_id=(item->>'id')::uuid AND kind='ingest' ORDER BY created_at DESC LIMIT 1),'not_queued')));
  END LOOP;
  r:=jsonb_set(r,'{data,documents}',docs);
  r:=jsonb_set(r,'{data,pendingDeletions}',to_jsonb((SELECT count(*) FROM agentonic.background_jobs j JOIN agentonic.document_versions dv ON dv.object_id=j.object_id JOIN agentonic.documents dd ON dd.id=dv.document_id JOIN agentonic.knowledge_sources s ON s.id=dd.source_id WHERE j.workspace_id=agentonic.workspace_id() AND j.kind='purge' AND agentonic.can_collection(s.collection_id,'curate'))));
 END IF;
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION agentonic.authoring_command(text,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.authoring_command(text,jsonb,uuid) TO agentonic_customer,agentonic_admin;

CREATE FUNCTION agentonic.rag_command(operation text,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE w uuid:=agentonic.workspace_id(); m uuid:=agentonic.current_member(); j agentonic.background_jobs; ids jsonb; item jsonb; output jsonb;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR m IS NULL OR w IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 IF operation='ingest' THEN RETURN jsonb_build_object('id',agentonic.enqueue_ingestion((payload->>'objectId')::uuid));
 ELSIF operation='search' THEN
  ids:=payload->'collectionIds';
  IF length(btrim(payload->>'query')) NOT BETWEEN 1 AND 1000 OR payload->>'query' IS NULL OR jsonb_typeof(ids) IS DISTINCT FROM 'array' OR jsonb_array_length(ids) NOT BETWEEN 1 AND 20 OR NOT ids <@ (SELECT coalesce(jsonb_agg(id::text),'[]') FROM agentonic.knowledge_collections WHERE workspace_id=w AND agentonic.can_collection(id,'read')) THEN RAISE insufficient_privilege; END IF;
  IF (SELECT count(*) FROM agentonic.background_jobs WHERE member_id=m AND kind='retrieve' AND created_at>clock_timestamp()-interval '1 minute')>=10 THEN RAISE EXCEPTION 'Rate limit'; END IF;
  INSERT INTO agentonic.background_jobs(workspace_id,member_id,kind,payload) VALUES(w,m,'retrieve',jsonb_build_object('query',btrim(payload->>'query'),'collectionIds',ids,'generateAnswer',coalesce((payload->>'generateAnswer')::boolean,false))) RETURNING * INTO j;
  RETURN jsonb_build_object('id',j.id);
 ELSIF operation='result' THEN
  SELECT * INTO j FROM agentonic.background_jobs WHERE id=(payload->>'id')::uuid AND workspace_id=w AND member_id=m AND kind='retrieve';
  IF j.id IS NULL OR NOT agentonic.rag_job_authorized(j) THEN RETURN jsonb_build_object('status','unavailable','matches','[]'::jsonb); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'text',c.content,'locator',c.locator,'documentId',d.id,'objectId',v.object_id,'title',d.title,'version',v.version_key,'score',(hit.value->>'score')::double precision) ORDER BY hit.ordinality),'[]') INTO output
   FROM jsonb_array_elements(coalesce(j.result->'matches','[]')) WITH ORDINALITY hit(value,ordinality)
   JOIN agentonic.document_chunks c ON c.id=(hit.value->>'id')::uuid AND c.workspace_id=w JOIN agentonic.document_versions v ON v.id=c.document_version_id
   JOIN agentonic.documents d ON d.id=v.document_id AND d.active_version_id=v.id JOIN agentonic.knowledge_sources s ON s.id=d.source_id
   WHERE d.deleted_at IS NULL AND v.status='ready' AND s.environment='staging' AND s.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb AND agentonic.can_collection(s.collection_id,'read') AND j.payload->'collectionIds' @> to_jsonb(s.collection_id::text);
  IF jsonb_array_length(output)<>jsonb_array_length(coalesce(j.result->'matches','[]')) THEN RETURN jsonb_build_object('status','unavailable','matches','[]'::jsonb); END IF;
  RETURN jsonb_build_object('status',j.status,'error',j.error_code,'matches',output,'answer',j.result->'answer');
 END IF;
 RAISE insufficient_privilege;
END $$;
REVOKE ALL ON FUNCTION agentonic.rag_command(text,jsonb) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.rag_command(text,jsonb) TO agentonic_customer;

CREATE FUNCTION agentonic.rag_claim(purge_only boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j agentonic.background_jobs;
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 -- Short-lived query records never become a transcript or a content cache.
 DELETE FROM agentonic.background_jobs WHERE kind='retrieve' AND created_at<clock_timestamp()-interval '10 minutes';
 UPDATE agentonic.background_jobs SET status='failed',error_code='attempts_exhausted',lease_token=NULL,lease_until=NULL WHERE kind<>'purge' AND attempts>=5 AND (status='queued' OR status='running' AND lease_until<clock_timestamp());
 SELECT * INTO j FROM agentonic.background_jobs WHERE (NOT purge_only OR kind='purge') AND available_at<=clock_timestamp() AND (status='queued' OR status='running' AND lease_until<clock_timestamp()) ORDER BY CASE WHEN kind='purge' THEN 0 ELSE 1 END,created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF j.id IS NULL THEN RETURN NULL; END IF;
 IF NOT agentonic.rag_job_authorized(j) THEN UPDATE agentonic.background_jobs SET status='cancelled',payload='{}',result='{}',lease_token=NULL,lease_until=NULL WHERE id=j.id; RETURN NULL; END IF;
 UPDATE agentonic.background_jobs SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
 RETURN jsonb_build_object('id',j.id,'token',j.lease_token,'kind',j.kind);
END $$;
REVOKE ALL ON FUNCTION agentonic.rag_claim(boolean) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer;
GRANT EXECUTE ON FUNCTION agentonic.rag_claim(boolean) TO agentonic_worker;
-- Replace only the original authoring-only processing gates.
ALTER TABLE agentonic.documents DROP CONSTRAINT documents_check;
ALTER TABLE agentonic.documents ADD CONSTRAINT documents_rag_gate CHECK(source_url IS NULL AND acl_valid_until IS NULL);
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='agentonic.document_versions'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%parser_version%' AND pg_get_constraintdef(oid) LIKE '%chunker_version%' LOOP
 EXECUTE format('ALTER TABLE agentonic.document_versions DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE agentonic.document_versions ADD CONSTRAINT document_versions_rag_gate CHECK(
 status IN ('processing','ready','failed') AND parser_version IN ('pending','text-v1','pdf-parse-2.4.5') AND chunker_version IN ('pending','sections-v1') AND (status<>'ready' OR parser_version<>'pending' AND chunker_version='sections-v1'));

CREATE FUNCTION agentonic.rag_worker(operation text,job_id uuid,token uuid,payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE j agentonic.background_jobs; o agentonic.stored_objects; v agentonic.document_versions; d agentonic.documents;
 profile uuid; item jsonb; result jsonb; hits jsonb; src uuid; ordinal integer:=0; amount bigint; budget agentonic.retrieval_provider_budgets; meter agentonic.retrieval_provider_operations;
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 -- Consistent workspace-before-job ordering with customer mutations.
 SELECT * INTO j FROM agentonic.background_jobs WHERE id=job_id;
 IF j.id IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=j.workspace_id FOR SHARE;
 SELECT * INTO j FROM agentonic.background_jobs WHERE id=job_id FOR UPDATE;
 IF j.status<>'running' OR j.lease_token IS DISTINCT FROM token OR j.lease_until<=clock_timestamp() OR NOT agentonic.rag_job_authorized(j) THEN RAISE insufficient_privilege; END IF;
 IF operation='heartbeat' THEN
  UPDATE agentonic.background_jobs SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=j.id;
  RETURN '{"ok":true}';
 ELSIF operation='read' THEN
  IF j.kind='retrieve' THEN RETURN jsonb_build_object('kind',j.kind,'workspaceId',j.workspace_id,'query',j.payload->>'query','generateAnswer',j.payload->'generateAnswer'); END IF;
  SELECT * INTO o FROM agentonic.stored_objects WHERE id=j.object_id AND workspace_id=j.workspace_id;
  RETURN jsonb_build_object('kind',j.kind,'workspaceId',j.workspace_id,'objectId',o.id,'objectKey',o.object_key,'contentType',o.content_type,'sha256',o.content_sha256,'size',o.size_bytes);
 ELSIF operation='reserve' THEN
  IF j.kind='purge' OR NOT coalesce((payload->>'provider'='voyage' AND payload->>'model'='voyage-4') OR (j.kind='retrieve' AND j.payload->>'generateAnswer'='true' AND payload->>'provider'='openai' AND payload->>'model'='gpt-4.1-mini-2025-04-14'),false) THEN RAISE insufficient_privilege; END IF;
  amount:=(payload->>'microusd')::bigint;
  IF amount NOT BETWEEN 1 AND 1000000 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO budget FROM agentonic.retrieval_provider_budgets WHERE provider=payload->>'provider' FOR UPDATE;
  IF budget.committed_microusd+amount>budget.cap_microusd THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  INSERT INTO agentonic.retrieval_provider_operations(id,job_id,workspace_id,provider,model,reserved_microusd) VALUES((payload->>'id')::uuid,j.id,j.workspace_id,budget.provider,payload->>'model',amount);
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd+amount,updated_at=clock_timestamp() WHERE provider=budget.provider;
  RETURN '{"ok":true}';
 ELSIF operation='settle' THEN
  SELECT * INTO meter FROM agentonic.retrieval_provider_operations WHERE id=(payload->>'id')::uuid AND workspace_id=j.workspace_id AND job_id=j.id FOR UPDATE;
  IF meter.id IS NULL OR meter.status<>'reserved' THEN RAISE insufficient_privilege; END IF;
  amount:=(payload->>'microusd')::bigint;
  IF amount<0 OR (payload->>'tokens')::bigint<0 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.retrieval_provider_operations SET actual_microusd=amount,input_tokens=(payload->>'tokens')::bigint,output_tokens=coalesce((payload->>'outputTokens')::bigint,0),status='settled' WHERE id=meter.id;
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd-meter.reserved_microusd+amount,updated_at=clock_timestamp() WHERE provider=meter.provider;
  RETURN '{"ok":true}';
 ELSIF operation='publish' AND j.kind='ingest' THEN
  SELECT * INTO v FROM agentonic.document_versions WHERE object_id=j.object_id AND workspace_id=j.workspace_id FOR UPDATE;
  IF v.id IS NULL OR jsonb_typeof(payload->'chunks') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'chunks') NOT BETWEEN 1 AND 1000 OR payload->>'parser' NOT IN ('text-v1','pdf-parse-2.4.5') THEN RAISE insufficient_privilege; END IF;
  SELECT id INTO profile FROM agentonic.retrieval_profile WHERE model_identifier='voyage-4' AND dimensions=1024;
  DELETE FROM agentonic.document_chunks WHERE document_version_id=v.id;
  FOR item IN SELECT value FROM jsonb_array_elements(payload->'chunks') LOOP
   IF jsonb_array_length(item->'embedding')<>1024 OR length(item->>'text') NOT BETWEEN 1 AND 12000 THEN RAISE insufficient_privilege; END IF;
   INSERT INTO agentonic.document_chunks(workspace_id,document_version_id,ordinal,content,content_sha256,locator,search_vector,embedding,embedding_profile_id)
   VALUES(j.workspace_id,v.id,ordinal,item->>'text',encode(sha256(convert_to(item->>'text','UTF8')),'hex'),item->'locator',
    to_tsvector('pg_catalog.simple',item->>'text')||to_tsvector('pg_catalog.spanish',item->>'text')||to_tsvector('pg_catalog.english',item->>'text'),(item->'embedding')::text::public.vector,profile);
   ordinal:=ordinal+1;
  END LOOP;
  UPDATE agentonic.document_versions SET status='ready',parser_version=payload->>'parser',chunker_version='sections-v1',metadata=metadata-'processingError' WHERE id=v.id;
  UPDATE agentonic.documents SET active_version_id=v.id WHERE id=v.document_id AND deleted_at IS NULL;
  UPDATE agentonic.background_jobs SET status='succeeded',payload='{}',result='{}',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=j.id;
  RETURN jsonb_build_object('ok',true,'chunks',ordinal);
 ELSIF operation='search' AND j.kind='retrieve' THEN
  IF jsonb_array_length(payload->'embedding')<>1024 THEN RAISE insufficient_privilege; END IF;
  -- Materialize authorized active versions BEFORE either ranking operation.
  WITH eligible AS MATERIALIZED (
   SELECT c.* FROM agentonic.document_chunks c JOIN agentonic.document_versions dv ON dv.id=c.document_version_id JOIN agentonic.documents dd ON dd.id=dv.document_id AND dd.active_version_id=dv.id JOIN agentonic.knowledge_sources s ON s.id=dd.source_id
   WHERE c.workspace_id=j.workspace_id AND dd.deleted_at IS NULL AND dv.status='ready' AND s.environment='staging' AND s.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb AND j.payload->'collectionIds' @> to_jsonb(s.collection_id::text) AND agentonic.member_can_collection(j.member_id,s.collection_id,'read')
  ), semantic AS (
   SELECT id,row_number() OVER(ORDER BY embedding OPERATOR(public.<=>) (payload->'embedding')::text::public.vector,id) AS rank FROM eligible ORDER BY embedding OPERATOR(public.<=>) (payload->'embedding')::text::public.vector,id LIMIT 40
  ), lexical AS (
   SELECT id,row_number() OVER(ORDER BY ts_rank_cd(search_vector,q) DESC,id) AS rank FROM eligible, LATERAL(SELECT websearch_to_tsquery('pg_catalog.simple',j.payload->>'query')||websearch_to_tsquery('pg_catalog.spanish',j.payload->>'query')||websearch_to_tsquery('pg_catalog.english',j.payload->>'query') AS q) query
   WHERE search_vector@@q ORDER BY ts_rank_cd(search_vector,q) DESC,id LIMIT 40
  ), ranked AS (
   SELECT coalesce(s.id,l.id) id,coalesce(1.0/(60+s.rank),0)+coalesce(1.0/(60+l.rank),0) score FROM semantic s FULL JOIN lexical l ON s.id=l.id ORDER BY score DESC,coalesce(s.id,l.id) LIMIT 8
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'score',score) ORDER BY score DESC,id),'[]') INTO hits FROM ranked;
  UPDATE agentonic.background_jobs SET status=CASE WHEN j.payload->>'generateAnswer'='true' THEN 'running' ELSE 'succeeded' END,payload=CASE WHEN j.payload->>'generateAnswer'='true' THEN j.payload ELSE j.payload-'query' END,result=jsonb_build_object('matches',hits),lease_token=CASE WHEN j.payload->>'generateAnswer'='true' THEN j.lease_token ELSE NULL END,lease_until=CASE WHEN j.payload->>'generateAnswer'='true' THEN j.lease_until ELSE NULL END,updated_at=clock_timestamp() WHERE id=j.id;
  RETURN '{"ok":true}';
 ELSIF operation IN ('context','answer') AND j.kind='retrieve' AND j.payload->>'generateAnswer'='true' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'text',c.content) ORDER BY hit.ordinality),'[]') INTO hits
  FROM jsonb_array_elements(coalesce(j.result->'matches','[]')) WITH ORDINALITY hit(value,ordinality)
  JOIN agentonic.document_chunks c ON c.id=(hit.value->>'id')::uuid AND c.workspace_id=j.workspace_id
  JOIN agentonic.document_versions dv ON dv.id=c.document_version_id
  JOIN agentonic.documents dd ON dd.id=dv.document_id AND dd.active_version_id=dv.id
  JOIN agentonic.knowledge_sources s ON s.id=dd.source_id
  WHERE dd.deleted_at IS NULL AND dv.status='ready' AND s.environment='staging' AND s.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb
  AND j.payload->'collectionIds' @> to_jsonb(s.collection_id::text) AND agentonic.member_can_collection(j.member_id,s.collection_id,'read');
  IF jsonb_array_length(hits)<>jsonb_array_length(coalesce(j.result->'matches','[]')) THEN RAISE insufficient_privilege; END IF;
  IF operation='context' THEN RETURN jsonb_build_object('query',j.payload->>'query','passages',hits); END IF;
  IF length(payload->>'text') NOT BETWEEN 1 AND 12000 OR jsonb_typeof(payload->'citations') IS DISTINCT FROM 'array'
   OR payload->>'model'<>'gpt-4.1-mini-2025-04-14' OR jsonb_typeof(payload->'insufficientEvidence') IS DISTINCT FROM 'boolean'
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(payload->'citations') citation WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(hits) h WHERE h->>'id'=citation))
   OR (payload->>'insufficientEvidence'='false' AND jsonb_array_length(payload->'citations')=0) THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.background_jobs SET status='succeeded',payload=j.payload-'query',result=j.result||jsonb_build_object('answer',jsonb_build_object('text',payload->>'text','citations',payload->'citations','insufficientEvidence',payload->'insufficientEvidence','model',payload->>'model')),lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=j.id;
  RETURN '{"ok":true}';
 ELSIF operation='purged' AND j.kind='purge' THEN
  SELECT * INTO v FROM agentonic.document_versions WHERE object_id=j.object_id AND workspace_id=j.workspace_id;
  SELECT * INTO d FROM agentonic.documents WHERE id=v.document_id AND workspace_id=j.workspace_id;
  DELETE FROM agentonic.ingestion_jobs WHERE source_id=d.source_id AND workspace_id=j.workspace_id;
  DELETE FROM agentonic.background_jobs WHERE object_id=j.object_id AND id<>j.id;
  UPDATE agentonic.documents SET active_version_id=NULL WHERE id=d.id;
  DELETE FROM agentonic.document_versions WHERE document_id=d.id;
  DELETE FROM agentonic.documents WHERE id=d.id;
  DELETE FROM agentonic.knowledge_sources WHERE id=d.source_id AND workspace_id=j.workspace_id AND kind='upload' AND NOT EXISTS(SELECT 1 FROM agentonic.documents WHERE source_id=d.source_id);
  DELETE FROM agentonic.stored_objects WHERE id=j.object_id AND workspace_id=j.workspace_id AND deleted_at IS NOT NULL;
  DELETE FROM agentonic.background_jobs WHERE id=j.id;
  RETURN '{"ok":true}';
 ELSIF operation='fail' THEN
  IF payload->>'code' NOT IN ('provider_unavailable','budget_exhausted','invalid_document','ocr_required','too_much_text','storage_unavailable','configuration_required','lease_lost') THEN RAISE insufficient_privilege; END IF;
  IF j.kind='purge' OR payload->>'code' IN ('provider_unavailable','storage_unavailable','configuration_required') THEN
   UPDATE agentonic.background_jobs SET status='queued',lease_token=NULL,lease_until=NULL,error_code=payload->>'code',available_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() WHERE id=j.id;
  ELSE
   UPDATE agentonic.background_jobs SET status='failed',lease_token=NULL,lease_until=NULL,error_code=payload->>'code',payload=CASE WHEN kind='retrieve' THEN j.payload-'query' ELSE j.payload END,updated_at=clock_timestamp() WHERE id=j.id;
  END IF;
  IF j.kind='ingest' THEN UPDATE agentonic.document_versions SET status=CASE WHEN EXISTS(SELECT 1 FROM agentonic.documents WHERE active_version_id=document_versions.id) THEN 'ready' ELSE 'failed' END,metadata=metadata||jsonb_build_object('processingError',payload->>'code') WHERE object_id=j.object_id; END IF;
  RETURN '{"ok":true}';
 END IF;
 RAISE insufficient_privilege;
END $$;
REVOKE ALL ON FUNCTION agentonic.rag_worker(text,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer;
GRANT EXECUTE ON FUNCTION agentonic.rag_worker(text,uuid,uuid,jsonb) TO agentonic_worker;
CREATE FUNCTION agentonic.freeze_retrieval_profile() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'Retrieval profile requires an explicit migration to reindex'; END $$;
CREATE TRIGGER retrieval_profile_immutable BEFORE UPDATE OR DELETE ON agentonic.retrieval_profile FOR EACH ROW EXECUTE FUNCTION agentonic.freeze_retrieval_profile();
-- Retry cleanup of previously removed uploads too; no existing document is sent to a provider.
INSERT INTO agentonic.background_jobs(workspace_id,object_id,kind) SELECT workspace_id,id,'purge' FROM agentonic.stored_objects WHERE deleted_at IS NOT NULL ON CONFLICT DO NOTHING;
COMMIT;
