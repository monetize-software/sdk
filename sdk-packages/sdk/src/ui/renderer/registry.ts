import type { LayoutBlock } from '../../core/types';
import type { BlockComponent } from './types';
import { AuthPanel } from './blocks/AuthPanel';
import { CtaButton } from './blocks/CtaButton';
import { CurrentSession } from './blocks/CurrentSession';
import { FeaturesList } from './blocks/FeaturesList';
import { GuaranteeBadge } from './blocks/GuaranteeBadge';
import { Heading } from './blocks/Heading';
import { OfferBanner } from './blocks/OfferBanner';
import { PriceGrid } from './blocks/PriceGrid';
import { Text } from './blocks/Text';
import { TokenizationGate } from './blocks/TokenizationGate';

export const blockRegistry: Record<LayoutBlock['type'], BlockComponent<any>> = {
  heading: Heading,
  text: Text,
  price_grid: PriceGrid,
  cta_button: CtaButton,
  auth_panel: AuthPanel,
  current_session: CurrentSession,
  features_list: FeaturesList,
  tokenization_gate: TokenizationGate,
  guarantee_badge: GuaranteeBadge,
  offer_banner: OfferBanner
};
