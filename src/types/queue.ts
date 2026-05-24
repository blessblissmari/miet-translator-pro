import type { SlidePlan, DocPlan } from "../lib/types";

export type Kind = "presentation" | "document";

export interface QueueItem {
  id: string;
  path: string;
  blob: Blob;
  kind: Kind;
  status:
    | "queued"
    | "extracting"
    | "translating"
    | "building"
    | "done"
    | "error";
  progress: { done: number; total: number } | null;
  error?: string;
  message?: string;
  slides?: SlidePlan[];
  doc?: DocPlan;
  resultBlob?: Blob;
  resultName?: string;
  /** ms timestamp when this item entered an active status. */
  startedAt?: number;
  /** elapsed time in ms after the item finished (success or error). */
  elapsedMs?: number;
}
