/** Body-mass index to one decimal, from weight (kg) and height (cm); null if either is missing. */
export function bmiOf(weightKg: number | null, heightCm: number | null): number | null {
  if (!weightKg || !heightCm) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

/** PRD §6.1: weight is required today for children under 12 (safety rule SR-12). */
export const WEIGHT_REQUIRED_UNDER_YEARS = 12;
