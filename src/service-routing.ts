import {
  ARBITER_AGENT_TYPE,
  ARBITER_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  GEMMA_SERVICE_ID,
  OLLAMA_FAILOVER_SERVICE_ID,
  OWNER_AGENT_TYPE,
  REVIEWER_AGENT_TYPE,
  SERVICE_ID,
  FailoverLevel,
  isArbiterEnabled,
  normalizeServiceId,
} from './config.js';
import {
  clearChannelOwnerLease,
  getAllChannelOwnerLeases,
  getEffectiveRuntimeRoomMode,
  getStoredRoomRoleAgentPlan,
  getStoredRoomSettings,
  type ChannelOwnerLeaseRow,
} from './db.js';
import { logger } from './logger.js';
import {
  inferAgentTypeFromServiceShadow,
  resolveRoleServiceShadow,
} from './role-service-shadow.js';
import { resolveRoleAgentPlan } from './role-agent-plan.js';
import type { AgentType, PairedRoomRole } from './types.js';

export interface EffectiveChannelLease {
  chat_jid: string;
  owner_agent_type?: AgentType;
  reviewer_agent_type?: AgentType | null;
  arbiter_agent_type?: AgentType | null;
  owner_service_id: string;
  reviewer_service_id: string | null;
  arbiter_service_id: string | null;
  owner_failover_active?: boolean;
  activated_at: string | null;
  reason: string | null;
  explicit: boolean;
}

const LEASE_CACHE_REFRESH_MS = 2_000;

let lastLeaseRefreshAt = 0;
const leaseCache = new Map<string, ChannelOwnerLeaseRow>();

function normalizeLeaseRow(
  row: ChannelOwnerLeaseRow,
  explicit: boolean,
): EffectiveChannelLease {
  const storedRolePlan = getStoredRoomRoleAgentPlan(row.chat_jid);
  const ownerAgentType =
    row.owner_agent_type ??
    storedRolePlan?.ownerAgentType ??
    getStoredRoomSettings(row.chat_jid)?.ownerAgentType ??
    inferAgentTypeFromServiceShadow(row.owner_service_id) ??
    'claude-code';
  const reviewerAgentType =
    row.reviewer_service_id == null
      ? null
      : (row.reviewer_agent_type ??
        inferAgentTypeFromServiceShadow(row.reviewer_service_id) ??
        storedRolePlan?.reviewerAgentType ??
        resolveRoleAgentPlan({
          paired: true,
          groupAgentType: ownerAgentType,
          configuredReviewer: REVIEWER_AGENT_TYPE,
          configuredArbiter: ARBITER_AGENT_TYPE,
        }).reviewerAgentType);
  const arbiterAgentType =
    row.arbiter_agent_type ??
    (row.arbiter_service_id
      ? inferAgentTypeFromServiceShadow(row.arbiter_service_id)
      : undefined) ??
    storedRolePlan?.arbiterAgentType ??
    null;

  return {
    chat_jid: row.chat_jid,
    owner_agent_type: ownerAgentType,
    reviewer_agent_type: reviewerAgentType,
    arbiter_agent_type: arbiterAgentType,
    owner_service_id:
      (row.owner_service_id
        ? normalizeServiceId(row.owner_service_id)
        : null) ??
      resolveRoleServiceShadow('owner', ownerAgentType) ??
      normalizeServiceId(SERVICE_ID),
    reviewer_service_id:
      (row.reviewer_service_id
        ? normalizeServiceId(row.reviewer_service_id)
        : null) ??
      (reviewerAgentType
        ? resolveRoleServiceShadow('reviewer', reviewerAgentType)
        : null),
    arbiter_service_id:
      (row.arbiter_service_id
        ? normalizeServiceId(row.arbiter_service_id)
        : null) ??
      (arbiterAgentType
        ? resolveRoleServiceShadow('arbiter', arbiterAgentType)
        : null) ??
      (isArbiterEnabled() ? ARBITER_SERVICE_ID : null),
    owner_failover_active: false,
    activated_at: row.activated_at,
    reason: row.reason,
    explicit,
  };
}

function getDefaultLease(chatJid: string): EffectiveChannelLease {
  const roomMode = getEffectiveRuntimeRoomMode(chatJid);
  const storedRolePlan = getStoredRoomRoleAgentPlan(chatJid);
  const ownerAgentType =
    storedRolePlan?.ownerAgentType ??
    getStoredRoomSettings(chatJid)?.ownerAgentType ??
    OWNER_AGENT_TYPE;
  const rolePlan =
    storedRolePlan ??
    resolveRoleAgentPlan({
      paired: roomMode === 'tribunal',
      groupAgentType: ownerAgentType,
      configuredReviewer: REVIEWER_AGENT_TYPE,
      configuredArbiter: ARBITER_AGENT_TYPE,
    });

  return {
    chat_jid: chatJid,
    owner_agent_type: rolePlan.ownerAgentType,
    reviewer_agent_type: rolePlan.reviewerAgentType,
    arbiter_agent_type: rolePlan.arbiterAgentType,
    owner_service_id:
      resolveRoleServiceShadow('owner', rolePlan.ownerAgentType) ??
      normalizeServiceId(SERVICE_ID),
    reviewer_service_id: resolveRoleServiceShadow(
      'reviewer',
      rolePlan.reviewerAgentType,
    ),
    arbiter_service_id: resolveRoleServiceShadow(
      'arbiter',
      rolePlan.arbiterAgentType,
    ),
    owner_failover_active: false,
    activated_at: null,
    reason: null,
    explicit: false,
  };
}

function getStoredOrDefaultLease(chatJid: string): EffectiveChannelLease {
  refreshChannelOwnerCache();
  const row = leaseCache.get(chatJid);
  if (row) {
    return normalizeLeaseRow(row, true);
  }
  return getDefaultLease(chatJid);
}

export function refreshChannelOwnerCache(force = false): void {
  const now = Date.now();
  if (!force && now - lastLeaseRefreshAt < LEASE_CACHE_REFRESH_MS) {
    return;
  }

  leaseCache.clear();
  for (const row of getAllChannelOwnerLeases()) {
    leaseCache.set(row.chat_jid, row);
  }
  lastLeaseRefreshAt = now;
}

export function getEffectiveChannelLease(
  chatJid: string,
): EffectiveChannelLease {
  // Global failover overrides the owner execution backend for all channels,
  // while preserving the room's reviewer/arbiter role assignments.
  if (globalFailoverLevel !== FailoverLevel.NONE) {
    const baseLease = getStoredOrDefaultLease(chatJid);
    const ownerServiceId =
      globalFailoverLevel === FailoverLevel.GEMMA
        ? GEMMA_SERVICE_ID
        : globalFailoverLevel === FailoverLevel.OLLAMA
          ? OLLAMA_FAILOVER_SERVICE_ID
          : CODEX_REVIEW_SERVICE_ID;

    return {
      ...baseLease,
      owner_service_id: ownerServiceId,
      owner_failover_active: true,
      activated_at: globalFailoverActivatedAt,
      reason: globalFailoverReason,
      explicit: true,
    };
  }
  return getStoredOrDefaultLease(chatJid);
}

export function resolveLeaseServiceId(
  lease: Pick<
    EffectiveChannelLease,
    | 'owner_agent_type'
    | 'reviewer_agent_type'
    | 'arbiter_agent_type'
    | 'owner_service_id'
    | 'reviewer_service_id'
    | 'arbiter_service_id'
    | 'owner_failover_active'
  >,
  role: PairedRoomRole,
): string | null {
  switch (role) {
    case 'owner':
      return (
        (lease.owner_service_id
          ? normalizeServiceId(lease.owner_service_id)
          : null) ??
        resolveRoleServiceShadow('owner', lease.owner_agent_type) ??
        null
      );
    case 'reviewer':
      return (
        (lease.reviewer_service_id
          ? normalizeServiceId(lease.reviewer_service_id)
          : null) ??
        (lease.reviewer_agent_type
          ? resolveRoleServiceShadow('reviewer', lease.reviewer_agent_type)
          : null)
      );
    case 'arbiter':
      return (
        (lease.arbiter_service_id
          ? normalizeServiceId(lease.arbiter_service_id)
          : null) ??
        (lease.arbiter_agent_type
          ? resolveRoleServiceShadow('arbiter', lease.arbiter_agent_type)
          : null)
      );
  }
}

export function isOwnerServiceForChat(
  chatJid: string,
  serviceId: string = SERVICE_ID,
): boolean {
  const lease = getEffectiveChannelLease(chatJid);
  return (
    normalizeServiceId(serviceId) === resolveLeaseServiceId(lease, 'owner')
  );
}

export function isReviewerServiceForChat(
  chatJid: string,
  serviceId: string = SERVICE_ID,
): boolean {
  const lease = getEffectiveChannelLease(chatJid);
  return (
    normalizeServiceId(serviceId) === resolveLeaseServiceId(lease, 'reviewer')
  );
}

export function hasReviewerLease(chatJid: string): boolean {
  return (
    resolveLeaseServiceId(getEffectiveChannelLease(chatJid), 'reviewer') !==
    null
  );
}

export function isArbiterServiceForChat(
  chatJid: string,
  serviceId: string = SERVICE_ID,
): boolean {
  const lease = getEffectiveChannelLease(chatJid);
  return (
    normalizeServiceId(serviceId) === resolveLeaseServiceId(lease, 'arbiter')
  );
}

export function shouldServiceProcessChat(
  _chatJid: string,
  _serviceId: string = SERVICE_ID,
): boolean {
  return true;
}

// ── Global failover ──────────────────────────────────────────────
// Claude API limits are account-level, so owner failover applies to all channels.

let globalFailoverLevel = FailoverLevel.NONE;
let globalFailoverReason: string | null = null;
let globalFailoverActivatedAt: string | null = null;

export type FailoverNotifier = (event: {
  chatJid: string;
  fromLevel: FailoverLevel;
  toLevel: FailoverLevel;
  reason: string;
  targetName: string;
}) => void;

let failoverNotifier: FailoverNotifier | null = null;

export function setFailoverNotifier(notifier: FailoverNotifier | null): void {
  failoverNotifier = notifier;
}

function describeFailoverTarget(level: FailoverLevel): string {
  switch (level) {
    case FailoverLevel.GEMMA:
      return 'Gemma';
    case FailoverLevel.CODEX:
      return 'Codex';
    case FailoverLevel.OLLAMA:
      return 'Ollama (qwen2.5-coder:7b)';
    default:
      return 'Claude';
  }
}

export function activateFailover(
  chatJid: string,
  level: FailoverLevel,
  reason: string,
): void {
  const fromLevel = globalFailoverLevel;
  globalFailoverLevel = level;
  globalFailoverReason = reason;
  globalFailoverActivatedAt = new Date().toISOString();
  const targetName = describeFailoverTarget(level);
  logger.warn(
    { reason, activatedAt: globalFailoverActivatedAt, level },
    `Global failover activated (Level: ${FailoverLevel[level]}) — owner execution switching to ${targetName} across all channels`,
  );
  if (failoverNotifier) {
    try {
      failoverNotifier({
        chatJid,
        fromLevel,
        toLevel: level,
        reason,
        targetName,
      });
    } catch (err) {
      logger.warn({ err }, 'Failover notifier threw; ignoring');
    }
  }
}

export function isGlobalFailoverActive(): boolean {
  return globalFailoverLevel !== FailoverLevel.NONE;
}

export function getGlobalFailoverLevel(): FailoverLevel {
  return globalFailoverLevel;
}

export function getGlobalFailoverInfo(): {
  active: boolean;
  reason: string | null;
  activatedAt: string | null;
} {
  return {
    active: globalFailoverLevel !== FailoverLevel.NONE,
    reason: globalFailoverReason,
    activatedAt: globalFailoverActivatedAt,
  };
}

export function clearGlobalFailover(): void {
  if (globalFailoverLevel === FailoverLevel.NONE) return;
  globalFailoverLevel = FailoverLevel.NONE;
  globalFailoverReason = null;
  globalFailoverActivatedAt = null;
  logger.info('Global failover cleared — resuming normal owner routing');
}

export function restoreDefaultChannelLease(chatJid: string): void {
  clearChannelOwnerLease(chatJid);
  leaseCache.delete(chatJid);
  lastLeaseRefreshAt = Date.now();
}

export interface ActiveFailoverLease {
  chatJid: string;
  activatedAt: string | null;
}

export function getActiveCodexFailoverLeases(): ActiveFailoverLease[] {
  // Global failover: report as a single pseudo-lease
  if (globalFailoverLevel !== FailoverLevel.NONE) {
    return [{ chatJid: '*', activatedAt: globalFailoverActivatedAt }];
  }
  return [];
}

/** @deprecated Use getActiveCodexFailoverLeases() instead */
export function getActiveCodexFailoverChatJids(): string[] {
  return getActiveCodexFailoverLeases().map((l) => l.chatJid);
}
