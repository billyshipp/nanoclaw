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
  value?: string;
  children?: MdNode[];
}

/**
 * Replace links whose URL contains `_` with plain text. The adapter's GFM
 * parser autolinks bare emails and URLs and renders them as `[text](url)`;
 * with an `_` in the URL (first_last@example.com, ?agent_name=x) Telegram
 * rejects the whole message ("Can't find end of Italic entity" / "Can't find
 * end of a URL") and delivery is dropped after retries. As plain text the
 * URL is escaped normally and Telegram clients still linkify it. A labelled
 * link keeps its label and shows the URL after it, unless the URL is a
 * mailto: (the label already names the recipient).
 */
export function unwrapUnderscoreLinks<T extends MdNode>(node: T): T {
  if (!node.children) return node;
  const children = node.children.flatMap((child): MdNode[] => {
    if (child.type !== 'link' || !child.url?.includes('_')) return [unwrapUnderscoreLinks(child)];
    const label = (child.children ?? []).map(unwrapUnderscoreLinks);
    const autolink = label.length === 1 && label[0].type === 'text' && label[0].value === child.url;
    return autolink || child.url.startsWith('mailto:') ? label : [...label, { type: 'text', value: ` (${child.url})` }];
  });
  return { ...node, children };
}

// Route every adapter's MarkdownV2 renderer through unwrapUnderscoreLinks.
const proto = TelegramFormatConverter.prototype as unknown as { fromAst(ast: MdNode): string };
const fromAst = proto.fromAst;
proto.fromAst = function (this: unknown, ast: MdNode): string {
  return fromAst.call(this, unwrapUnderscoreLinks(ast));
};
