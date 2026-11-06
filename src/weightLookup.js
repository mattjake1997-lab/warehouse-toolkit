// Weight per skid (lbs), from the settings file:
//   weights.known     exact weights given by hand; these win
//   weights.averages  averages from past bills of lading
//   weights.vary      parts whose weight varied a lot between loads (flagged "check" in the builder)
import TK from "./settings.js";

const W = TK.weights || {};
const CONFIRMED_WEIGHTS = W.known || {};
const HISTORICAL_AVERAGES = W.averages || {};

export const isKnownWeight = (item) => String(item) in CONFIRMED_WEIGHTS;

export const WEIGHT_PER_SKID = { ...HISTORICAL_AVERAGES, ...CONFIRMED_WEIGHTS };

// Known weights are never flagged, even if past BOLs disagreed with them.
export const UNRELIABLE_WEIGHT_ITEMS = new Set((W.vary || []).map(String).filter((item) => !(item in CONFIRMED_WEIGHTS)));

/** Total weight for a line (skids x lbs per skid), rounded to 10 lbs, or null when the part has no weight yet. */
export function estimateWeight(itemNumber, skids) {
  const perSkid = WEIGHT_PER_SKID[String(itemNumber)];
  if (perSkid == null || !skids) return null;
  return Math.round((perSkid * skids) / 10) * 10;
}
