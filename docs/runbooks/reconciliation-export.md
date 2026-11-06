# Settlement reconciliation CSV exports

Clinic admin → **Settlement reconciliation** → select a completed successful report →
**Download settlements CSV** or **Download issues CSV**.

The file contains the complete selected snapshot, not just rows currently loaded on the
screen. Each file is limited to 5,000 rows; larger reports must be requested for a smaller
date interval. A queued/running/failed report cannot be exported. Exports are private,
uncacheable, rate-limited and audited; another clinic's report remains inaccessible.

Amounts are exact integer **INR paise**. Divide by 100 when converting to rupees in an
accounting import. No floating-point conversion is used. Files identify the run, sandbox
or production environment and source date interval. A review acknowledgement is recorded
with its reason and timestamp; it does not resolve discrepancies or alter money, bills,
receipts, refunds or settlement state. Bank-statement matching remains separate work.

CSV uses UTF-8 with a BOM, CRLF rows and quoted/escaped fields. Provider-controlled text
that could start a spreadsheet formula is prefixed with an apostrophe. Import identifiers,
UTRs and provider references as **text** to preserve long numbers and leading zeroes.
Treat these exports as private financial records and use your normal restricted storage.

Endpoints: authenticated clinic-admin GET
`/v1/reconciliation/runs/{id}/export/settlements` and
`/v1/reconciliation/runs/{id}/export/issues`.
