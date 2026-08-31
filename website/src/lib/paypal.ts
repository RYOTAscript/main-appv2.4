/**
 * Minimal PayPal Orders v2 client (REST, no SDK). Uses client-credentials to
 * get an access token, then create/capture orders for the one-time $5 license.
 */
import { PRODUCT } from "@/lib/product";

const ENV = (process.env.PAYPAL_ENV ?? "sandbox").toLowerCase();
const BASE =
  ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

export function isPayPalConfigured(): boolean {
  const id = process.env.PAYPAL_CLIENT_ID ?? "";
  const secret = process.env.PAYPAL_CLIENT_SECRET ?? "";
  return (
    !!id &&
    !!secret &&
    !id.includes("your-paypal") &&
    !secret.includes("your-paypal")
  );
}

export function isWebhookConfigured(): boolean {
  return !!process.env.PAYPAL_WEBHOOK_ID;
}

/**
 * Verify a webhook came from PayPal by asking PayPal to check the signature.
 * Requires PAYPAL_WEBHOOK_ID. `event` is the parsed JSON body.
 */
export async function verifyWebhookSignature(
  headers: Headers,
  event: unknown,
): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return false;

  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_algo: headers.get("paypal-auth-algo"),
      cert_url: headers.get("paypal-cert-url"),
      transmission_id: headers.get("paypal-transmission-id"),
      transmission_sig: headers.get("paypal-transmission-sig"),
      transmission_time: headers.get("paypal-transmission-time"),
      webhook_id: webhookId,
      webhook_event: event,
    }),
    cache: "no-store",
  });

  if (!res.ok) return false;
  const data = (await res.json()) as { verification_status?: string };
  return data.verification_status === "SUCCESS";
}

async function getAccessToken(): Promise<string> {
  const id = process.env.PAYPAL_CLIENT_ID!;
  const secret = process.env.PAYPAL_CLIENT_SECRET!;
  const auth = Buffer.from(`${id}:${secret}`).toString("base64");

  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PayPal auth failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export type PayPalOrder = { id: string; approveUrl: string | null };

/**
 * Create a CAPTURE order for the license and return its id + PayPal approval
 * URL (the hosted checkout page we redirect the buyer to). `reference` ties the
 * order to the user; `origin` is the site base URL for the return/cancel links.
 */
export async function createOrder(
  reference: string,
  origin: string,
): Promise<PayPalOrder> {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: reference,
          // custom_id propagates onto the capture resource, so the webhook can
          // recover the user id even without the original order lookup.
          custom_id: reference,
          description: PRODUCT.name,
          amount: {
            currency_code: PRODUCT.currency,
            value: PRODUCT.priceValue,
          },
        },
      ],
      application_context: {
        brand_name: "main",
        user_action: "PAY_NOW",
        shipping_preference: "NO_SHIPPING",
        return_url: `${origin}/api/paypal/return`,
        cancel_url: `${origin}/#pricing`,
      },
    }),
    cache: "no-store",
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `PayPal create-order failed (${res.status}): ${JSON.stringify(data)}`,
    );
  }
  const approve = (data.links as Array<{ rel: string; href: string }>)?.find(
    (l) => l.rel === "approve" || l.rel === "payer-action",
  );
  return { id: data.id, approveUrl: approve?.href ?? null };
}

export type PayPalCapture = {
  orderId: string;
  captureId: string | null;
  status: string;
  amountCents: number;
  currency: string;
};

/** Capture an approved order. Returns the normalized capture result. */
/**
 * Read an order without capturing it, so the caller can check who it belongs to.
 *
 * The order id arrives on the `return_url` as a query parameter, which means the
 * browser handing it to us is not necessarily the browser that started the
 * checkout. `custom_id` carries the buyer's user id (set in createOrder), so the
 * return route compares it against the session before it captures anything —
 * otherwise an approved order id pasted into a second signed-in account would
 * mint that account the license the first one paid for.
 *
 * Returns null when PayPal doesn't recognise the id.
 */
export async function getOrderOwner(orderId: string): Promise<string | null> {
  const token = await getAccessToken();
  const res = await fetch(
    `${BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const unit = data?.purchase_units?.[0];
  return (unit?.custom_id as string | undefined) ?? null;
}

export async function captureOrder(orderId: string): Promise<PayPalCapture> {
  const token = await getAccessToken();
  const res = await fetch(
    // Encoded: orderId comes off a query string, and an unescaped value could
    // otherwise walk to a different PayPal API path.
    `${BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    },
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `PayPal capture failed (${res.status}): ${JSON.stringify(data)}`,
    );
  }

  const capture = data?.purchase_units?.[0]?.payments?.captures?.[0];
  const value = capture?.amount?.value as string | undefined;
  return {
    orderId: data.id,
    captureId: capture?.id ?? null,
    status: data.status, // "COMPLETED" on success
    amountCents: value ? Math.round(parseFloat(value) * 100) : PRODUCT.amountCents,
    currency: capture?.amount?.currency_code ?? PRODUCT.currency,
  };
}
