// zod-procedure.ts

import { z, type ZodTypeAny } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import type { Result, ParsedProcedure } from "./types";

function getInnerType(
  zodType: ZodTypeAny,
  seen = new WeakSet<ZodTypeAny>()
): ZodTypeAny {
  if (seen.has(zodType)) {
    return zodType;
  }
  seen.add(zodType);

  if (zodType instanceof z.ZodOptional || zodType instanceof z.ZodNullable) {
    return getInnerType(zodType.unwrap(), seen);
  }
  if (zodType instanceof z.ZodEffects) {
    return getInnerType(zodType._def.schema, seen);
  }
  return zodType;
}

export function parseProcedureInputs(
  inputs: unknown[],
  seen = new WeakSet<ZodTypeAny>(),
  definitions: Record<string, unknown> = {}
): Result<ParsedProcedure> {
  if (inputs.length === 0) {
    return {
      success: true,
      value: { parameters: [], flagsSchema: {}, getInput: () => ({}) },
    };
  }

  if (!inputs.every((input) => input instanceof z.ZodType)) {
    const inputTypes = inputs
      .map((input) => (input as {}).constructor.name)
      .join(", ");
    return {
      success: false,
      error: `Invalid input type ${inputTypes}, only zod inputs are supported`,
    };
  }

  // Check for recursion
  for (const input of inputs) {
    if (seen.has(input as ZodTypeAny)) {
      return {
        success: true,
        value: { parameters: [], flagsSchema: {}, getInput: () => ({}) },
      };
    }
    seen.add(input as ZodTypeAny);
  }

  if (inputs.length > 1) {
    return parseMultiInputs(inputs as ZodTypeAny[], seen, definitions);
  }

  const mergedSchema = inputs[0] as ZodTypeAny;

  if (acceptedLiteralTypes(mergedSchema).length > 0) {
    return parseLiteralInput(mergedSchema);
  }

  if (mergedSchema instanceof z.ZodTuple) {
    return parseTupleInput(mergedSchema, seen, definitions);
  }

  if (
    mergedSchema instanceof z.ZodArray &&
    acceptedLiteralTypes(mergedSchema.element).length > 0
  ) {
    return parseArrayInput(mergedSchema);
  }

  if (!acceptsObject(mergedSchema)) {
    return {
      success: false,
      error: `Invalid input type ${
        getInnerType(mergedSchema, seen).constructor.name
      }, expected object or tuple`,
    };
  }

  // Convert the Zod schema to JSON Schema with proper options
  const jsonSchema = zodToJsonSchema(mergedSchema, {
    refStrategy: "id",
    definitionPath: ["definitions"],
    definitions,
    name: "InputSchema",
  });

  return {
    success: true,
    value: {
      parameters: [],
      flagsSchema: {
        ...jsonSchema,
        definitions,
      },
      getInput: (argv) => argv.flags,
    },
  };
}

function parseLiteralInput(schema: ZodTypeAny): Result<ParsedProcedure> {
  const type = acceptedLiteralTypes(schema)[0];
  const name = schema.description || type || "value";
  return {
    success: true,
    value: {
      parameters: [schema.isOptional() ? `[${name}]` : `<${name}>`],
      flagsSchema: {},
      getInput: (argv) => convertPositional(schema, argv._[0]),
    },
  };
}

function acceptedLiteralTypes(
  schema: ZodTypeAny
): Array<"string" | "number" | "boolean"> {
  const types: Array<"string" | "number" | "boolean"> = [];
  if (acceptsBoolean(schema)) types.push("boolean");
  if (acceptsNumber(schema)) types.push("number");
  if (acceptsString(schema)) types.push("string");
  return types;
}

function parseMultiInputs(
  inputs: ZodTypeAny[],
  seen: WeakSet<ZodTypeAny>,
  definitions: Record<string, unknown>
): Result<ParsedProcedure> {
  if (!inputs.every(acceptsObject)) {
    const types = inputs
      .map((s) => getInnerType(s, seen).constructor.name)
      .join(", ");
    return {
      success: false,
      error: `Invalid multi-input type ${types}. All inputs must accept object inputs.`,
    };
  }

  const parsedInputs = inputs.map((input) =>
    parseProcedureInputs([input], seen, definitions)
  );
  const errors = parsedInputs
    .filter((result) => !result.success)
    .map((result) => (result as Result.Failure).error);

  if (errors.length > 0) {
    return { success: false, error: errors.join("\n") };
  }

  return {
    success: true,
    value: {
      parameters: [],
      flagsSchema: {
        allOf: parsedInputs.map((p) => {
          const successful = p as Result.Success<ParsedProcedure>;
          return successful.value.flagsSchema;
        }),
        definitions,
      },
      getInput: (argv) => argv.flags,
    },
  };
}

function parseArrayInput(
  arraySchema: z.ZodArray<ZodTypeAny>
): Result<ParsedProcedure> {
  if (arraySchema.element instanceof z.ZodNullable) {
    return {
      success: false,
      error: `Invalid input type ${arraySchema.element.constructor.name}<${
        getInnerType(arraySchema.element).constructor.name
      }>[]. Nullable arrays are not supported.`,
    };
  }
  return {
    success: true,
    value: {
      parameters: [],
      flagsSchema: {},
      getInput: (argv) =>
        argv._.map((s) => convertPositional(arraySchema.element, s)),
    },
  };
}

function parseTupleInput(
  tupleSchema: z.ZodTuple,
  seen: WeakSet<ZodTypeAny>,
  definitions: Record<string, unknown>
): Result<ParsedProcedure> {
  const types = `[${tupleSchema.items
    .map((s) => getInnerType(s, seen).constructor.name)
    .join(", ")}]`;

  const nonPositionalIndex = tupleSchema.items.findIndex((item) => {
    if (acceptedLiteralTypes(item).length > 0) {
      return false;
    }
    if (
      item instanceof z.ZodArray &&
      acceptedLiteralTypes(item.element).length > 0
    ) {
      return false;
    }
    return true;
  });

  if (
    nonPositionalIndex > -1 &&
    nonPositionalIndex !== tupleSchema.items.length - 1
  ) {
    return {
      success: false,
      error: `Invalid input type ${types}. Positional parameters must be strings, numbers or booleans.`,
    };
  }

  const positionalSchemas =
    nonPositionalIndex === -1
      ? tupleSchema.items
      : tupleSchema.items.slice(0, nonPositionalIndex);

  const parameterNames = positionalSchemas.map((item, i) =>
    parameterName(item, i + 1)
  );

  const positionalParametersToTupleInput = (argv: {
    _: string[];
    flags: Record<string, unknown>;
  }) => {
    if (
      positionalSchemas.length === 1 &&
      positionalSchemas[0] instanceof z.ZodArray
    ) {
      const element = positionalSchemas[0].element;
      return [argv._.map((s) => convertPositional(element, s))];
    }
    return positionalSchemas.map((schema, i) =>
      convertPositional(schema, argv._[i])
    );
  };

  if (positionalSchemas.length === tupleSchema.items.length) {
    return {
      success: true,
      value: {
        parameters: parameterNames,
        flagsSchema: {},
        getInput: positionalParametersToTupleInput,
      },
    };
  }

  const lastSchema = tupleSchema.items[tupleSchema.items.length - 1];

  if (!acceptsObject(lastSchema)) {
    return {
      success: false,
      error: `Invalid input type ${types}. The last type must accept object inputs.`,
    };
  }

  // Convert the last schema to JSON Schema with proper options
  const jsonSchema = zodToJsonSchema(lastSchema, {
    refStrategy: "id",
    definitionPath: ["definitions"],
    definitions,
    name: "InputSchema",
  });

  return {
    success: true,
    value: {
      parameters: parameterNames,
      flagsSchema: {
        ...jsonSchema,
        definitions,
      },
      getInput: (argv) => [
        ...positionalParametersToTupleInput(argv),
        argv.flags,
      ],
    },
  };
}

function convertPositional(schema: ZodTypeAny, value: string) {
  let parsedValue: string | number | boolean = value;

  const acceptedTypes = new Set(acceptedLiteralTypes(schema));

  if (acceptedTypes.has("boolean") && (value === "true" || value === "false")) {
    parsedValue = value === "true";
  } else if (acceptedTypes.has("number") && !isNaN(Number(value))) {
    parsedValue = Number(value);
  }

  if (!schema.safeParse(parsedValue).success && acceptedTypes.has("string")) {
    parsedValue = value;
  }

  return parsedValue;
}

function parameterName(schema: ZodTypeAny, position: number): string {
  if (schema instanceof z.ZodArray) {
    const elementName = parameterName(schema.element, position);
    return `[${elementName.slice(1, -1)}...]`;
  }
  const name =
    schema.description || `parameter ${position}`.replace(/\W+/g, " ").trim();
  return schema.isOptional() ? `[${name}]` : `<${name}>`;
}

/**
 * Curried function which tells you whether a given zod type accepts any inputs of a given target type.
 * Useful for static validation, and for deciding whether to preprocess a string input before passing it to a zod schema.
 */
export function accepts<ZodTarget extends ZodTypeAny>(target: ZodTarget) {
  const test = (
    zodType: ZodTypeAny,
    seen = new WeakSet<ZodTypeAny>()
  ): boolean => {
    if (seen.has(zodType)) {
      return false;
    }
    seen.add(zodType);

    const innerType = getInnerType(zodType, seen);

    if (innerType.constructor === target.constructor) return true;

    if (innerType instanceof z.ZodLiteral) {
      return target.safeParse(innerType.value).success;
    }

    if (innerType instanceof z.ZodEnum) {
      return innerType.options.some(
        (option) => target.safeParse(option).success
      );
    }

    if (innerType instanceof z.ZodUnion) {
      return innerType.options.some((option) => test(option, seen));
    }

    if (innerType instanceof z.ZodEffects) {
      return test(innerType._def.schema, seen);
    }

    if (innerType instanceof z.ZodIntersection) {
      return (
        test(innerType._def.left, seen) && test(innerType._def.right, seen)
      );
    }

    return false;
  };
  return test;
}

const acceptsString = accepts(z.string());
const acceptsNumber = accepts(z.number());
const acceptsBoolean = accepts(z.boolean());
const acceptsObject = accepts(z.object({}));
