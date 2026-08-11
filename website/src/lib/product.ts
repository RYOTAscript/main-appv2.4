/** Product facts used across pricing UI + checkout (processor-agnostic). */
export const PRODUCT = {
  name: "main — lifetime license",
  priceUsd: 5,
  priceValue: "5.00", // PayPal amount string
  priceDisplay: "$5",
  amountCents: 500, // stored on Purchase
  currency: "USD",
} as const;
