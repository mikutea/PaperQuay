-- A failed handover to a computer without the journal must not lose the last
-- valid source. The holder advances only after a lease-bound confirmation of a
-- durable journal, before any paid provider request. It may be the current device.
ALTER TABLE paperquay.remote_tasks DROP CONSTRAINT remote_task_distinct_recovery_provider;
COMMENT ON COLUMN paperquay.remote_tasks.recovery_provider_device_id IS
  'Last account device which confirmed a durable local execution journal; retained across unsuccessful handovers';
