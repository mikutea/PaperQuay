-- Missing-request cancellation reserves its ID under the existing account lock.
-- Old receipts remain ordinary creation receipts; old binaries also reject the
-- domain-separated sentinel digest instead of creating a late paid task.
ALTER TABLE paperquay.remote_task_requests
  ADD COLUMN cancelled_before_create boolean NOT NULL DEFAULT false;
ALTER TABLE paperquay.remote_task_requests
  ADD CONSTRAINT remote_request_cancel_reservation CHECK (NOT cancelled_before_create OR job_id IS NULL);
