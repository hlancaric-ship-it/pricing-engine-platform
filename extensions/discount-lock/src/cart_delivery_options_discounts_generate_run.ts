import {
  DeliveryInput,
  CartDeliveryOptionsDiscountsGenerateRunResult,
} from '../generated/api';

/**
 * Deliberate no-op. discount-lock only protects cart LINES with an active
 * pricing_engine.locked price (see cart_lines_discounts_generate_run.ts) —
 * shipping/delivery discounting is out of scope entirely. This target
 * exists only because `shopify app generate extension --template discount`
 * scaffolds both targets by default; the scaffold's placeholder logic
 * (100% off delivery, unconditional) was a real live-production risk if any
 * discount using this app ever included the SHIPPING discount class, so it
 * is replaced with an explicit no-op rather than deleted (deleting the
 * target file without removing it from shopify.extension.toml would break
 * the build).
 */
export function cartDeliveryOptionsDiscountsGenerateRun(
  _input: DeliveryInput,
): CartDeliveryOptionsDiscountsGenerateRunResult {
  return { operations: [] };
}
