import type { ReplyContext } from "./translation";
import type { SpeakerIdentity } from "./speaker";

/**
 * Internal representation of a Telegram Update the bot can act on.
 * Produced only by infrastructure/telegram/parse-update.ts — nothing in
 * `domain/` reads raw Telegram JSON directly (docs/project-rules.md
 * rules 1-2).
 */
export interface InternalTextMessage {
  readonly kind: "text-message";
  readonly updateId: number;
  readonly messageId: number;
  readonly chatId: number;
  readonly speaker: SpeakerIdentity;
  readonly text: string;
  readonly replyContext?: ReplyContext;
}

/**
 * A structurally valid Telegram Update that is not (yet, or ever) handled
 * by this bot — e.g. a non-text message, a channel post, a callback
 * query. Distinct from a parse failure: nothing is wrong with the
 * payload, it's just out of scope. See docs/implementation-plan.md
 * (MVPは text message のみ扱う).
 */
export type UnsupportedUpdateReason =
  | "non-text-message"
  | "empty-text"
  | "channel-post"
  | "callback-query"
  | "unrecognized-update-type";

export interface UnsupportedUpdate {
  readonly kind: "unsupported";
  readonly updateId: number;
  readonly reason: UnsupportedUpdateReason;
}

export type InternalUpdate = InternalTextMessage | UnsupportedUpdate;
