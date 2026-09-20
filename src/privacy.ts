/** Bounded, best-effort sanitation for supported credential formats. */
export const MAX_RAW_LOG_BYTES = 64 * 1024;
export const DISCARDED_LOG_RECORD = "[Oversized log record discarded]";

export function isSecretField(key: string): boolean {
  return /^(?:token|accesstoken|refreshtoken|minecraftaccesstoken|publishsecret|secret|password|codeverifier|code|authorization|auth|cookie|setcookie|key|apikey|clientsecret|signature|xamzcredential|xamzsignature|xamzsecuritytoken)$/i.test(
    key.replace(/[-_]/g, ""),
  );
}

export function sanitizeLogText(text: string): string {
  if (!text) return "";
  if (Buffer.byteLength(text, "utf8") > MAX_RAW_LOG_BYTES)
    return DISCARDED_LOG_RECORD;
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
      try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        if (url.search) url.search = "?redacted";
        if (url.hash) url.hash = "";
        return url.toString();
      } catch {
        return "[Invalid URL]";
      }
    })
    .replace(
      /\b(?:set-cookie|cookie|authorization|x-api-key|x-auth-token)\s*:\s*[^\r\n]+/gi,
      (value) => `${value.split(":")[0]}: [REDACTED]`,
    )
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(
      /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]+/g,
      "[JWT_REDACTED]",
    )
    .replace(
      /"([^"\\]+)"\s*:\s*"(?:\\.|[^"\\])*(?:"|$)/g,
      (match, key: string) =>
        isSecretField(key) ? `"${key}": "[REDACTED]"` : match,
    )
    .replace(
      /(--(?:access[-_]?token|refresh[-_]?token|minecraft[-_]?access[-_]?token|auth[-_]?token|api[-_]?key|x[-_]?api[-_]?key|password|secret|token|code[-_]?verifier))(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1 [REDACTED]",
    )
    .replace(
      /\b(access_token|refresh_token|code_verifier|code|authorization|auth|api[-_]?key|x[-_]?api[-_]?key|password|secret|token)=([^&\s]+)/gi,
      "$1=[REDACTED]",
    );
}
