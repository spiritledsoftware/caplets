import { Type } from "@sinclair/typebox";
import { operations } from "@caplets/core/generated-tool-input-schema";

export function capletsPiParameters() {
  return Type.Object(
    {
      operation: Type.Union(operations.map((operation) => Type.Literal(operation))),
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
      tool: Type.Optional(Type.String()),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      fields: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    },
    { additionalProperties: false },
  );
}
