-- Provision this independent LOGIN role as cluster administrator. Never grant
-- it to paperquay_runtime or reuse its password. No schema ownership, CREATE,
-- TRUNCATE, table deletion, or access to immutable payload history is granted.
GRANT USAGE ON SCHEMA paperquay TO paperquay_erasure;
GRANT SELECT ON paperquay.accounts,paperquay.devices,paperquay.account_erasure_devices TO paperquay_erasure;
-- SELECT FOR UPDATE needs an UPDATE privilege; closure columns remain protected.
GRANT UPDATE(id) ON paperquay.accounts TO paperquay_erasure;
GRANT UPDATE(last_seen_at) ON paperquay.devices TO paperquay_erasure;
GRANT EXECUTE ON FUNCTION paperquay.erasure_context_matches(uuid) TO paperquay_erasure;
GRANT EXECUTE ON FUNCTION paperquay.erase_account(uuid,uuid,text,boolean) TO paperquay_erasure;
