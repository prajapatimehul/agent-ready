/**
 * Shared sanitize code template emitted into both CLI and MCP generated files.
 */
export const SANITIZE_TEMPLATE = `
const SANITIZE_RE = /ignore previous instructions|ignore all previous|disregard previous|system prompt|you are now|override instructions|new instructions|forget your rules|<system>|<\\/system>|\\[INST\\]|\\[\\/INST\\]|<<SYS>>|<<\\/SYS>>/gi;

function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str.replace(SANITIZE_RE, '[SANITIZED]');
}

function sanitizeResponse(data) {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') return sanitizeString(data);
  if (Array.isArray(data)) return data.map(sanitizeResponse);
  if (typeof data === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = sanitizeResponse(value);
    }
    return result;
  }
  return data;
}
`;
