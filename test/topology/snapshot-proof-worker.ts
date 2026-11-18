// SPDX-License-Identifier: GPL-2.0-or-later
import { Http, Streamsy } from "@streamsy/core";
import { CheckpointStore, Commit, Projection, ProjectionWakeup } from "@streamsy/projection";
import { StreamsyObject, ObjectLink, Placement, rule } from "@streamsy/serve/cloudflare";
import { DurableObjectStorage } from "@streamsy/storage/durable-object";
import { Layer, Schema } from "effect";
import type { DurableObjectNamespace, DurableObjectState } from "@cloudflare/workers-types";
class Input extends Streamsy.json<Input>()("Proof/Input", "proof/input/:id", { params: { id: Schema.String }, schema: Schema.Struct({ tic: Schema.Number }) }) {}
class Snapshots extends Streamsy.json<Snapshots>()("Proof/Snapshots", "proof/snapshots/:id", { params: { id: Schema.String }, schema: Schema.Struct({ tic: Schema.Number, data: Schema.String }) }) {}
class Index extends Streamsy.json<Index>()("Proof/Index", "proof/index/:id", { params: { id: Schema.String }, schema: Schema.Struct({ tic: Schema.Number, size: Schema.Number, start: Schema.String, end: Schema.String }) }) {}
function encodeBase64(bytes: Uint8Array) { let value = ""; for (let at = 0; at < bytes.length; at += 32768) value += String.fromCharCode(...bytes.subarray(at, at + 32768)); return btoa(value); }
const placement = Placement.byRoute([rule({ stream: Snapshots, owner: () => "game:proof" })]);
const link = ObjectLink.make({ group: Streamsy.group(Snapshots), prefix: "/__snapshots", placement, access: "append" });
const produce = Projection.emit({ id: "proof-produce", params: { id: Schema.String }, inputs: { input: Input }, outputs: { snapshots: Snapshots }, commit: Commit.producer,
  emit: ({ item }) => { const bytes = new Uint8Array(600_000); for (let n = 0; n < bytes.length; n++) bytes[n] = (n + item.tic) % 251; return { snapshots: [{ tic: item.tic, data: encodeBase64(bytes) }] }; } });
const index = Projection.mapAccumBatch({ id: "proof-index", params: { id: Schema.String }, inputs: { snapshots: Snapshots }, outputs: { index: Index }, commit: Commit.producer,
  state: { schema: Schema.String, initial: () => "-1" }, mapAccumBatch: (start, batch) => {
    const rows = batch.snapshots.items.map((item, n) => { const end = batch.snapshots.offsets![n]; const row = { tic: item.tic, size: atob(item.data).length, start, end }; start = end; return row; });
    return [start, { index: rows }] as const;
  } });
interface Env { GAMES: DurableObjectNamespace }
const family = Streamsy.group(Snapshots, Index);
const gameLayer = (state: DurableObjectState) => CheckpointStore.layer.pipe(Layer.provideMerge(DurableObjectStorage.layer(family, { client: { storage: state.storage } })));
const Game = StreamsyObject.make<Env, Layer.Success<ReturnType<typeof gameLayer>>>({ app: Layer.merge(Http.routes(family, { prefix: "/", access: "full", maxMessageSize: 2_000_000 }), link.routes),
  layer: gameLayer, wakeups: [ProjectionWakeup.attach(index)] });
export class ProofGame extends Game {
  constructor(private readonly owner: DurableObjectState, env: Env) { super(owner, env); }
  override async fetch(request: Request) {
    const response = await super.fetch(request);
    if (new URL(request.url).pathname === "/__probe") return Response.json({ posts: await this.owner.storage.get("posts"), failed: await this.owner.storage.get("failed") });
    if (request.method === "POST" && new URL(request.url).pathname.startsWith("/__snapshots/") && response.ok)
      await this.owner.storage.put("posts", (await this.owner.storage.get<number>("posts") ?? 0) + 1);
    if (request.method === "POST" && new URL(request.url).pathname.startsWith("/__snapshots/") && response.ok && !await this.owner.storage.get("failed")) {
      await this.owner.storage.put("failed", true); return new Response("Lost accepted response", { status: 503 });
    }
    return response;
  }
}
const replayLayer = (state: DurableObjectState) => CheckpointStore.layer.pipe(Layer.provideMerge(DurableObjectStorage.layer(Streamsy.group(Input), { client: { storage: state.storage } })));
export const ProofReplay = StreamsyObject.make<Env, Layer.Success<ReturnType<typeof replayLayer>>, Snapshots>({
  app: Http.routes(Streamsy.group(Input), { prefix: "/", access: "full" }), layer: replayLayer,
  links: env => [link.client(env.GAMES)], wakeups: [ProjectionWakeup.attach(produce)] });
export default { fetch() { return new Response(null, { status: 404 }); } };
