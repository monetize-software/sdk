import type { LayoutBlock } from '../../../core/types';
import type { BlockProps } from '../types';

type FeaturesListBlock = Extract<LayoutBlock, { type: 'features_list' }>;

export function FeaturesList({ block }: BlockProps<FeaturesListBlock>) {
  if (!block.items.length) return null;
  return (
    <ul class="flex flex-col gap-2.5" role="list">
      {block.items.map((item) => (
        <li key={item.id} class="flex items-start gap-3 text-sm text-gray-700">
          <span
            class="mt-px flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full"
            style={{
              background:
                'color-mix(in srgb, var(--pw-accent) 12%, white)',
              color: 'var(--pw-accent)'
            }}
            aria-hidden="true"
          >
            <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
              <path
                d="M5 10l3 3 7-7"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          <div class="flex flex-col gap-0.5">
            <span class="font-medium leading-snug text-gray-900">{item.name}</span>
            {item.desc ? (
              <span class="text-xs leading-relaxed text-gray-500">{item.desc}</span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
