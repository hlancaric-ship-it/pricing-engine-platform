/**
 * discount-lock Shopify Function — cart.lines.discounts.generate.run target.
 *
 * Problem this solves (docs/DISCOUNT-LOCK-PATTERN.md,
 * SHOPIFY-SPIKE-2-PLUS-RESULTS.md section D): a fixed B2B PriceList price
 * is a price override, not a member of the discount-combination system —
 * combinesWith on a competing automatic discount does nothing to protect
 * it, confirmed live (800.0 -> 720.0, combinesWith true or false, same
 * result). The only real enforcement point is a Function that decides,
 * per line, whether it is eligible for discounting at all.
 *
 * Any merchant discount configured to run through this Function computes
 * its candidates only over cart lines whose variant does NOT carry the
 * pricing_engine.locked metafield — set by
 * src/adapters/shopify/index.ts writeLockedPrice() in the same call that
 * writes the fixed price.
 *
 * The discount's own shape (percentage vs fixed, product vs order class)
 * is read from the Discount's pricing_engine.discount_config metafield —
 * this Function does not invent a discount value, it only decides
 * eligibility.
 */
import {
  DiscountClass,
  OrderDiscountSelectionStrategy,
  ProductDiscountSelectionStrategy,
  CartInput,
  CartLinesDiscountsGenerateRunResult,
} from '../generated/api';

interface DiscountConfig {
  type: 'percentage' | 'fixed_amount';
  value: string;
}

function readDiscountConfig(raw: string | null | undefined): DiscountConfig {
  if (!raw) return { type: 'percentage', value: '0.0' };
  try {
    const parsed = JSON.parse(raw);
    return {
      type: parsed.type === 'fixed_amount' ? 'fixed_amount' : 'percentage',
      value: String(parsed.value ?? '0.0'),
    };
  } catch {
    return { type: 'percentage', value: '0.0' };
  }
}

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  if (!input.cart.lines.length) {
    return { operations: [] };
  }

  const hasOrderDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Order,
  );
  const hasProductDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Product,
  );

  if (!hasOrderDiscountClass && !hasProductDiscountClass) {
    return { operations: [] };
  }

  const eligibleLines = input.cart.lines.filter((line) => {
    const merchandise = line.merchandise as any;
    if (merchandise.__typename !== 'ProductVariant') return true;
    return merchandise.lockedMetafield?.value !== 'true';
  });

  if (eligibleLines.length === 0) {
    // Every line is engine-priced and locked — no discount to generate,
    // rather than returning a misleading non-empty operation over nothing.
    return { operations: [] };
  }

  const config = readDiscountConfig(
    (input.discount as any).metafield?.value,
  );
  const value =
    config.type === 'fixed_amount'
      ? { fixedAmount: { amount: config.value } }
      : { percentage: { value: config.value } };

  const operations = [];

  if (hasOrderDiscountClass) {
    operations.push({
      orderDiscountsAdd: {
        candidates: [
          {
            message: 'Pricing engine discount',
            targets: [
              {
                orderSubtotal: {
                  excludedCartLineIds: input.cart.lines
                    .filter((l) => !eligibleLines.includes(l))
                    .map((l) => l.id),
                },
              },
            ],
            value,
          },
        ],
        selectionStrategy: OrderDiscountSelectionStrategy.First,
      },
    });
  }

  if (hasProductDiscountClass) {
    operations.push({
      productDiscountsAdd: {
        candidates: eligibleLines.map((line) => ({
          message: 'Pricing engine discount',
          targets: [{ cartLine: { id: line.id } }],
          value,
        })),
        selectionStrategy: ProductDiscountSelectionStrategy.All,
      },
    });
  }

  return { operations };
}
