import { useEffect, useRef } from 'preact/hooks';
import type { LayoutBlock } from '../../../core/types';
import type { BlockProps } from '../types';

type HeadingBlock = Extract<LayoutBlock, { type: 'heading' }>;

const BASE_FONT_PX = 24; // matches sm:text-2xl on h1
const MIN_FONT_PX = 16;
const MAX_LINES = 2;

// Auto-fit: if the heading does not fit within `MAX_LINES` lines at the base size,
// we shrink the font-size by 1px steps until it fits or we hit
// `MIN_FONT_PX`. Used only for h1 — h2/h3 are subheadings and don't need
// clipping. We measure by the element's real height (scrollHeight) after
// render — otherwise we'd have to keep a canvas-based measurer.
function fitHeading(el: HTMLElement, lineHeight: number): void {
  const maxHeight = lineHeight * MAX_LINES;
  let size = BASE_FONT_PX;
  el.style.fontSize = `${size}px`;
  while (el.scrollHeight > maxHeight && size > MIN_FONT_PX) {
    size -= 1;
    el.style.fontSize = `${size}px`;
  }
}

export function Heading({ block, ctx }: BlockProps<HeadingBlock>) {
  const level = block.level ?? 1;
  const Tag = (`h${level}` as 'h1' | 'h2' | 'h3');
  const className =
    level === 1
      ? 'text-[22px] sm:text-2xl font-semibold leading-tight text-center text-balance text-gray-800'
      : level === 2
        ? 'text-xl font-semibold leading-snug text-gray-900 tracking-tight'
        : 'text-base font-medium text-gray-900';

  const ref = useRef<HTMLHeadingElement | null>(null);
  const autoFit = level === 1 && !!ctx.bootstrap.settings.title_auto_fit;

  useEffect(() => {
    if (!autoFit || !ref.current) return;
    // line-height on text-2xl = 1.5 (Tailwind default). We compute from the current
    // computed line-height — robust to future CSS changes.
    const cs = getComputedStyle(ref.current);
    const lh = parseFloat(cs.lineHeight) || BASE_FONT_PX * 1.5;
    fitHeading(ref.current, lh);
  }, [autoFit, block.text]);

  return (
    <Tag ref={ref} class={className}>
      {block.text}
    </Tag>
  );
}
