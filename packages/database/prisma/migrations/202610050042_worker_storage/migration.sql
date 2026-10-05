BEGIN;
-- The knowledge worker reaches Storage without the Supabase secret key (architecture §44).
-- It signs in as a dedicated Auth account whose app_metadata names it
-- (agentonic_service=storage_worker); only the Auth admin can set app_metadata.
-- That account can read a document object only while an ingestion or purge job for
-- it holds a live lease, and delete one only while a purge job does and the object
-- is already erased. Any other service claim is refused. Customer rules are unchanged.
DO $$
BEGIN
 IF to_regprocedure('agentonic_bootstrap.storage_boundary_version()') IS NULL
  OR agentonic_bootstrap.storage_boundary_version()<2 THEN
  RAISE EXCEPTION 'Run pnpm setup:storage before this migration';
 END IF;
END $$;
CREATE OR REPLACE FUNCTION agentonic_storage.allowed(object_name text,operation text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE auth_id uuid; m uuid; o agentonic.stored_objects; c uuid; uploader uuid; state text; service text;
BEGIN
 IF agentonic.application_role()<>'authenticated' THEN RETURN false; END IF;
 service:=nullif(current_setting('request.jwt.claims',true),'')::jsonb->'app_metadata'->>'agentonic_service';
 IF service IS NOT NULL THEN
  IF service<>'storage_worker' OR operation NOT IN ('read','delete') THEN RETURN false; END IF;
  RETURN EXISTS(SELECT 1 FROM agentonic.stored_objects so JOIN agentonic.background_jobs j ON j.object_id=so.id AND j.workspace_id=so.workspace_id
   WHERE so.object_key=object_name AND j.status='running' AND j.lease_until>clock_timestamp()
   AND CASE WHEN operation='delete' THEN j.kind='purge' AND so.deleted_at IS NOT NULL ELSE j.kind IN ('ingest','purge') END);
 END IF;
 IF operation NOT IN ('read','upload') THEN RETURN false; END IF;
 auth_id:=coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;
 SELECT * INTO o FROM agentonic.stored_objects WHERE object_key=object_name AND deleted_at IS NULL;
 IF o.id IS NULL OR auth_id IS NULL THEN RETURN false; END IF;
 SELECT wm.id INTO m FROM agentonic.workspace_members wm JOIN agentonic.users u ON u.id=wm.user_id WHERE wm.workspace_id=o.workspace_id AND u.auth_user_id=auth_id AND u.deleted_at IS NULL AND wm.status='active' AND wm.removed_at IS NULL;
 SELECT s.collection_id,s.authorized_by_member_id,v.metadata->>'uploadStatus' INTO c,uploader,state FROM agentonic.document_versions v JOIN agentonic.documents d ON d.id=v.document_id JOIN agentonic.knowledge_sources s ON s.id=d.source_id
 WHERE v.object_id=o.id AND v.workspace_id=o.workspace_id AND d.deleted_at IS NULL AND s.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb;
 IF m IS NULL OR c IS NULL THEN RETURN false; END IF;
 IF operation='upload' THEN RETURN m=uploader AND state='pending' AND agentonic.member_can_collection(m,c,'curate'); END IF;
 RETURN agentonic.member_can_collection(m,c,'read') AND (state='uploaded' OR (state='pending' AND m=uploader));
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION agentonic_storage.allowed(text,text) FROM PUBLIC,anon,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic_storage.allowed(text,text) TO authenticated;
-- The purge policy (storage-boundary.sql, version 2).
SELECT agentonic_bootstrap.install_storage_boundary();
COMMIT;
