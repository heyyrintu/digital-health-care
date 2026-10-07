/**
 * Completed years between a `YYYY-MM-DD` date of birth and `today` (also `YYYY-MM-DD`,
 * normally the IST date). Babies under one year show months instead.
 */
export function ageFrom(dob: string, today: string): { years: number; months: number } {
  const [by, bm, bd] = dob.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  let months = (ty - by) * 12 + (tm - bm);
  if (td < bd) months -= 1;
  months = Math.max(0, months);
  return { years: Math.floor(months / 12), months };
}
