# ADR 0033: versioned numeric patient assessments

Status: implemented locally, 7 November 2026. Real-host acceptance remains separate.

## Decision

Clinic admins and doctors may publish bounded questionnaires with English and optional
Hindi titles, instructions and question labels. Each form contains 1–20 integer-scale
questions, with distinct identifiers and explicit minimum/maximum values within 0–10.
Publishing fixes that definition permanently. A revision is a new published form;
archiving prevents new assignments and preserves existing assignments/responses.

Only doctors with the clinic's configured chart access may assign, cancel unanswered
assessments, or read patient history. Clinic admins manage definitions without clinical
response access. Front desk and platform operators receive no new clinical privileges.

Patients and guardians answer assigned questionnaires through the authenticated portal.
Current health-data/document consents and family/merged-record ownership are checked on
list and submit. Assignment to a merged or portal-closed record is refused. Responses
against historical merged records remain available through the kept record.

The server validates every question and computes an unweighted raw total plus its
possible range. There are no diagnostic labels, thresholds, licensed instruments,
reverse scoring or automated clinical decisions. Doctors filter by the exact published
form before comparing scores; the chart plots response sequence, oldest first. Different
forms must not be treated as equivalent scales. Localised author text falls back to English
when no Hindi translation was supplied.

## Integrity and privacy

Forms and assignments use caller-generated stable IDs. The same request can recover its
result; conflicting reuse is rejected. Assignment/response transactions use row/advisory
locks. Patient submission and doctor cancellation serialize; only one terminal state wins.
A replay of the same answers returns the retained result, and a different submission is
refused. Completed responses cannot be edited, cancelled or deleted through these routes.
Database triggers retain definitions and terminal response history, enforce same-clinic
references, and restrict the submission lifecycle. Both new tables have tenant RLS.

Answer/score payloads use the existing field encryption. Audit events contain IDs/actions,
not questionnaire answers. Lists are bounded to 50 items with cursor continuation.
Mutations have route limits. Patient data ZIP exports include only owned assessment
definitions and responses, with existing export limits and access checks. Clinical
retention/correction requests continue through the clinic's data-rights process; this
increment does not invent a new automatic erasure policy.

## Web workflow

1. Clinic admin or doctor opens **Assessment forms** and publishes a questionnaire.
2. A doctor opens a patient, selects **Assessments**, and assigns a published form.
3. The patient/guardian selects the relevant family profile and opens **Assessments**.
4. After submission, patient and authorised doctor can view the retained answers/raw score.
5. The doctor filters history to one published form to review repeated scores.

Native apps, provider messages/reminders, validated/licensed scoring packs, branching or
free-text question types and an automated response-correction workflow are outside this
numeric-question increment. These boundaries do not close all remaining PRD work.
