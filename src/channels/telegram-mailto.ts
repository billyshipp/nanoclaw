/**
 * Local Telegram rendering fix, kept outside telegram.ts so the /add-telegram
 * registry refresh (which overwrites telegram.ts) cannot drop it. Imported for
 * side effects from src/index.ts — not from the channels barrel, where the
 * updater would read it as a separate channel skill.
 */
import { TelegramFormatConverter } from '@chat-adapter/telegram';

interface MdNode {
  type: string;
  url?: string;
  children?: MdNode[];
}

/**
 * Replace `mailto:` links whose address contains `_` with their text. The
 * adapter's GFM parser autolinks bare emails and renders them as
 * `[text](mailto:addr)`; with an `_` in addr (olivia_claw@agentmail.to)
 * Telegram rejects the whole message ("Can't find end of Italic entity" /
 * "Can't find end of a URL") and delivery is dropped after retries. As plain
 * text the address is escaped normally and Telegram clients still linkify it.
 */
export function unwrapUnsafeMailtoLinks<T extends MdNode>(node: T): T {
  if (!node.children) return node;
  const children = node.children.flatMap((child): MdNode[] =>
    child.type === 'link' && child.url?.startsWith('mailto:') && child.url.includes('_')
      ? (child.children ?? []).map(unwrapUnsafeMailtoLinks)
      : [unwrapUnsafeMailtoLinks(child)],
  );
  return { ...node, children };
}

// Route every adapter's MarkdownV2 renderer through unwrapUnsafeMailtoLinks.
const proto = TelegramFormatConverter.prototype as unknown as { fromAst(ast: MdNode): string };
const fromAst = proto.fromAst;
proto.fromAst = function (this: unknown, ast: MdNode): string {
  return fromAst.call(this, unwrapUnsafeMailtoLinks(ast));
};
