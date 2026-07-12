-- Allow auto-approved review decisions for push finalize (asset-hub redesign D1).
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_decision_check;
ALTER TABLE reviews ADD CONSTRAINT reviews_decision_check CHECK (
  decision IN ('approve', 'reject', 'need_more_evidence', 'split', 'auto-approved')
);
