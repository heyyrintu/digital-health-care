import { colors, fontSizes, MIN_TOUCH_TARGET, radii, spacing } from '@dhc/tokens';

/** Tokens in the shape React Native styles want; NativeWind takes over with the design system. */
export const theme = { colors, fontSizes, radii, spacing, minTouchTarget: MIN_TOUCH_TARGET };

/** Width at which the Clinic app switches to two panes (iPad and tablets, ADR 0005). */
export const TWO_PANE_MIN_WIDTH = 768;
