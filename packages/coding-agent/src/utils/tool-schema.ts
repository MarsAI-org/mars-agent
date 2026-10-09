import { schemaDefinesProperty } from "@marsai-org/ai/utils/schema";
import { INTENT_FIELD } from "@marsai-org/wire";

/** Whether a wire schema owns `i` as a tool parameter rather than harness intent. */
export function schemaDeclaresIntentField(schema: unknown): boolean {
	return schemaDefinesProperty(schema, INTENT_FIELD);
}
