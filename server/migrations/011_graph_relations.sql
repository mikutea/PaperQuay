-- Relations use negotiated typed account UUID endpoints. Older clients advance
-- past these records without seeing an unsupported closed-schema entity.
ALTER TABLE paperquay.entities DROP CONSTRAINT entities_entity_type_check;
ALTER TABLE paperquay.entities ADD CONSTRAINT entities_entity_type_check
  CHECK (entity_type IN ('paper','attachmentVersion','note','annotation','readingPosition','aiConversation','aiTemplate','graphRelation'));
