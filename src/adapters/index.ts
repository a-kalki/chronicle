/** Реестр адаптеров агентов по имени (session.agent в контракте). */
import type { AgentAdapter } from '../finish/adapter.ts';
import { ClaudeCodeAdapter } from './claude-code.ts';

const ADAPTERS: Record<string, () => AgentAdapter> = {
  'claude-code': () => new ClaudeCodeAdapter(),
};

export const AGENT_NAMES = Object.keys(ADAPTERS);

export function getAdapter(name: string): AgentAdapter | null {
  return ADAPTERS[name]?.() ?? null;
}
