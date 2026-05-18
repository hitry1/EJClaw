import type { AgentTriggerReason } from './agent-error-detection.js';
import type { AgentType, PairedRoomRole } from './types.js';
import {
  activateFailover,
  isGlobalFailoverActive,
  getGlobalFailoverLevel,
} from './service-routing.js';
import { FailoverLevel } from './config.js';

const CODEX_HANDOFF_REASONS = new Set<AgentTriggerReason>([
  '429',
  'usage-exhausted',
  'auth-expired',
  'org-access-denied',
  'session-failure',
]);

export interface FallbackHandoffRecord {
  source_role: PairedRoomRole;
  target_role: PairedRoomRole;
  source_agent_type: AgentType;
  target_agent_type: AgentType;
  prompt: string;
  start_seq: number | null;
  end_seq: number | null;
  reason: string;
  intended_role: PairedRoomRole;
}

export interface FallbackHandoffPlan {
  handoff: FallbackHandoffRecord;
  activateOwnerFailoverReason?: string;
  targetLevel?: FailoverLevel;
  logMessage: string;
}

export type FallbackResolution =
  | { type: 'none' }
  | { type: 'skip'; logMessage: string }
  | { type: 'handoff'; plan: FallbackHandoffPlan };

export function resolveFallbackHandoff(args: {
  activeRole: PairedRoomRole;
  effectiveAgentType: AgentType;
  hasReviewer: boolean;
  fallbackEnabled: boolean;
  reason: AgentTriggerReason;
  sawVisibleOutput: boolean;
  prompt: string;
  startSeq?: number | null;
  endSeq?: number | null;
}): FallbackResolution {
  if (args.sawVisibleOutput || !CODEX_HANDOFF_REASONS.has(args.reason)) {
    return { type: 'none' };
  }

  if (!args.hasReviewer) {
    return { type: 'none' };
  }

  if (!args.fallbackEnabled) {
    return {
      type: 'skip',
      logMessage: 'Fallback disabled for role, skipping handoff',
    };
  }

  // Tiered Fallback Logic: NONE -> GEMMA -> CODEX -> OLLAMA
  const currentLevel = isGlobalFailoverActive()
    ? getGlobalFailoverLevel()
    : FailoverLevel.NONE;

  let targetAgentType: AgentType;
  let targetLevel: FailoverLevel;
  let logMessage: string;
  let reasonPrefix: string;

  if (currentLevel === FailoverLevel.NONE) {
    targetAgentType = 'claude-code';
    targetLevel = FailoverLevel.GEMMA;
    logMessage = `Claude unavailable (${args.reason}), falling back to Gemma high-limit model`;
    reasonPrefix = 'gemma-claude';
  } else if (currentLevel === FailoverLevel.GEMMA) {
    targetAgentType = 'codex';
    targetLevel = FailoverLevel.CODEX;
    logMessage = `Gemma high-limit model also unavailable (${args.reason}), falling back to Codex`;
    reasonPrefix = 'codex-gemma';
  } else if (currentLevel === FailoverLevel.CODEX) {
    targetAgentType = 'ollama';
    targetLevel = FailoverLevel.OLLAMA;
    logMessage = `Codex also unavailable (${args.reason}), falling back to local Ollama qwen2.5-coder:7b`;
    reasonPrefix = 'ollama-codex';
  } else {
    // Already on Ollama — final tier, no further fallback
    return { type: 'none' };
  }

  const baseHandoff = {
    source_role: args.activeRole,
    source_agent_type: args.effectiveAgentType,
    target_agent_type: targetAgentType,
    prompt: args.prompt,
    start_seq: args.startSeq ?? null,
    end_seq: args.endSeq ?? null,
  };

  if (args.activeRole === 'arbiter') {
    return {
      type: 'handoff',
      plan: {
        handoff: {
          ...baseHandoff,
          target_role: 'arbiter',
          intended_role: 'arbiter',
          reason: `${reasonPrefix}-arbiter-${args.reason}`,
        },
        targetLevel: targetLevel,
        logMessage: `Claude arbiter unavailable, handed off arbiter turn to ${targetAgentType}`,
      },
    };
  }

  if (args.activeRole === 'reviewer') {
    return {
      type: 'handoff',
      plan: {
        handoff: {
          ...baseHandoff,
          target_role: 'reviewer',
          intended_role: 'reviewer',
          reason: `${reasonPrefix}-reviewer-${args.reason}`,
        },
        targetLevel: targetLevel,
        logMessage: `Claude reviewer unavailable, handed off review turn to ${targetAgentType}-review`,
      },
    };
  }

  return {
    type: 'handoff',
    plan: {
      handoff: {
        ...baseHandoff,
        target_role: args.activeRole,
        intended_role: args.activeRole,
        reason: `${reasonPrefix}-${args.reason}`,
      },
      activateOwnerFailoverReason: `${reasonPrefix}-${args.reason}`,
      targetLevel: targetLevel,
      logMessage: `Claude unavailable, handed off current owner turn to ${targetAgentType} fallback`,
    },
  };
}
