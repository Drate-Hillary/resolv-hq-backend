import { badRequest } from "./errors.js";

const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
export const MAX_MEMORY_VALUE_LENGTH = 2000;

export function validateKeyAndValue(key: unknown, value: unknown) {
  if (typeof key !== "string" || !KEY_PATTERN.test(key.trim())) {
    throw badRequest("key must start with a letter and contain only letters, digits, _, . or - (max 64 chars)");
  }
  if (typeof value !== "string" || !value.trim() || value.trim().length > MAX_MEMORY_VALUE_LENGTH) {
    throw badRequest(`value must contain 1 to ${MAX_MEMORY_VALUE_LENGTH} characters`);
  }
  return { key: key.trim(), value: value.trim() };
}
