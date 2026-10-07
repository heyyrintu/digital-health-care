# Runbook: Cashfree Reconciliation and Payment Issues

**Owner:** Backend lead (technical) · Clinic Admin (business follow-up)

## Nightly job
Pulls settlements, payments and refunds from Cashfree for each organisation; matches to bills; flags mismatches on the Clinic Admin dashboard.

## Mismatch types and actions
| Mismatch | Likely cause | Action |
|---|---|---|
| Paid at Cashfree, bill not Paid | Webhook missed or failed | Re-fetch order status; apply only if the organisation, the stored order-to-bill link, amount and currency all match, otherwise send to manual review; check webhook endpoint health |
| Bill Paid, no Cashfree payment | Wrong manual entry | Clinic Admin reviews; correct with audit note |
| Amount differs | Partial payment or edited bill | Review bill history; contact patient if needed |
| Refund pending > 7 days | Refund processing delay | Check status via API; raise with Cashfree support |
| Settlement short | Gateway fees/chargebacks | Confirm fees in report; review any disputes |

## Patient says "I paid but app shows unpaid"
1. Search bill → check payment attempts and webhook log.
2. Trigger order status check from the admin panel.
3. If Cashfree shows success → the bill updates and a receipt goes out only if the organisation, the stored order-to-bill link, amount and currency match; a mismatch goes to manual review.
4. If Cashfree shows failure → explain; amount usually auto-reversed by the bank; share the reference.
