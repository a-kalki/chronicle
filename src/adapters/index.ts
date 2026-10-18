/** Реестр адаптеров агентов по имени (session.agent в контракте). */
import type { AgentAdapter } from '../finish/adapter.ts';
import { AgyAdapter } from './agy.ts';
import { ClaudeCodeAdapter } from './claude-code.ts';
import { PiAdapter } from './pi.ts';

const ADAPTERS: Record<string, () => AgentAdapter> = {
  agy: () => new AgyAdapter(),
  'claude-code': () => new ClaudeCodeAdapter(),
  pi: () => new PiAdapter(),
};

export const AGENT_NAMES = Object.keys(ADAPTERS);

export function getAdapter(name: string): AgentAdapter | null {
  return ADAPTERS[name]?.() ?? null;
}
