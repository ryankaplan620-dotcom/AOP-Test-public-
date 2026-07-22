# Shopify design-partner program

AOP's first production cohort is deliberately Shopify-only. The supported path is:

1. Install through Shopify OAuth and require all three webhooks (`orders/create`, `refunds/create`, `orders/cancelled`) to report healthy.
2. Configure one ACP/AP2 proxy hostname and verify an attributed intent and order.
3. Approve a versioned recommendation, run a treatment/control experiment, and retain the rollback record.
4. Aggregate only privacy-suppressed network buckets (minimum three merchants); never expose tenant-level results.

Do not add a native BigCommerce integration until the Shopify cohort has three verified, retained design partners and a measured recommendation outcome.
