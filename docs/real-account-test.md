# Live account check

Run `npm run dev:live` from this checkout. It loads the existing local server environment, requires Supabase URL, anon key and service role key, then starts Studio at `http://localhost:3203/login` with `DATA_SOURCE=supabase`, TikTok production mode and a separate `.next-redesign-live` build directory. It does not modify environment files or enable `META_LIVE_WRITES`. Leave the existing demo server on port 3200 running.

Sign in with a real Supabase user. The fixture demo login does not authenticate to the live database. Staff can inspect `/tiktok` and `/meta`; a producer must have real company membership to use the producer portal. Staff preview can show the producer view, but does not grant producer actions.

The selected company is **Xinghai Pictures** (`00000000-0000-4000-8000-000000000001`). Its saved and verified TikTok assignment is Business Center **Azenda Germany RB_2** (`7660802168609538055`), with 30 accounts discovered and 13 enabled. Launch should list only eligible accounts inside that center. Its saved and verified Meta assignment is ad account **Crazy Drama US** (`act_4565068993810003`), portfolio `1713297459750982`, Facebook Page **CrazyDramasUS** (`1298189526712840`) and Instagram **@crazydramasus** (`17841434498347152`). Both bindings were persisted through the existing data layer; no ad objects were created.

Read-only discovery confirms the Instagram identity on the selected ad account and the Page in the token's accessible Pages. Meta omitted both the Page's `instagram_business_account` field and the ad account's `promote_pages` field, so Page/ad-account promotion compatibility cannot be confirmed before Meta validates a creative.

This check does not create ads. A real launch still needs the producer's exact Spark codes or finished Meta files, destination, budget, schedule and approver submission. Do not apply SQL migration `0011` automatically or restart existing servers as part of this check.
