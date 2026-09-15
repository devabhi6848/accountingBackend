# Accounting Backend

Backend foundation for the accounting data-entry and import system.

## Planned modules

- Company and user management
- Accounts, customers, vendors and products
- Excel/CSV data entry import
- Column mapping and reusable mapping templates
- Customer/vendor and item matching
- Validation and duplicate detection
- GST calculation and validation
- Bulk processing
- Double-entry accounting and ledger
- Inventory movements
- Audit trail

## Development principle

Financial calculations and posting are server-side, deterministic, transactional and auditable. The frontend is treated as a client of this backend and is not the source of truth.

## Current status

Repository initialized. Database schema and Data Entry import APIs are the next implementation milestone.
