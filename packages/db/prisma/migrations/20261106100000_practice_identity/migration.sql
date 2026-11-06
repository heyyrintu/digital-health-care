-- Tenant isolation restricts organisation rows to the current clinic.
-- Permit only name and its modification timestamp; status and slug stay protected.
GRANT UPDATE (name, updated_at) ON organisations TO dhc_app;
