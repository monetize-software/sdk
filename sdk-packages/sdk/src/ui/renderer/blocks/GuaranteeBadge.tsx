import type { LayoutBlock } from '../../../core/types';
import type { BlockProps } from '../types';

type GuaranteeBlock = Extract<LayoutBlock, { type: 'guarantee_badge' }>;

// Money-back guarantee под CtaButton. Bottom-border визуально стыкуется с
// current_session, который рендерится сразу следующим блоком — без явного
// gap'а получается «единый footer». Если current_session идёт не следом —
// border всё равно работает как самостоятельный divider.
export function GuaranteeBadge({ block }: BlockProps<GuaranteeBlock>) {
  const title = block.title ?? '100% Money-Back Guarantee';
  const subtitle =
    block.subtitle ?? "Not satisfied? We'll refund you — no questions asked.";
  const showIcon = (block.icon ?? 'dollar_shield') !== 'none';

  return (
    <div class="-mt-1 flex flex-col items-center gap-1 border-b border-gray-200 pb-4 text-center">
      <div class="flex items-center justify-center gap-1.5">
        {showIcon ? <DollarShieldIcon /> : null}
        <b class="text-[14px] font-semibold text-gray-700">{title}</b>
      </div>
      {subtitle ? (
        <span class="text-[12px] leading-relaxed text-gray-500">{subtitle}</span>
      ) : null}
    </div>
  );
}

function DollarShieldIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      fill="currentColor"
      width="18"
      height="18"
      class="text-emerald-500"
      aria-hidden="true"
    >
      <path d="M257.5 .1l3.1 .4 192 42.7c4.3 1 8.2 3.2 11.2 6.5s4.8 7.4 5.3 11.8l.2 2.5 0 234.7C469.3 416.5 373.8 512 256 512C140.1 512 45.9 419.7 42.7 304.6l-.1-6L42.7 64c0-4.4 1.4-8.8 3.9-12.4s6.2-6.3 10.4-7.8l2.4-.7L251.4 .5c2-.4 4.1-.6 6.2-.4zM256 85.3c-12.8 0-21.3 8.5-21.3 21.3l0 23.5c-36.3 4.3-64 34.1-64 72.5c0 44.8 34.1 61.9 64 70.4l0 66.1c-11.9-4-20.1-15.3-21.2-27.1l-.1-2.7c0-12.8-8.5-21.3-21.3-21.3s-21.3 8.5-21.3 21.3c0 38.4 27.7 68.3 64 72.5l0 23.5c0 12.8 8.5 21.3 21.3 21.3s21.3-8.5 21.3-21.3l0-23.5c36.3-4.3 64-36.3 64-72.5c0-44.8-34.1-61.9-64-70.4l0-66.1c11.9 4 20.1 15.3 21.2 27.1l.1 2.7c0 12.8 8.5 21.3 21.3 21.3s21.3-8.5 21.3-21.3c0-38.4-27.7-68.3-64-72.5l0-23.5c0-12.8-8.5-21.3-21.3-21.3zm21.3 198.4c14.9 6.4 21.3 12.8 21.3 25.6c0 14.9-8.5 25.6-21.3 29.9l0-55.5zM234.7 172.8l0 55.5c-14.9-6.4-21.3-12.8-21.3-25.6c0-14.9 8.5-25.6 21.3-29.9z" />
    </svg>
  );
}
