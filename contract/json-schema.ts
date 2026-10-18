/** JSON Schema выжимки для флагов `--json-schema` агентов. */
import { toJsonSchema } from '@valibot/to-json-schema';
import { ExtractResult } from './v2.ts';

export function extractResultJsonSchema(): object {
  // trim — преобразование на нашей стороне, агенту о нём знать не нужно
  return toJsonSchema(ExtractResult, { ignoreActions: ['trim'] });
}

if (import.meta.main) {
  console.log(JSON.stringify(extractResultJsonSchema(), null, 2));
}
