// The job ids referenced from more than one fixture file (provenance on
// alternatives, variants and clips point back at the job that produced
// them). Kept apart from jobs.ts so ep1.ts can import ids without importing
// the job rows, which themselves import the episodes.

import { jobId } from "./ids";

export const jobIds = {
  parse: { 1: jobId(1), 2: jobId(2), 3: jobId(3), 4: jobId(24) } as Record<number, string>,
  understandTitle: jobId(4),
  /** understand_scene per scene: key `${ep}:${scene}`. */
  understandScene: {
    "1:1": jobId(5),
    "1:2": jobId(6),
    "1:3": jobId(7),
    "2:1": jobId(8),
    "2:2": jobId(9),
    "2:3": jobId(10),
  } as Record<string, string>,
  /** first_pass per scene: key `${ep}:${scene}`. */
  firstPass: {
    "1:1": jobId(11),
    "1:2": jobId(12),
    "1:3": jobId(13),
    "2:1": jobId(14),
    "2:2": jobId(15),
    "2:3": jobId(16),
  } as Record<string, string>,
  /** alternatives per adapted line of ep1, keyed by line seq. */
  alternatives: { 3: jobId(17), 11: jobId(18), 21: jobId(19), 25: jobId(20) } as Record<number, string>,
  proposeVariants: jobId(21),
  findClips: { 1: jobId(22), 2: jobId(23) } as Record<number, string>,
};
