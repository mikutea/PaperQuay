-- A handover recovers one task. It is not permission to repeat an uncertain
-- paid operation on a computer without the original private execution journal.
ALTER TABLE paperquay.remote_tasks ADD COLUMN recovery_provider_device_id uuid;
ALTER TABLE paperquay.remote_tasks ADD CONSTRAINT remote_task_recovery_provider
  FOREIGN KEY (account_id,recovery_provider_device_id) REFERENCES paperquay.devices(account_id,id);
ALTER TABLE paperquay.remote_tasks ADD CONSTRAINT remote_task_distinct_recovery_provider
  CHECK (recovery_provider_device_id IS NULL OR recovery_provider_device_id<>provider_device_id);
