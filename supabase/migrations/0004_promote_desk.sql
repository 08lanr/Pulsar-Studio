-- Pulsar's Promote desk: staff answer a producer's change request with a new
-- creative version. The revision carries a note on what changed; the parent
-- row is superseded, never edited (0003's frozen-campaign guard still applies).
alter table promote.creatives add column if not exists revision_note text;
