-- HubSpot operational created timestamp.
-- We use old_created_at (custom property) as the business "Fecha de Creación".

alter table public.hubspot_contacts
  add column if not exists old_created_at timestamptz null;

-- Backfill existing rows so analytics remain stable.
update public.hubspot_contacts
set old_created_at = created_at
where old_created_at is null
  and created_at is not null;

create index if not exists hubspot_contacts_old_created_at_idx
  on public.hubspot_contacts (old_created_at);

