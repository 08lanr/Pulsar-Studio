// One import for lib/jobs.ts: every prompt module, one per studio.job_kind
// (understand_title, understand_scene, first_pass, alternatives, rewrite,
// propose_variants = creative-pack, find_clips). Each exports its zod output
// schema, its input type and a build*() that returns the callStructured()
// arguments plus the prompt_version to stamp on the rows it produces.

export * from "./shared";
export * from "./understand-title";
export * from "./understand-scene";
export * from "./first-pass";
export * from "./alternatives";
export * from "./rewrite";
export * from "./creative-pack";
export * from "./find-clips";
