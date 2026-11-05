# Clinic session changes and operational notices

Use **Clinic session changes** in the staff web menu. Choose one doctor, clinic, date and source time range. Enter an operational reason without private patient information. Preview every affected booking before applying.

- **Cancel:** cancels only future pending/confirmed visits with no financial/clinical records. The source interval is closed to new bookings/walk-ins. Unchanged exceptions need individual review/contact.
- **Move:** choose a destination clinic/date/start with matching free slots for the same doctor and consultation types. Relative spacing is preserved. Billed/prepaid and care-started visits remain unchanged. There is no automatic overbooking or refund. If a target becomes unavailable, the whole batch rolls back; preview another destination.
- **Delay:** choose today's waiting appointments. Record an estimate (0 resets it). Booked times do not move. Staff/patient appointment views show the current estimate.

Check the review confirmation and, when present, the unchanged-appointments acknowledgement. Previews expire after 15 minutes and become stale if their source changes. The apply is atomic; an interrupted response must be recovered using the same operation, not repeated under a new ID. Keep the page open during recovery; after reload use the recent-operation receipt and reference before attempting anything else.

## Configure optional additional notices later

Set `WHATSAPP_OPERATIONS_ENABLED=true` for API and worker when the shared Meta webhook/sender is configured. The worker also needs database/Redis, token, Graph version, `WEB_BASE_URL` as HTTPS, `WHATSAPP_OPERATION_TEMPLATE` and `WHATSAPP_OPERATION_TEMPLATE_LANGUAGE`. Prepare an approved UTILITY template with BODY parameters (1) clinic name (2) patient-portal login URL. This is separate from the static conversational-inbox catalog and from normal confirmation/reminder templates.

Only current appointment-category opt-ins queue these notices; there is no automatic consent grant. Test STOP, contact/guardian changes, portal closure, superseded delays and delivery status with synthetic participants before activation. Notice bodies contain no clinical reason or patient data. The receipt reports queued counts only. Follow up manually with recipients who did not consent, lack contact details or were not reached. Normal replacement confirmations/reminders can still queue independently of the additional-notice checkbox.

The worker dispatcher recovers queued intents, leases publication and authorizes each send once. Expiry skips outdated updates; a crashed/indeterminate send becomes uncertain and must not be blindly requeued. Use the delivery log and existing receipt runbook for reconciliation. This work does not move bills, release prepaid holds or initiate refunds; handle those individual bookings through the existing verified payment/refund workflow.
