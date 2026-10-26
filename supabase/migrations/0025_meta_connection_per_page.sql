-- One ad account, several Pages (decision 2026-10-25, top of docs/decisions.md).
--
-- A Meta connection is an ad account + a Facebook Page + that Page's Instagram
-- account. 0013 keyed it by ad account alone, so assigning a second Page on the
-- same ad account replaced the first. A company may now hold one connection per
-- (ad account, Page); TikTok rows carry no Page and keep one row per ad account.
-- Idempotent.
begin;

alter table promote.launch_connections
  drop constraint if exists launch_connections_producer_id_provider_advertiser_id_key;

create unique index if not exists launch_connections_account_page_key
  on promote.launch_connections (producer_id, provider, advertiser_id, coalesce(payload->>'page_id', ''));

commit;
