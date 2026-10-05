-- Bootstrap-only privilege bridge. The Prisma migration invokes installation;
-- Storage objects and bucket metadata are never inserted/updated/deleted here.
CREATE OR REPLACE FUNCTION agentonic_bootstrap.storage_object_info(object_name text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT metadata FROM storage.objects WHERE bucket_id='agentonic-documents' AND name=object_name
$$;
REVOKE ALL ON FUNCTION agentonic_bootstrap.storage_object_info(text) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic_bootstrap.storage_object_info(text) TO agentonic_migrator;
CREATE OR REPLACE FUNCTION agentonic_bootstrap.install_storage_boundary() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id='agentonic-documents' AND NOT public AND file_size_limit<=10485760) THEN RAISE EXCEPTION 'Private document bucket required'; END IF;
 DROP POLICY IF EXISTS agentonic_document_insert ON storage.objects;
 DROP POLICY IF EXISTS agentonic_document_select ON storage.objects;
 DROP POLICY IF EXISTS agentonic_document_gate ON storage.objects;
 CREATE POLICY agentonic_document_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK(bucket_id='agentonic-documents' AND agentonic_storage.allowed(name,'upload'));
 CREATE POLICY agentonic_document_select ON storage.objects FOR SELECT TO authenticated USING(bucket_id='agentonic-documents' AND agentonic_storage.allowed(name,'read'));
 -- Existing permissive policies for unrelated buckets cannot bypass this boundary.
 CREATE POLICY agentonic_document_gate ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
 USING(bucket_id<>'agentonic-documents' OR agentonic_storage.allowed(name,'read'))
 WITH CHECK(bucket_id<>'agentonic-documents' OR agentonic_storage.allowed(name,'upload'));
 -- Uploaded artifacts are immutable. Only the knowledge worker's storage account may
 -- delete one, while a purge job for it holds a live lease (agentonic_storage.allowed).
 DROP POLICY IF EXISTS agentonic_document_anon_gate ON storage.objects;
 CREATE POLICY agentonic_document_anon_gate ON storage.objects AS RESTRICTIVE FOR ALL TO anon USING(bucket_id<>'agentonic-documents') WITH CHECK(bucket_id<>'agentonic-documents');
 DROP POLICY IF EXISTS agentonic_document_no_update ON storage.objects;
 DROP POLICY IF EXISTS agentonic_document_no_delete ON storage.objects;
 DROP POLICY IF EXISTS agentonic_document_delete ON storage.objects;
 CREATE POLICY agentonic_document_no_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated USING(bucket_id<>'agentonic-documents');
 CREATE POLICY agentonic_document_no_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated USING(bucket_id<>'agentonic-documents' OR agentonic_storage.allowed(name,'delete'));
 CREATE POLICY agentonic_document_delete ON storage.objects FOR DELETE TO authenticated USING(bucket_id='agentonic-documents' AND agentonic_storage.allowed(name,'delete'));
END $$;
REVOKE ALL ON FUNCTION agentonic_bootstrap.install_storage_boundary() FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic_bootstrap.install_storage_boundary() TO agentonic_migrator;
-- Migrations that need a newer boundary check this before installing it.
CREATE OR REPLACE FUNCTION agentonic_bootstrap.storage_boundary_version() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT 2 $$;
REVOKE ALL ON FUNCTION agentonic_bootstrap.storage_boundary_version() FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic_bootstrap.storage_boundary_version() TO agentonic_migrator;
