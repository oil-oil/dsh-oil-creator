import type { WorkflowStage } from "../types.ts";
import type { StatusTone } from "./ui/StatusPill.tsx";

export const WORKFLOW_TONE: Record<WorkflowStage, StatusTone> = {
  idle: "neutral",
  record: "pending",
  cut: "pending",
  finish: "pending",
  publish: "pending",
  live: "success",
};
