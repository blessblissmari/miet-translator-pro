/**
 * Backward-compatible re-exports from the split planner modules.
 * Existing imports like `import { planSlides, planDoc } from "./planner"` continue to work.
 */
export { planSlides } from "./slidePlanner";
export { planDoc } from "./docPlanner";
export { stripCodeFences, parseMarkdownToBlocks } from "./plannerShared";
export type { PlannerOpts } from "./plannerShared";
