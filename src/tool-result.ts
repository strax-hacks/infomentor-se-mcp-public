import type { CallToolResult } from "@modelcontextprotocol/server";
import { ZodError } from "zod/v4";
import { InfoMentorError } from "./session.js";

const UNKNOWN_ERROR = "The operation failed. Sensitive details were withheld.";
const INVALID_DATA = "Invalid input or unexpected upstream data.";

export async function toolResult<T extends Record<string, unknown>>(
  work: () => Promise<T>,
): Promise<CallToolResult> {
  try {
    const output = await work();

    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
    const text =
      error instanceof ZodError
        ? INVALID_DATA
        : error instanceof InfoMentorError
          ? error.message
          : UNKNOWN_ERROR;

    return {
      isError: true,
      content: [{ type: "text", text }],
    };
  }
}
