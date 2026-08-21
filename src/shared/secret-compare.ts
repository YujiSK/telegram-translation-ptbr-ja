/**
 * Constant-time string comparison for Secret verification, shared by
 * every header-Secret check in this codebase (the Telegram webhook
 * Secret, the setup/admin bootstrap Secret) so the timing-safe behavior
 * lives in exactly one place instead of being re-implemented per caller.
 *
 * Uses the Workers-runtime `crypto.subtle.timingSafeEqual` extension
 * (non-standard, workerd-only), which requires both buffers to be the
 * same length and throws otherwise — a length mismatch is handled by
 * comparing a buffer against itself instead of returning immediately, so
 * that branch's cost stays similar to the equal-length path rather than
 * exiting early (though this does not itself claim to hide the length
 * difference).
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  if (aBytes.byteLength !== bBytes.byteLength) {
    crypto.subtle.timingSafeEqual(aBytes, aBytes);
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}
