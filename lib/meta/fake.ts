import { MetaApiError, type MetaFile, type MetaObject, type MetaTransport } from "./transport";
import type { LaunchRun } from "@/lib/launch/types";

type FakeRow = MetaObject & { id: string; edge: string; account_id: string };
type Failure = { method: "GET" | "POST" | "UPLOAD"; path: string; after: boolean; ambiguous: boolean };
function removeRunObjects(objects: Map<string, FakeRow>, runs: readonly LaunchRun[]) {
  const ids = new Set<string>();
  const prefixes = runs.map(run => `${run.external_id}/`);
  for (const run of runs) for (const campaign of run.campaigns) {
    const saved = campaign.state.meta as {
      campaign_id?: string; adset_id?: string; creative_ids?: Record<string, string>;
      ad_ids?: Record<string, string>; video_ids?: Record<string, string>;
      intents?: Record<string, { id?: string }>;
    } | undefined;
    if (!saved) continue;
    for (const id of [saved.campaign_id, saved.adset_id,
      ...Object.values(saved.creative_ids ?? {}), ...Object.values(saved.ad_ids ?? {}),
      ...Object.values(saved.video_ids ?? {}), ...Object.values(saved.intents ?? {}).map(intent => intent.id)]) {
      if (id) ids.add(id);
    }
  }
  for (const [id, row] of objects) {
    // Names and video titles include the immutable run key, including when
    // an interrupted create has not recorded the returned ID yet.
    if (ids.has(id) || prefixes.some(prefix =>
      (typeof row.name === "string" && row.name.startsWith(prefix)) ||
      (typeof row.title === "string" && row.title.startsWith(prefix)))) objects.delete(id);
  }
}
/** Endpoint-level fake: launch, controls and monitor run the same provider code. */
export class FakeMetaTransport implements MetaTransport {
  readonly mode = "fake" as const;
  readonly calls: { method: string; path: string; params: MetaObject }[] = [];
  readonly objects = new Map<string, FakeRow>();
  private sequence = 0;
  private failures: Failure[] = [];
  private sources = new Map<string, MetaObject>();
  private blocked = new Set<string>();
  videoStatus = "ready";

  reset() { this.calls.length = 0; this.objects.clear(); this.sequence = 0; this.failures = []; this.sources.clear(); this.blocked.clear(); this.videoStatus = "ready"; }
  removeForRuns(runs: readonly LaunchRun[]) { removeRunObjects(this.objects, runs); }
  failNext(method: Failure["method"], path: string, opts: { after?: boolean; ambiguous?: boolean } = {}) {
    this.failures.push({ method, path, after: opts.after ?? false, ambiguous: opts.ambiguous ?? false });
  }
  seedSource(id: string, data: MetaObject) { this.sources.set(id, { id, ...data }); }
  rejectSource(id: string) { this.blocked.add(id); }
  snapshot() { return [...this.objects.values()].map(row => structuredClone(row)); }

  private fail(method: Failure["method"], path: string, after: boolean) {
    const at = this.failures.findIndex(f => f.method === method && f.path === path && f.after === after);
    if (at < 0) return;
    const [failure] = this.failures.splice(at, 1);
    throw new MetaApiError("Injected Meta endpoint failure.", 100, failure.ambiguous);
  }
  async get<T extends MetaObject = MetaObject>(path: string, params: MetaObject = {}): Promise<T> {
    this.calls.push({ method: "GET", path, params: structuredClone(params) });
    this.fail("GET", path, false);
    if (this.blocked.has(path)) throw new MetaApiError("Content is unavailable.", 100);
    const [id, edge] = path.split("/");
    if (edge === "insights") {
      const data = this.objects.has(id) ? [{ spend: "0", impressions: "0", clicks: "0" }] : [];
      return { data } as unknown as T;
    }
    if (edge === "instagram_accounts") return { data: [{ id: "demo-instagram", username: "demo" }, { id: "9000000000000020", username: "demo_studio" }] } as unknown as T;
    if (edge) return { data: this.snapshot().filter(r => r.account_id === id.replace(/^act_/, "") && r.edge === edge) } as unknown as T;
    const row = this.objects.get(id);
    if (row) return structuredClone(row) as T;
    const source = this.sources.get(id);
    if (source) return structuredClone(source) as T;
    if (id.startsWith("act_")) return { id, account_status: 1, currency: "USD", timezone_name: "America/Los_Angeles" } as unknown as T;
    return { id, from: { id: id.split("_")[0] }, owner: { id: "demo-instagram" } } as unknown as T;
  }

  private create(path: string, params: MetaObject): MetaObject {
    const [account, edge] = path.split("/");
    if (!edge) {
      const row = this.objects.get(account);
      if (!row) throw new MetaApiError("Object not found.", 100);
      Object.assign(row, structuredClone(params));
      if (params.status) row.effective_status = params.status;
      return { success: true };
    }
    const ref = params.object_story_id ?? params.source_instagram_media_id;
    if (typeof ref === "string" && this.blocked.has(ref)) throw new MetaApiError("Content is not eligible for ads.", 100);
    if (Array.isArray(params.execution_options) && params.execution_options.includes("validate_only")) return { success: true };
    const id = String(880000000000000n + BigInt(++this.sequence));
    const row: FakeRow = { ...structuredClone(params), id, account_id: account.replace(/^act_/, ""), edge };
    if (edge === "ads") row.creative = { id: (params.creative as MetaObject).creative_id };
    if (params.status) row.effective_status = params.status;
    if (edge === "advideos") {
      row.status = { video_status: this.videoStatus };
      row.thumbnails = { data: [{ uri: "https://example.com/demo-thumb.jpg", is_preferred: true }] };
    }
    this.objects.set(id, row);
    return { id };
  }
  async post<T extends MetaObject = MetaObject>(path: string, params: MetaObject): Promise<T> {
    this.calls.push({ method: "POST", path, params: structuredClone(params) });
    this.fail("POST", path, false);
    const result = this.create(path, params);
    this.fail("POST", path, true);
    return result as T;
  }
  async upload<T extends MetaObject = MetaObject>(path: string, params: MetaObject, files: Record<string, MetaFile>): Promise<T> {
    this.calls.push({ method: "UPLOAD", path, params: structuredClone(params) });
    this.fail("UPLOAD", path, false);
    if (!files.source?.bytes.length) throw new MetaApiError("Video is empty.", 100);
    const result = this.create(path, params);
    this.fail("UPLOAD", path, true);
    return result as T;
  }
}

const globalFake = globalThis as typeof globalThis & { __studioMetaFake?: FakeMetaTransport };
export const fakeMetaTransport = globalFake.__studioMetaFake ??= new FakeMetaTransport();
export const resetFakeMeta = () => fakeMetaTransport.reset();
// Next hot reload retains the process-wide instance, which may still have the
// previous class prototype. Operate on its Map directly instead of requiring
// a newly added method on that retained instance.
export const resetFakeMetaForRuns = (runs: readonly LaunchRun[]) => removeRunObjects(fakeMetaTransport.objects, runs);
export const fakeMetaSnapshot = () => fakeMetaTransport.snapshot();
