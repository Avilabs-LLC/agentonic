BEGIN;

ALTER FUNCTION agentonic.authoring_command(text,jsonb,uuid) RENAME TO authoring_command_v9;
REVOKE ALL ON FUNCTION agentonic.authoring_command_v9(text,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;

CREATE FUNCTION agentonic.authoring_command(operation text,payload jsonb,trace_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 w uuid:=agentonic.workspace_id(); actor uuid:=agentonic.actor_user_id(); m uuid;
 c agentonic.knowledge_collections; r jsonb; objects uuid[];
BEGIN
 IF operation<>'collection.remove' THEN
  r:=agentonic.authoring_command_v9(operation,payload,trace_id);
  IF operation='list' AND r->>'ok'='true' THEN
   -- Archived collections no longer pass can_collection. Keep cleanup visible to
   -- their active owner/curators without exposing document names or contents.
   r:=jsonb_set(r,'{data,pendingDeletions}',to_jsonb(coalesce((r#>>'{data,pendingDeletions}')::bigint,0)+(
    SELECT count(*) FROM agentonic.background_jobs j
    JOIN agentonic.document_versions v ON v.object_id=j.object_id AND v.workspace_id=j.workspace_id
    JOIN agentonic.documents d ON d.id=v.document_id AND d.workspace_id=j.workspace_id
    JOIN agentonic.knowledge_sources s ON s.id=d.source_id AND s.workspace_id=j.workspace_id
    JOIN agentonic.knowledge_collections k ON k.id=s.collection_id AND k.workspace_id=j.workspace_id
    WHERE j.workspace_id=w AND j.kind='purge' AND k.archived_at IS NOT NULL AND agentonic.member_active(k.owner_member_id)
    AND (k.owner_member_id=agentonic.current_member() OR EXISTS(
     SELECT 1 FROM agentonic.collection_member_grants g WHERE g.collection_id=k.id AND g.workspace_id=w
     AND g.member_id=agentonic.current_member() AND g.permission='curate' AND g.revoked_at IS NULL AND g.granted_by_member_id=k.owner_member_id))
   )));
  END IF;
  RETURN r;
 END IF;
 IF agentonic.application_role()<>'agentonic_customer' OR actor IS NULL OR w IS NULL OR trace_id IS NULL THEN RAISE insufficient_privilege; END IF;
 -- Same lock order as uploads, authoring changes and runtime turns: no document
 -- can arrive between checking the confirmation and withdrawing the collection.
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 m:=agentonic.current_member();
 IF m IS NULL THEN RAISE insufficient_privilege; END IF;
 BEGIN
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR payload-ARRAY['collectionId','confirmationName']<>'{}'::jsonb
   OR jsonb_typeof(payload->'confirmationName') IS DISTINCT FROM 'string' OR length(payload->>'confirmationName')>120 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO c FROM agentonic.knowledge_collections WHERE id=(payload->>'collectionId')::uuid AND workspace_id=w AND archived_at IS NULL FOR UPDATE;
  IF c.id IS NULL OR NOT agentonic.can_collection(c.id,'curate') THEN RAISE insufficient_privilege; END IF;
  SELECT coalesce(array_agg(DISTINCT o.id),'{}'::uuid[]) INTO objects
   FROM agentonic.stored_objects o JOIN agentonic.document_versions v ON v.object_id=o.id AND v.workspace_id=w
   JOIN agentonic.documents d ON d.id=v.document_id AND d.workspace_id=w
   JOIN agentonic.knowledge_sources s ON s.id=d.source_id AND s.workspace_id=w
   WHERE o.workspace_id=w AND s.collection_id=c.id;
  IF EXISTS(SELECT 1 FROM agentonic.stored_objects WHERE id=ANY(objects) AND deleted_at IS NULL)
   AND payload->>'confirmationName' IS DISTINCT FROM c.name THEN
   RETURN '{"ok":false,"code":"confirmation_required"}';
  END IF;

  UPDATE agentonic.stored_objects SET deleted_at=coalesce(deleted_at,clock_timestamp()) WHERE id=ANY(objects) AND workspace_id=w;
  UPDATE agentonic.documents SET deleted_at=coalesce(deleted_at,clock_timestamp()),active_version_id=NULL
   WHERE workspace_id=w AND source_id IN (SELECT id FROM agentonic.knowledge_sources WHERE collection_id=c.id AND workspace_id=w);
  DELETE FROM agentonic.document_chunks WHERE workspace_id=w AND document_version_id IN (SELECT id FROM agentonic.document_versions WHERE object_id=ANY(objects));
  UPDATE agentonic.document_versions SET status='failed',metadata='{"uploadStatus":"removed"}' WHERE workspace_id=w AND object_id=ANY(objects);
  -- Retain the existing conservative workspace-wide answer invalidation policy.
  UPDATE agentonic.agent_previews SET status='cancelled' WHERE workspace_id=w AND status='running';
  UPDATE agentonic.background_jobs SET status='cancelled',payload='{}',result='{}',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
   WHERE workspace_id=w AND (kind='retrieve' OR kind='ingest' AND object_id=ANY(objects));
  INSERT INTO agentonic.background_jobs(workspace_id,object_id,kind) SELECT w,unnest(objects),'purge' ON CONFLICT DO NOTHING;

  -- Keep only a non-content tombstone for existing foreign keys/provenance. Live
  -- permission checks reject archived collections, including frozen snapshots.
  UPDATE agentonic.knowledge_collections SET archived_at=clock_timestamp(),name='Colección eliminada',description=NULL,slug='deleted-'||id::text WHERE id=c.id;
  INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,action,resource_type,resource_id,outcome,request_id)
   VALUES(w,actor,m,'collection.remove','collection',c.id::text,'succeeded',trace_id::text);
  RETURN jsonb_build_object('ok',true,'id',c.id,'data',NULL);
 EXCEPTION WHEN insufficient_privilege OR invalid_text_representation OR check_violation THEN
  INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,action,resource_type,resource_id,outcome,request_id)
   VALUES(w,actor,m,'authoring.denied','authoring','request','denied',trace_id::text);
  RETURN '{"ok":false}';
 END;
END $$;
REVOKE ALL ON FUNCTION agentonic.authoring_command(text,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.authoring_command(text,jsonb,uuid) TO agentonic_customer,agentonic_admin;
COMMIT;
