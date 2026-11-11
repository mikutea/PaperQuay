CREATE TABLE paperquay.account_model_settings (
  account_id uuid PRIMARY KEY REFERENCES paperquay.accounts(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  sealed text CHECK (sealed IS NULL OR octet_length(sealed) <= 16384)
);

ALTER TABLE paperquay.account_model_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE paperquay.account_model_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY own_account ON paperquay.account_model_settings
  USING (account_id = nullif(current_setting('paperquay.account_id', true), '')::uuid)
  WITH CHECK (account_id = nullif(current_setting('paperquay.account_id', true), '')::uuid);

CREATE FUNCTION paperquay.remove_closed_account_model_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, paperquay AS $function$
BEGIN
  DELETE FROM paperquay.account_model_settings WHERE account_id = NEW.id;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION paperquay.remove_closed_account_model_settings() FROM PUBLIC;
CREATE TRIGGER remove_closed_account_model_settings
  AFTER UPDATE OF closed_at ON paperquay.accounts
  FOR EACH ROW WHEN (OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL)
  EXECUTE FUNCTION paperquay.remove_closed_account_model_settings();
