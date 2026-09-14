BEGIN;
-- Deferred constraint triggers fire at transaction commit, after SECURITY DEFINER
-- commands have returned. They must still lock and inspect the whole workspace
-- using the migration owner's authority; app roles deliberately cannot UPDATE
-- workspaces or bypass RLS. Trigger functions accept no user arguments, have a
-- fixed empty search_path and are not callable as ordinary SQL functions.
ALTER FUNCTION agentonic.check_workspace_owner() SECURITY DEFINER;
ALTER FUNCTION agentonic.check_resource_owners() SECURITY DEFINER;
REVOKE ALL ON FUNCTION agentonic.check_workspace_owner(),agentonic.check_resource_owners()
 FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
COMMIT;
