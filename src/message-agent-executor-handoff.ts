import { getRoleModelConfig } from './config.js';
import { createServiceHandoff } from './db.js';
import type { AgentTriggerReason } from './agent-error-detection.js';
import { resolveFallbackHandoff } from './paired-turn-fallback.js';
import { activateFailover } from './service-routing.js';
import type { PairedTurnIdentity } from './paired-turn-identity.js';
import type { AgentType, PairedRoomRole, RegisteredGroup } from './types.js';

interface MessageAgentExecutorHandoffArgs {
  activeRole: PairedRoomRole;
  effectiveAgentType: AgentType;
  hasReviewer: boolean;
  reason: AgentTriggerReason;
  sawVisibleOutput: boolean;
  prompt: string;
  startSeq?: number | null;
  endSeq?: number | null;
  chatJid: string;
  group: RegisteredGroup;
  pairedTurnIdentity?: PairedTurnIdentity;
  markDelegated: () => void;
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
}

export function handoffMessageAgentExecutionToCodex(
  args: MessageAgentExecutorHandoffArgs,
): boolean {
  const handoffResolution = resolveFallbackHandoff({
    activeRole: args.activeRole,
    effectiveAgentType: args.effectiveAgentType,
    hasReviewer: args.hasReviewer,
    fallbackEnabled: getRoleModelConfig(args.activeRole).fallbackEnabled,
    reason: args.reason,
    sawVisibleOutput: args.sawVisibleOutput,
    prompt: args.prompt,
    startSeq: args.startSeq,
    endSeq: args.endSeq,
  });

  if (handoffResolution.type === 'none') {
    return false;
  }

  if (handoffResolution.type === 'skip') {
    args.log.info({ reason: args.reason }, handoffResolution.logMessage);
    return false;
  }

  if (handoffResolution.plan.targetLevel && handoffResolution.plan.activateOwnerFailoverReason) {
    activateFailover(
      args.chatJid,
      handoffResolution.plan.targetLevel,
      handoffResolution.plan.activateOwnerFailoverReason,
    );
  }
  createServiceHandoff({
    chat_jid: args.chatJid,
    group_folder: args.group.folder,
    paired_task_id: args.pairedTurnIdentity?.taskId,
    paired_task_updated_at: args.pairedTurnIdentity?.taskUpdatedAt,
    turn_id: args.pairedTurnIdentity?.turnId,
    turn_intent_kind: args.pairedTurnIdentity?.intentKind,
    turn_role: args.pairedTurnIdentity?.role,
    ...handoffResolution.plan.handoff,
  });
  args.markDelegated();
  args.log.warn({ reason: args.reason }, handoffResolution.plan.logMessage);
  return true;
}
