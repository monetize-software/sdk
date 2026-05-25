import type { LayoutBlock } from '../../../core/types';
import type { BlockProps } from '../types';

type FeaturesListBlock = Extract<LayoutBlock, { type: 'features_list' }>;

export function FeaturesList({ block }: BlockProps<FeaturesListBlock>) {
  if (!block.items.length) return null;
  return (
    <ul class="flex flex-col gap-2.5" role="list">
      {block.items.map((item) => (
        <li key={item.id} class="flex items-start gap-3 text-sm text-gray-700">
          <svg
            width="18"
            height="18"
            viewBox="0 0 20 20"
            fill="none"
            class="mt-0.5 flex-shrink-0 text-emerald-500"
            aria-hidden="true"
          >
            <path
              d="M4 10.5l3.5 3.5 8.5-8.5"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <div class="flex flex-col gap-0.5">
            <span class="font-medium leading-snug text-gray-900">{item.name}</span>
            {item.desc ? (
              <span class="text-xs leading-relaxed text-gray-400">{item.desc}</span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
