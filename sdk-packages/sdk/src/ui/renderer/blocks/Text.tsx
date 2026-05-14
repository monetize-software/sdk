import type { LayoutBlock } from '../../../core/types';
import type { BlockProps } from '../types';

type TextBlock = Extract<LayoutBlock, { type: 'text' }>;

export function Text({ block }: BlockProps<TextBlock>) {
  return <p class="text-[0.9375rem] leading-relaxed text-gray-600">{block.text}</p>;
}
