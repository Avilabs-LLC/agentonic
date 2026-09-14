BEGIN;
-- Read only the verified actor's panel identity and active workspace summaries.
-- Like authorized_workspace_ids(), this is deliberate actor-scoped discovery:
-- no caller-supplied user ID, no customer content and no cross-request caching.
CREATE FUNCTION agentonic.identity_overview() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object(
  'user',(SELECT jsonb_build_object('id',u.id,'displayName',u.display_name) FROM agentonic.users u WHERE u.id=agentonic.actor_user_id()),
  'staff',(SELECT jsonb_build_object('id',s.id,'role',s.role) FROM agentonic.platform_staff s WHERE s.user_id=agentonic.actor_user_id() AND s.disabled_at IS NULL AND agentonic.application_role()='agentonic_admin'),
  'workspaces',coalesce((SELECT jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'kind',w.kind,'timezone',w.timezone,'role',m.role) ORDER BY w.created_at,w.id)
   FROM agentonic.workspace_members m JOIN agentonic.workspaces w ON w.id=m.workspace_id
   WHERE m.user_id=agentonic.actor_user_id() AND m.status='active' AND m.removed_at IS NULL AND w.status='active' AND w.deleted_at IS NULL),'[]'::jsonb)
 )
$$;
REVOKE ALL ON FUNCTION agentonic.identity_overview() FROM PUBLIC,anon,authenticated,service_role,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.identity_overview() TO agentonic_admin,agentonic_customer;

CREATE OR REPLACE FUNCTION agentonic.authoring_command(operation text,payload jsonb,trace_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_column
DECLARE
 w uuid:=agentonic.workspace_id(); actor uuid:=agentonic.actor_user_id(); m uuid; staff uuid; aid uuid; target uuid; rid uuid; gid uuid;
 result jsonb; allowed text[]; item jsonb; snapshot jsonb; consent jsonb; content jsonb; requested jsonb; expiry timestamptz;
 draft agentonic.configuration_drafts; release agentonic.configuration_releases; submission agentonic.agent_submissions;
 code agentonic.code_releases; obj agentonic.stored_objects; src uuid; doc uuid; revision bigint; collection uuid; platform_policy text; assets jsonb;
BEGIN
 IF agentonic.application_role() NOT IN ('agentonic_admin','agentonic_customer') OR actor IS NULL OR w IS NULL OR trace_id IS NULL THEN RAISE insufficient_privilege; END IF;
 -- Readers can coexist, but still conflict with permission/configuration writers.
 -- Audit inserts take compatible FK key-share locks; no authorization result is cached.
 IF operation IN ('list','detail','review.queue','review.read') THEN
  PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR SHARE;
 ELSE
  PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 END IF;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 m:=agentonic.current_member(); staff:=agentonic.current_staff();
 IF m IS NULL AND staff IS NULL THEN RAISE insufficient_privilege; END IF;
 BEGIN
 allowed:=CASE operation
 WHEN 'list' THEN ARRAY[]::text[] WHEN 'detail' THEN ARRAY['agentId'] WHEN 'draft.save' THEN ARRAY['agentId','revision','content','requestedAccess']
 WHEN 'candidate.freeze' THEN ARRAY['agentId','revision','codeReleaseId'] WHEN 'submission.send' THEN ARRAY['candidateId','note','consent']
 WHEN 'submission.withdraw' THEN ARRAY['submissionId'] WHEN 'upload.reserve' THEN ARRAY['collectionId','title','sha256','size','contentType']
 WHEN 'upload.complete' THEN ARRAY['objectId'] WHEN 'upload.fail' THEN ARRAY['objectId'] WHEN 'document.remove' THEN ARRAY['objectId'] WHEN 'document.download' THEN ARRAY['objectId']
 WHEN 'review.queue' THEN ARRAY[]::text[] WHEN 'review.open' THEN ARRAY['submissionId'] WHEN 'review.read' THEN ARRAY['submissionId','grantId'] WHEN 'review.decide' THEN ARRAY['submissionId','grantId','decision','feedback'] ELSE NULL END;
 IF allowed IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR payload-allowed<>'{}'::jsonb THEN RAISE insufficient_privilege; END IF;
 aid:=(payload->>'agentId')::uuid;
 IF operation IN ('detail','draft.save','candidate.freeze') AND NOT agentonic.can_agent(aid,'edit') THEN RAISE insufficient_privilege; END IF;
 IF operation='list' THEN
  IF m IS NULL THEN RAISE insufficient_privilege; END IF;
  result:=jsonb_build_object(
   'canCreate',agentonic.workspace_manager(),
   'agents',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'slug',a.slug,'description',a.description,'canEdit',agentonic.can_agent(a.id,'edit'),'status',a.status) ORDER BY a.created_at DESC) FROM agentonic.agents a WHERE a.workspace_id=w AND agentonic.can_agent(a.id,'read')),'[]'::jsonb),
   'collections',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'canCurate',agentonic.can_collection(c.id,'curate')) ORDER BY c.created_at DESC) FROM agentonic.knowledge_collections c WHERE c.workspace_id=w AND agentonic.can_collection(c.id,'read')),'[]'::jsonb),
   'templates',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'name',t.name,'version',v.version,'codeReleaseId',c.id,'codeVersion',c.version)) FROM agentonic.code_releases c JOIN agentonic.template_versions v ON v.id=c.template_version_id JOIN agentonic.agent_templates t ON t.id=v.template_id WHERE agentonic.can_use_code(c.id)),'[]'::jsonb),
   'documents',coalesce((SELECT jsonb_agg(jsonb_build_object('id',o.id,'title',d.title,'collectionId',s.collection_id,'size',o.size_bytes,'contentType',o.content_type,'uploadStatus',v.metadata->>'uploadStatus','status',v.status,'canRemove',agentonic.can_collection(s.collection_id,'curate')) ORDER BY o.created_at DESC) FROM agentonic.stored_objects o JOIN agentonic.document_versions v ON v.object_id=o.id AND v.workspace_id=w JOIN agentonic.documents d ON d.id=v.document_id JOIN agentonic.knowledge_sources s ON s.id=d.source_id WHERE o.workspace_id=w AND o.deleted_at IS NULL AND d.deleted_at IS NULL AND s.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb AND agentonic.can_collection(s.collection_id,'read')),'[]'::jsonb));
 ELSIF operation='detail' THEN
  SELECT * INTO draft FROM agentonic.configuration_drafts WHERE workspace_id=w AND agent_id=aid AND status='draft';
  result:=jsonb_build_object('agent',(SELECT jsonb_build_object('id',id,'name',name,'description',description,'templateVersionId',template_version_id) FROM agentonic.agents WHERE id=aid AND workspace_id=w),
   'draft',CASE WHEN draft.id IS NOT NULL THEN jsonb_build_object('revision',draft.revision,'content',draft.content,'requestedAccess',draft.requested_access) ELSE jsonb_build_object('revision',0,'content',jsonb_build_object('version',1,'systemPrompt','','skills','[]'::jsonb),'requestedAccess',jsonb_build_object('version',1,'collectionIds','[]'::jsonb,'tools','[]'::jsonb)) END,
   'candidates',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'version',version,'revision',source_draft_revision,'hash',content_sha256) ORDER BY created_at DESC) FROM agentonic.configuration_releases WHERE workspace_id=w AND agent_id=aid),'[]'::jsonb),
   'submissions',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'number',s.submission_number,'candidateId',s.configuration_release_id,'status',s.status,'note',s.customer_note,'decisions',coalesce((SELECT jsonb_agg(jsonb_build_object('decision',decision,'feedback',feedback,'number',decision_number) ORDER BY decision_number) FROM agentonic.submission_review_decisions WHERE submission_id=s.id AND workspace_id=w),'[]'::jsonb)) ORDER BY s.submission_number DESC) FROM agentonic.agent_submissions s WHERE workspace_id=w AND agent_id=aid),'[]'::jsonb));
 ELSIF operation='draft.save' THEN
  revision:=(payload->>'revision')::bigint;content:=payload->'content';requested:=payload->'requestedAccess';
  IF NOT agentonic.valid_draft(content,requested) OR revision IS NULL OR revision<0 THEN RAISE insufficient_privilege; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(requested->'collectionIds') LOOP
   IF NOT agentonic.can_collection((item#>>'{}')::uuid,'read') THEN RAISE insufficient_privilege; END IF;
  END LOOP;
  SELECT * INTO draft FROM agentonic.configuration_drafts WHERE workspace_id=w AND agent_id=aid AND status='draft' FOR UPDATE;
  IF coalesce(draft.revision,0)<>revision THEN RETURN jsonb_build_object('ok',false,'code','conflict'); END IF;
  IF draft.id IS NULL THEN
   INSERT INTO agentonic.configuration_drafts(workspace_id,agent_id,title,content,requested_access,created_by_member_id) VALUES(w,aid,'Configuración',content,requested,m) RETURNING id,configuration_drafts.revision INTO rid,revision;
  ELSE
   UPDATE agentonic.configuration_drafts SET content=payload->'content',requested_access=requested,revision=configuration_drafts.revision+1,updated_at=clock_timestamp() WHERE id=draft.id RETURNING id,configuration_drafts.revision INTO rid,revision;
  END IF;
  result:=jsonb_build_object('revision',revision);
 ELSIF operation='candidate.freeze' THEN
  SELECT * INTO draft FROM agentonic.configuration_drafts WHERE workspace_id=w AND agent_id=aid AND status='draft' FOR UPDATE;
  IF draft.id IS NULL OR draft.revision IS DISTINCT FROM (payload->>'revision')::bigint THEN RETURN jsonb_build_object('ok',false,'code','conflict'); END IF;
  IF length(btrim(draft.content->>'systemPrompt'))=0 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO code FROM agentonic.code_releases WHERE id=(payload->>'codeReleaseId')::uuid AND agentonic.can_use_code(id);
  IF code.id IS NULL OR NOT EXISTS(SELECT 1 FROM agentonic.agents WHERE id=aid AND workspace_id=w AND template_version_id=code.template_version_id) THEN RAISE insufficient_privilege; END IF;
  SELECT structure_manifest->>'platformPolicyText' INTO platform_policy FROM agentonic.template_versions WHERE id=code.template_version_id;
  IF platform_policy IS NULL OR length(platform_policy)=0 THEN RAISE insufficient_privilege; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('path','skills/'||(x->>'name')||'.md','sha256',encode(sha256(convert_to(x->>'instructions','UTF8')),'hex')) ORDER BY x->>'name'),'[]'::jsonb) INTO assets FROM jsonb_array_elements(draft.content->'skills') x;
  assets:=jsonb_build_array(jsonb_build_object('path','prompts/system.md','sha256',encode(sha256(convert_to(draft.content->>'systemPrompt','UTF8')),'hex')))||assets;
  FOR item IN SELECT value FROM jsonb_array_elements(draft.requested_access->'collectionIds') LOOP
   IF NOT agentonic.can_collection((item#>>'{}')::uuid,'read') THEN RAISE insufficient_privilege; END IF;
  END LOOP;
  snapshot:=draft.requested_access||jsonb_build_object('collections',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'sources',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'revision',s.definition_revision,'hash',s.definition_sha256) ORDER BY s.id) FROM agentonic.knowledge_sources s WHERE s.collection_id=c.id AND s.workspace_id=w AND s.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb),'[]'::jsonb)) ORDER BY c.id) FROM agentonic.knowledge_collections c WHERE c.workspace_id=w AND draft.requested_access->'collectionIds' @> to_jsonb(c.id::text)),'[]'::jsonb));
  INSERT INTO agentonic.configuration_releases(workspace_id,agent_id,code_release_id,source_draft_id,source_draft_revision,version,content,content_sha256,composed_prompt_sha256,asset_manifest_sha256,frozen_by_member_id,requested_access_snapshot,requested_access_sha256)
   VALUES(w,aid,code.id,draft.id,draft.revision,'r'||draft.revision||'-'||left(code.id::text,8),draft.content,agentonic.content_hash(draft.content),encode(sha256(convert_to(platform_policy||E'\n\n'||(draft.content->>'systemPrompt'),'UTF8')),'hex'),agentonic.content_hash(assets),m,snapshot,agentonic.content_hash(snapshot))
   ON CONFLICT(workspace_id,source_draft_id,source_draft_revision,code_release_id) DO NOTHING RETURNING id INTO rid;
  IF rid IS NULL THEN SELECT id INTO rid FROM agentonic.configuration_releases WHERE workspace_id=w AND source_draft_id=draft.id AND source_draft_revision=draft.revision AND code_release_id=code.id; END IF;
 ELSIF operation='submission.send' THEN
  SELECT * INTO release FROM agentonic.configuration_releases WHERE id=(payload->>'candidateId')::uuid AND workspace_id=w AND retired_at IS NULL;
  IF release.id IS NULL OR NOT agentonic.can_agent(release.agent_id,'edit') OR NOT agentonic.can_use_code(release.code_release_id) THEN RAISE insufficient_privilege; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(release.requested_access_snapshot->'collectionIds') LOOP IF NOT agentonic.can_collection((item#>>'{}')::uuid,'read') THEN RAISE insufficient_privilege; END IF; END LOOP;
  IF payload->'consent' IS DISTINCT FROM 'true'::jsonb OR length(coalesce(payload->>'note',''))>2000 THEN RAISE insufficient_privilege; END IF;
  expiry:=clock_timestamp()+interval '7 days';consent:=jsonb_build_object('version',1,'configuration',true,'knowledgeMetadata',true,'expiresAt',expiry);
  INSERT INTO agentonic.agent_submissions(workspace_id,agent_id,code_release_id,configuration_release_id,submission_number,submitted_by_member_id,customer_note,review_consent)
   SELECT w,release.agent_id,release.code_release_id,release.id,coalesce(max(submission_number),0)+1,m,payload->>'note',consent FROM agentonic.agent_submissions WHERE workspace_id=w AND agent_id=release.agent_id RETURNING id INTO rid;
 ELSIF operation='submission.withdraw' THEN
  SELECT * INTO submission FROM agentonic.agent_submissions WHERE workspace_id=w AND id=(payload->>'submissionId')::uuid FOR UPDATE;
  IF submission.id IS NULL OR NOT agentonic.can_agent(submission.agent_id,'edit') OR submission.status NOT IN ('submitted','in_review') THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.submission_review_decisions(workspace_id,agent_id,submission_id,decision_number,decision,actor_member_id,assessment_snapshot)
   SELECT w,submission.agent_id,submission.id,coalesce(max(decision_number),0)+1,'withdrawn',m,'{"version":1}'::jsonb FROM agentonic.submission_review_decisions WHERE submission_id=submission.id;
  UPDATE agentonic.agent_submissions SET status='withdrawn' WHERE id=submission.id;
  UPDATE agentonic.support_access_grants SET revoked_at=clock_timestamp() WHERE workspace_id=w AND scope->>'submissionId'=submission.id::text AND revoked_at IS NULL;rid:=submission.id;
 ELSIF operation='upload.reserve' THEN
  collection:=(payload->>'collectionId')::uuid;
  IF NOT agentonic.can_collection(collection,'curate') OR length(btrim(payload->>'title')) NOT BETWEEN 1 AND 200 OR payload->>'title' IS NULL THEN RAISE insufficient_privilege; END IF;
  IF (SELECT coalesce(sum(size_bytes),0) FROM agentonic.stored_objects WHERE workspace_id=w)+(payload->>'size')::bigint>524288000 THEN RAISE insufficient_privilege; END IF;
  rid:=gen_random_uuid();src:=gen_random_uuid();doc:=gen_random_uuid();
  INSERT INTO agentonic.knowledge_sources(id,workspace_id,collection_id,kind,locator,authorized_by_member_id,environment,definition_sha256) VALUES(src,w,collection,'upload',rid::text,m,'staging',agentonic.content_hash(jsonb_build_object('objectId',rid,'collectionId',collection)));
  INSERT INTO agentonic.stored_objects(id,workspace_id,provider,bucket,object_key,content_sha256,content_type,size_bytes) VALUES(rid,w,'supabase_storage','agentonic-documents',w::text||'/'||rid::text,payload->>'sha256',payload->>'contentType',(payload->>'size')::bigint);
  INSERT INTO agentonic.documents(id,workspace_id,source_id,external_document_id,title) VALUES(doc,w,src,rid::text,payload->>'title');
  INSERT INTO agentonic.document_versions(workspace_id,document_id,version_key,content_sha256,object_id,parser_version,chunker_version,metadata) VALUES(w,doc,'1',payload->>'sha256',rid,'pending','pending','{"uploadStatus":"pending"}'::jsonb);
  result:=jsonb_build_object('objectKey',w::text||'/'||rid::text);
 ELSIF operation IN ('upload.complete','upload.fail','document.remove','document.download') THEN
  SELECT * INTO obj FROM agentonic.stored_objects WHERE id=(payload->>'objectId')::uuid AND workspace_id=w AND deleted_at IS NULL;
  SELECT s.collection_id,s.id,d.id INTO collection,src,doc FROM agentonic.document_versions v JOIN agentonic.documents d ON d.id=v.document_id JOIN agentonic.knowledge_sources s ON s.id=d.source_id WHERE v.object_id=obj.id AND v.workspace_id=w AND d.deleted_at IS NULL AND s.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb;
  IF obj.id IS NULL OR collection IS NULL OR NOT agentonic.can_collection(collection,CASE WHEN operation='document.download' THEN 'read' ELSE 'curate' END) THEN RAISE insufficient_privilege; END IF;
  IF operation='upload.complete' THEN
   IF NOT EXISTS(SELECT 1 FROM agentonic.document_versions WHERE object_id=obj.id AND metadata->>'uploadStatus'='pending') THEN RAISE insufficient_privilege; END IF;
   IF (agentonic_bootstrap.storage_object_info(obj.object_key)->>'size')::bigint IS DISTINCT FROM obj.size_bytes THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.document_versions SET metadata='{"uploadStatus":"uploaded"}'::jsonb WHERE object_id=obj.id;
  ELSIF operation IN ('upload.fail','document.remove') THEN
   UPDATE agentonic.stored_objects SET deleted_at=clock_timestamp() WHERE id=obj.id;
   UPDATE agentonic.documents SET deleted_at=clock_timestamp() WHERE id=doc;
   UPDATE agentonic.document_versions SET status='failed',metadata='{"uploadStatus":"removed"}'::jsonb WHERE object_id=obj.id;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM agentonic.document_versions WHERE object_id=obj.id AND metadata->>'uploadStatus'='uploaded') THEN RAISE insufficient_privilege; END IF;
   result:=jsonb_build_object('objectKey',obj.object_key,'contentType',obj.content_type,'title',(SELECT title FROM agentonic.documents WHERE id=doc));
  END IF;rid:=obj.id;
 ELSIF operation='review.queue' THEN
  IF staff IS NULL THEN RAISE insufficient_privilege; END IF;
  result:=coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'agentName',a.name,'number',s.submission_number,'status',s.status) ORDER BY s.submitted_at) FROM agentonic.agent_submissions s JOIN agentonic.agents a ON a.id=s.agent_id WHERE s.workspace_id=w AND s.status IN ('submitted','in_review') AND (s.review_consent->>'expiresAt')::timestamptz>clock_timestamp() AND agentonic.member_can_author(s.submitted_by_member_id,s.agent_id)),'[]'::jsonb);
 ELSIF operation IN ('review.open','review.read','review.decide') THEN
  IF staff IS NULL THEN RAISE insufficient_privilege; END IF;
  IF operation='review.read' THEN
   SELECT * INTO submission FROM agentonic.agent_submissions WHERE id=(payload->>'submissionId')::uuid AND workspace_id=w;
  ELSE
   SELECT * INTO submission FROM agentonic.agent_submissions WHERE id=(payload->>'submissionId')::uuid AND workspace_id=w FOR UPDATE;
  END IF;
  IF submission.id IS NULL OR submission.status NOT IN ('submitted','in_review') OR NOT agentonic.member_can_author(submission.submitted_by_member_id,submission.agent_id) OR (submission.review_consent->>'expiresAt')::timestamptz<=clock_timestamp() THEN RAISE insufficient_privilege; END IF;
  IF operation='review.open' THEN
   SELECT id INTO gid FROM agentonic.support_access_grants WHERE workspace_id=w AND staff_id=staff AND scope=jsonb_build_object('version',2,'submissionId',submission.id::text,'operations',jsonb_build_array('review')) AND revoked_at IS NULL AND expires_at>clock_timestamp() LIMIT 1;
   IF gid IS NULL THEN
    INSERT INTO agentonic.support_access_grants(workspace_id,staff_id,approved_by_member_id,reason,scope,expires_at) VALUES(w,staff,submission.submitted_by_member_id,'Revisión solicitada por el cliente',jsonb_build_object('version',2,'submissionId',submission.id::text,'operations',jsonb_build_array('review')),(submission.review_consent->>'expiresAt')::timestamptz) RETURNING id INTO gid;
   END IF;
  ELSE gid:=(payload->>'grantId')::uuid; END IF;
  IF NOT agentonic.can_review(submission.id,gid) THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO release FROM agentonic.configuration_releases WHERE id=submission.configuration_release_id;
  FOR item IN SELECT value FROM jsonb_array_elements(release.requested_access_snapshot->'collectionIds') LOOP IF NOT agentonic.member_can_collection(submission.submitted_by_member_id,(item#>>'{}')::uuid,'read') THEN RAISE insufficient_privilege; END IF; END LOOP;
  IF operation IN ('review.open','review.read') THEN
   result:=jsonb_build_object('id',submission.id,'grantId',gid,'number',submission.submission_number,'agentName',(SELECT name FROM agentonic.agents WHERE id=submission.agent_id),'note',submission.customer_note,'content',release.content,'requestedAccess',release.requested_access_snapshot,'hash',release.content_sha256,'status',submission.status);
  ELSE
   IF payload->>'decision' NOT IN ('in_review','changes_requested','rejected') OR payload->>'decision' IS NULL OR payload->>'feedback' IS NULL OR length(btrim(payload->>'feedback')) NOT BETWEEN 1 AND 2000 THEN RAISE insufficient_privilege; END IF;
   INSERT INTO agentonic.submission_review_decisions(workspace_id,agent_id,submission_id,decision_number,decision,actor_staff_id,support_access_grant_id,feedback,assessment_snapshot)
    SELECT w,submission.agent_id,submission.id,coalesce(max(decision_number),0)+1,payload->>'decision',staff,gid,payload->>'feedback',jsonb_build_object('version',1,'configurationHash',release.content_sha256,'requestedAccessHash',release.requested_access_sha256,'evaluated',false) FROM agentonic.submission_review_decisions WHERE submission_id=submission.id;
   UPDATE agentonic.agent_submissions SET status=payload->>'decision' WHERE id=submission.id;
  END IF;rid:=submission.id;
 END IF;
 INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,support_access_grant_id,action,resource_type,resource_id,outcome,request_id)
 VALUES(w,actor,CASE WHEN operation LIKE 'review.%' THEN NULL ELSE m END,gid,operation,'authoring',coalesce(rid::text,aid::text,'workspace'),'succeeded',trace_id::text);
 RETURN jsonb_build_object('ok',true,'id',rid,'data',result);
 EXCEPTION WHEN insufficient_privilege THEN
 INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,action,resource_type,resource_id,outcome,request_id) VALUES(w,actor,m,'authoring.denied','authoring','request','denied',trace_id::text);
 RETURN jsonb_build_object('ok',false);
 END;
END $$;
COMMIT;
