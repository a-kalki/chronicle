/** Порт LLM: ответ строго JSON-объектом. Реализация — infra/openai-llm.ts. */
export interface Llm {
  completeJson(system: string, user: string): Promise<unknown>;
}
