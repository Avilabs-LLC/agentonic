-- Members' email for the Miembros table (owner request, 8 October 2026).
-- Supabase Auth stays the source of truth. This copy is the address of the
-- person's latest verified, confirmed session: the server sets it per
-- transaction (agentonic.verified_email) and it never comes from a form or the
-- browser. It is refreshed whenever the person loads either app and recorded
-- when an invitation is accepted. Only workspace managers see it, in member.list.
ALTER TABLE agentonic.users ADD COLUMN email text;
ALTER TABLE agentonic.users ADD CONSTRAINT users_email_normalized CHECK (email IS NULL OR (email=lower(btrim(email)) AND length(email) BETWEEN 3 AND 320 AND position('@' IN email)>1));

CREATE FUNCTION agentonic.verified_email() RETURNS text LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT CASE WHEN length(v) BETWEEN 3 AND 320 AND position('@' IN v)>1 THEN v END
 FROM (SELECT nullif(lower(btrim(current_setting('agentonic.verified_email',true))),'') v) s
$$;
REVOKE ALL ON FUNCTION agentonic.verified_email() FROM PUBLIC,anon,authenticated,service_role;

-- Called with every identity lookup; writes only when the address changed.
CREATE FUNCTION agentonic.record_verified_email() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE verified text:=agentonic.verified_email();
BEGIN
 IF agentonic.application_role() NOT IN ('agentonic_admin','agentonic_customer') OR verified IS NULL OR agentonic.actor_id() IS NULL THEN RETURN; END IF;
 UPDATE agentonic.users SET email=verified WHERE auth_user_id=agentonic.actor_id() AND deleted_at IS NULL AND email IS DISTINCT FROM verified;
END $$;
REVOKE ALL ON FUNCTION agentonic.record_verified_email() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION agentonic.record_verified_email() TO agentonic_admin,agentonic_customer;

-- access_command as live, with the email in member.list and on the user an
-- accepted invitation creates.
CREATE OR REPLACE FUNCTION agentonic.access_command(operation text, payload jsonb, trace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
 w uuid:=agentonic.workspace_id(); actor uuid:=agentonic.actor_user_id(); member_id uuid; staff_id uuid;
 target uuid; related uuid; result_id uuid; grant_id uuid; approver uuid; chosen_role text; own_role text;
 result jsonb; details jsonb:='{}'::jsonb; expected_keys text[]; item jsonb; expiry timestamptz;
 target_member agentonic.workspace_members; successor agentonic.workspace_members; invitation agentonic.workspace_invitations;
 resource_kind text:='access'; resource_label text:='request';
BEGIN
 IF agentonic.application_role() NOT IN ('agentonic_admin','agentonic_customer') OR (actor IS NULL AND operation<>'invite.accept') OR agentonic.actor_id() IS NULL OR w IS NULL OR trace_id IS NULL THEN
  RAISE insufficient_privilege USING MESSAGE='Access denied';
 END IF;
 -- Serializes grants, offboarding, ownership and commands in a workspace. Live
 -- authorization is resolved AFTER the lock at READ COMMITTED isolation.
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
 member_id:=agentonic.current_member(); staff_id:=agentonic.current_staff();
 IF member_id IS NULL AND staff_id IS NULL AND operation<>'invite.accept' THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
 SELECT role INTO own_role FROM agentonic.workspace_members WHERE id=member_id;
 BEGIN
  expected_keys:=CASE operation
   WHEN 'member.list' THEN ARRAY[]::text[]
   WHEN 'invite.list' THEN ARRAY[]::text[]
   WHEN 'agent.create' THEN ARRAY['name','slug','description','ownerMemberId','templateVersionId']
   WHEN 'collection.create' THEN ARRAY['name','slug','description']
   WHEN 'agent.share' THEN ARRAY['agentId','memberId','role']
   WHEN 'collection.share' THEN ARRAY['collectionId','memberId','permission']
   WHEN 'agent.revoke' THEN ARRAY['agentId','memberId']
   WHEN 'collection.revoke' THEN ARRAY['collectionId','memberId']
   WHEN 'contact.ensure' THEN ARRAY[]::text[]
   WHEN 'contact.create' THEN ARRAY['displayName']
   WHEN 'contact.block' THEN ARRAY['contactId','blocked']
   WHEN 'contact.grant' THEN ARRAY['agentId','contactId','capabilities','expiresAt']
   WHEN 'contact.revoke' THEN ARRAY['agentId','contactId']
   WHEN 'support.approve' THEN ARRAY['staffId','reason','scope','expiresAt']
   WHEN 'support.revoke' THEN ARRAY['grantId']
   WHEN 'support.read' THEN ARRAY['grantId','resourceType','resourceId']
   WHEN 'member.update' THEN ARRAY['memberId','role','status','successorMemberId']
   WHEN 'invite.issue' THEN ARRAY['email','role','tokenHash','expiresAt']
   WHEN 'invite.accept' THEN ARRAY['tokenHash']
   WHEN 'invite.revoke' THEN ARRAY['invitationId']
   ELSE NULL END;
  IF expected_keys IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(payload) k WHERE NOT k=ANY(expected_keys)) THEN
   RAISE insufficient_privilege USING MESSAGE='Access denied';
  END IF;
  IF operation IN ('member.list','invite.list') THEN
   IF NOT agentonic.workspace_manager() THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   IF operation='member.list' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'displayName',u.display_name,'email',u.email,'role',m.role,'status',m.status) ORDER BY m.created_at,m.id),'[]'::jsonb) INTO result
    FROM agentonic.workspace_members m JOIN agentonic.users u ON u.id=m.user_id WHERE m.workspace_id=w;
   ELSE
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'email',email_normalized,'role',role,'expiresAt',expires_at,'acceptedAt',accepted_at,'revokedAt',revoked_at) ORDER BY created_at,id),'[]'::jsonb) INTO result
    FROM agentonic.workspace_invitations WHERE workspace_id=w;
   END IF;
   result_id:=w; resource_kind:='workspace';
  ELSIF operation='agent.create' THEN
   IF NOT agentonic.workspace_manager() THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   related:=(payload->>'templateVersionId')::uuid; target:=coalesce((payload->>'ownerMemberId')::uuid,member_id);
   IF NOT agentonic.can_select_template(related) OR NOT agentonic.member_active(target) OR EXISTS(SELECT 1 FROM agentonic.workspace_members WHERE id=target AND role='viewer') THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   INSERT INTO agentonic.agents(workspace_id,name,slug,description,owner_member_id,template_version_id,created_by_member_id)
    VALUES(w,payload->>'name',payload->>'slug',payload->>'description',target,related,member_id) RETURNING id INTO result_id;
   resource_kind:='agent';
  ELSIF operation='collection.create' THEN
   IF member_id IS NULL OR own_role='viewer' THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   INSERT INTO agentonic.knowledge_collections(workspace_id,name,slug,description,owner_member_id)
    VALUES(w,payload->>'name',payload->>'slug',payload->>'description',member_id) RETURNING id INTO result_id;
   resource_kind:='collection';
  ELSIF operation IN ('agent.share','agent.revoke','collection.share','collection.revoke') THEN
   target:=coalesce(payload->>'agentId',payload->>'collectionId')::uuid; related:=(payload->>'memberId')::uuid;
   IF operation LIKE 'agent.%' THEN
    IF NOT agentonic.can_agent(target,'share') THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
    resource_kind:='agent';
   ELSE
    IF NOT agentonic.can_collection(target,'share') THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
    resource_kind:='collection';
   END IF;
   IF NOT agentonic.member_active(related) THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   IF operation='agent.share' THEN
    INSERT INTO agentonic.agent_member_grants(workspace_id,agent_id,member_id,role,granted_by_member_id)
    VALUES(w,target,related,payload->>'role',member_id) ON CONFLICT(workspace_id,agent_id,member_id) DO UPDATE SET role=excluded.role,granted_by_member_id=excluded.granted_by_member_id,revoked_at=NULL;
   ELSIF operation='collection.share' THEN
    INSERT INTO agentonic.collection_member_grants(workspace_id,collection_id,member_id,permission,granted_by_member_id)
    VALUES(w,target,related,payload->>'permission',member_id) ON CONFLICT(workspace_id,collection_id,member_id) DO UPDATE SET permission=excluded.permission,granted_by_member_id=excluded.granted_by_member_id,revoked_at=NULL;
   ELSIF operation='agent.revoke' THEN
    UPDATE agentonic.agent_member_grants SET revoked_at=clock_timestamp() WHERE workspace_id=w AND agent_id=target AND agent_member_grants.member_id=related;
   ELSE
    UPDATE agentonic.collection_member_grants SET revoked_at=clock_timestamp() WHERE workspace_id=w AND collection_id=target AND collection_member_grants.member_id=related;
   END IF;
   details:=jsonb_strip_nulls(jsonb_build_object('memberId',related,'role',payload->>'role','permission',payload->>'permission'));
   result_id:=target;
  ELSIF operation='contact.ensure' THEN
   IF member_id IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   INSERT INTO agentonic.contacts(workspace_id,display_name,linked_user_id,user_link_verified_at)
   SELECT w,left(display_name,120),actor,clock_timestamp() FROM agentonic.users WHERE id=actor
   ON CONFLICT(workspace_id,linked_user_id) DO UPDATE SET linked_user_id=excluded.linked_user_id RETURNING id INTO result_id;
   -- Never unblock a previously offboarded contact through re-linking.
   resource_kind:='contact';
  ELSIF operation='contact.create' THEN
   IF NOT agentonic.workspace_manager() THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   INSERT INTO agentonic.contacts(workspace_id,display_name) VALUES(w,payload->>'displayName') RETURNING id INTO result_id;
   resource_kind:='contact';
  ELSIF operation='contact.block' THEN
   IF NOT agentonic.workspace_manager() OR jsonb_typeof(payload->'blocked') IS DISTINCT FROM 'boolean' THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   UPDATE agentonic.contacts SET blocked_at=CASE WHEN (payload->>'blocked')::boolean THEN clock_timestamp() ELSE NULL END WHERE workspace_id=w AND id=(payload->>'contactId')::uuid RETURNING id INTO result_id;
   IF result_id IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   UPDATE agentonic.agent_contact_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=w AND contact_id=result_id AND (payload->>'blocked')::boolean;
   resource_kind:='contact';
  ELSIF operation IN ('contact.grant','contact.revoke') THEN
   target:=(payload->>'agentId')::uuid; related:=(payload->>'contactId')::uuid;
   IF NOT agentonic.can_agent(target,'share') OR NOT EXISTS(SELECT 1 FROM agentonic.contacts WHERE workspace_id=w AND id=related AND deleted_at IS NULL AND blocked_at IS NULL) THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   IF operation='contact.grant' THEN
    expiry:=(payload->>'expiresAt')::timestamptz;
    IF expiry IS NOT NULL AND expiry<=clock_timestamp() THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
    INSERT INTO agentonic.agent_contact_grants(workspace_id,agent_id,contact_id,allowed_capabilities,granted_by_member_id,expires_at)
    VALUES(w,target,related,payload->'capabilities',member_id,expiry) ON CONFLICT(workspace_id,agent_id,contact_id) DO UPDATE SET allowed_capabilities=excluded.allowed_capabilities,granted_by_member_id=excluded.granted_by_member_id,expires_at=excluded.expires_at,revoked_at=NULL;
   ELSE UPDATE agentonic.agent_contact_grants SET revoked_at=clock_timestamp() WHERE workspace_id=w AND agent_id=target AND contact_id=related; END IF;
   details:=jsonb_strip_nulls(jsonb_build_object('contactId',related,'capabilities',payload->'capabilities'));
   result_id:=target; resource_kind:='agent';
  ELSIF operation='support.approve' THEN
   IF member_id IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   expiry:=(payload->>'expiresAt')::timestamptz;
   IF expiry IS NULL OR expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '7 days' OR NOT EXISTS(SELECT 1 FROM agentonic.platform_staff s JOIN agentonic.users u ON u.id=s.user_id WHERE s.id=(payload->>'staffId')::uuid AND s.disabled_at IS NULL AND s.role IN ('administrator','operator','support') AND u.deleted_at IS NULL) THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   INSERT INTO agentonic.support_access_grants(workspace_id,staff_id,approved_by_member_id,reason,scope,expires_at)
   VALUES(w,(payload->>'staffId')::uuid,member_id,payload->>'reason',payload->'scope',expiry) RETURNING id INTO result_id;
   resource_kind:='support_grant';
  ELSIF operation='support.revoke' THEN
   UPDATE agentonic.support_access_grants SET revoked_at=coalesce(revoked_at,clock_timestamp())
   WHERE workspace_id=w AND id=(payload->>'grantId')::uuid AND (approved_by_member_id=member_id OR agentonic.workspace_manager()) RETURNING id INTO result_id;
   IF result_id IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   resource_kind:='support_grant';
  ELSIF operation='support.read' THEN
   grant_id:=(payload->>'grantId')::uuid; target:=(payload->>'resourceId')::uuid; resource_kind:=payload->>'resourceType';
   IF NOT agentonic.can_support(grant_id,resource_kind,target) THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   IF resource_kind='agent' THEN SELECT jsonb_build_object('id',id,'name',name,'description',description,'status',status) INTO result FROM agentonic.agents WHERE id=target AND workspace_id=w;
   ELSE SELECT jsonb_build_object('id',id,'name',name,'description',description) INTO result FROM agentonic.knowledge_collections WHERE id=target AND workspace_id=w; END IF;
   result_id:=target;
  ELSIF operation='member.update' THEN
   IF NOT agentonic.workspace_manager() THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   SELECT * INTO target_member FROM agentonic.workspace_members WHERE workspace_id=w AND id=(payload->>'memberId')::uuid;
   chosen_role:=payload->>'role';
   IF NOT FOUND OR target_member.status='removed' OR chosen_role IS NULL OR payload->>'status' IS NULL OR (own_role='admin' AND (target_member.role IN ('owner','admin') OR chosen_role IN ('owner','admin'))) THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   IF payload->>'successorMemberId' IS NOT NULL THEN
    IF own_role<>'owner' OR (payload->>'status'='active' AND chosen_role<>'viewer') THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
    SELECT * INTO successor FROM agentonic.workspace_members WHERE workspace_id=w AND id=(payload->>'successorMemberId')::uuid;
    IF NOT FOUND OR successor.id=target_member.id OR NOT agentonic.member_active(successor.id) OR successor.role='viewer' THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
    -- Transferring an owner never revives the previous owner's grants.
    UPDATE agentonic.agent_member_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=w AND agent_id IN (SELECT id FROM agentonic.agents WHERE workspace_id=w AND owner_member_id=target_member.id);
    UPDATE agentonic.agent_contact_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=w AND agent_id IN (SELECT id FROM agentonic.agents WHERE workspace_id=w AND owner_member_id=target_member.id);
    UPDATE agentonic.collection_member_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=w AND collection_id IN (SELECT id FROM agentonic.knowledge_collections WHERE workspace_id=w AND owner_member_id=target_member.id);
    UPDATE agentonic.support_access_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=w AND approved_by_member_id=target_member.id;
    UPDATE agentonic.agents SET owner_member_id=successor.id,updated_at=clock_timestamp() WHERE workspace_id=w AND owner_member_id=target_member.id;
    UPDATE agentonic.knowledge_collections SET owner_member_id=successor.id WHERE workspace_id=w AND owner_member_id=target_member.id;
   END IF;
   UPDATE agentonic.workspace_members SET role=chosen_role,status=payload->>'status',removed_at=CASE WHEN payload->>'status'='removed' THEN clock_timestamp() ELSE NULL END WHERE id=target_member.id;
   -- Evaluate deferred invariants inside this atomic command, before returning success.
   PERFORM agentonic.assert_owners(w);
   details:=jsonb_strip_nulls(jsonb_build_object('previousRole',target_member.role,'previousStatus',target_member.status,'role',chosen_role,'status',payload->>'status','successorMemberId',payload->>'successorMemberId'));
   result_id:=target_member.id; resource_kind:='member';
  ELSIF operation='invite.issue' THEN
   chosen_role:=payload->>'role'; expiry:=(payload->>'expiresAt')::timestamptz;
   IF NOT agentonic.workspace_manager() OR (chosen_role='admin' AND own_role<>'owner') OR expiry IS NULL OR expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '7 days' OR EXISTS(SELECT 1 FROM agentonic.workspaces WHERE id=w AND kind='personal') THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   UPDATE agentonic.workspace_invitations SET revoked_at=clock_timestamp() WHERE workspace_id=w AND email_normalized=lower(btrim(payload->>'email')) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at<=clock_timestamp();
   INSERT INTO agentonic.workspace_invitations(workspace_id,email_normalized,role,token_hash,invited_by_member_id,expires_at)
   VALUES(w,lower(btrim(payload->>'email')),chosen_role,payload->>'tokenHash',member_id,expiry) RETURNING id INTO result_id;
   resource_kind:='invitation';
  ELSIF operation='invite.accept' THEN
   IF agentonic.application_role()<>'agentonic_customer' THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   IF EXISTS(SELECT 1 FROM agentonic.users WHERE auth_user_id=agentonic.actor_id() AND deleted_at IS NOT NULL) THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   SELECT * INTO invitation FROM agentonic.workspace_invitations WHERE workspace_id=w AND token_hash=payload->>'tokenHash' FOR UPDATE;
   IF NOT FOUND OR invitation.accepted_at IS NOT NULL OR invitation.revoked_at IS NOT NULL OR invitation.expires_at<=clock_timestamp() OR
    invitation.email_normalized IS DISTINCT FROM nullif(lower(btrim(current_setting('agentonic.verified_email',true))),'') OR
    NOT agentonic.member_active(invitation.invited_by_member_id) OR NOT EXISTS(SELECT 1 FROM agentonic.workspace_members WHERE id=invitation.invited_by_member_id AND role IN ('owner','admin') AND (invitation.role<>'admin' OR role='owner')) OR
    EXISTS(SELECT 1 FROM agentonic.workspace_members WHERE workspace_id=w AND user_id=actor AND status='active') THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   IF actor IS NULL THEN
    INSERT INTO agentonic.users(auth_user_id,display_name,email) VALUES(agentonic.actor_id(),'Miembro',agentonic.verified_email())
    ON CONFLICT(auth_user_id) DO NOTHING;
    actor:=agentonic.actor_user_id();
    IF actor IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   END IF;
   INSERT INTO agentonic.workspace_members(workspace_id,user_id,role) VALUES(w,actor,invitation.role)
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active',removed_at=NULL,joined_at=clock_timestamp() RETURNING id INTO member_id;
   UPDATE agentonic.workspace_invitations SET accepted_at=clock_timestamp() WHERE id=invitation.id;
   result_id:=invitation.id; resource_kind:='invitation';
  ELSIF operation='invite.revoke' THEN
   IF NOT agentonic.workspace_manager() THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   UPDATE agentonic.workspace_invitations SET revoked_at=clock_timestamp() WHERE workspace_id=w AND id=(payload->>'invitationId')::uuid AND accepted_at IS NULL AND revoked_at IS NULL AND (role<>'admin' OR own_role='owner') RETURNING id INTO result_id;
   IF result_id IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   resource_kind:='invitation';
  END IF;
  resource_label:=coalesce(result_id::text,'request');
  INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,support_access_grant_id,action,resource_type,resource_id,outcome,request_id,redacted_details)
   VALUES(w,actor,member_id,CASE WHEN operation='support.read' THEN grant_id ELSE NULL END,operation,resource_kind,resource_label,'succeeded',trace_id::text,details);
  RETURN jsonb_build_object('ok',true,'id',result_id,'data',result);
 EXCEPTION WHEN insufficient_privilege THEN
  -- The subtransaction rolls back any partial writes before this safe denial event.
  -- Never persist arbitrary payloads, emails, tokens, names or private content.
  IF member_id IS NOT NULL OR staff_id IS NOT NULL THEN
   INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,action,resource_type,resource_id,outcome,request_id)
    VALUES(w,actor,member_id,'access.denied','access','request','denied',trace_id::text);
  END IF;
  RETURN jsonb_build_object('ok',false);
 END;
END $function$;
