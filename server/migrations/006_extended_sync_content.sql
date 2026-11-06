-- Existing Markdown remains protocol/schema 1. Rich notes use a negotiated
-- closed format discriminator; older clients cannot read or mutate them.
ALTER TABLE paperquay.entities DROP CONSTRAINT entities_entity_type_check;
ALTER TABLE paperquay.entities ADD CONSTRAINT entities_entity_type_check
  CHECK (entity_type IN ('paper','attachmentVersion','note','annotation','readingPosition','aiConversation','aiTemplate'));
