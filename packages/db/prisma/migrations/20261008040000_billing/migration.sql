-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('due', 'partly_paid', 'paid');

-- CreateEnum
CREATE TYPE "BillLineKind" AS ENUM ('consultation', 'follow_up', 'item');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('cash', 'upi', 'card');

-- CreateTable
CREATE TABLE "price_list_items" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_paise" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "price_list_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bills" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "doctor_user_id" UUID NOT NULL,
    "subtotal_paise" INTEGER NOT NULL,
    "discount_paise" INTEGER NOT NULL DEFAULT 0,
    "discount_reason" TEXT,
    "total_paise" INTEGER NOT NULL,
    "paid_paise" INTEGER NOT NULL DEFAULT 0,
    "status" "BillStatus" NOT NULL DEFAULT 'due',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_items" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "kind" "BillLineKind" NOT NULL,
    "price_list_item_id" UUID,
    "name" TEXT NOT NULL,
    "unit_paise" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "bill_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "reference" TEXT,
    "receipt_number" TEXT NOT NULL,
    "received_by_user_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_settings" (
    "organisation_id" UUID NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT 'R',
    "next_number" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "receipt_settings_pkey" PRIMARY KEY ("organisation_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "price_list_items_organisation_id_name_key" ON "price_list_items"("organisation_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "bills_appointment_id_key" ON "bills"("appointment_id");

-- CreateIndex
CREATE INDEX "bills_organisation_id_created_at_idx" ON "bills"("organisation_id", "created_at");

-- CreateIndex
CREATE INDEX "bills_patient_id_idx" ON "bills"("patient_id");

-- CreateIndex
CREATE INDEX "bill_items_bill_id_idx" ON "bill_items"("bill_id");

-- CreateIndex
CREATE INDEX "payments_organisation_id_received_at_idx" ON "payments"("organisation_id", "received_at");

-- CreateIndex
CREATE INDEX "payments_bill_id_idx" ON "payments"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_organisation_id_receipt_number_key" ON "payments"("organisation_id", "receipt_number");

-- AddForeignKey
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_price_list_item_id_fkey" FOREIGN KEY ("price_list_item_id") REFERENCES "price_list_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_settings" ADD CONSTRAINT "receipt_settings_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Guard rails the API also checks. Amounts are whole paise; a bill's figures always add up.
ALTER TABLE price_list_items ADD CONSTRAINT price_list_items_price_check
  CHECK (price_paise > 0);
ALTER TABLE bills ADD CONSTRAINT bills_amounts_check
  CHECK (
    subtotal_paise >= 0
    AND discount_paise BETWEEN 0 AND subtotal_paise
    AND total_paise = subtotal_paise - discount_paise
    AND paid_paise BETWEEN 0 AND total_paise
    AND revision > 0
  );
ALTER TABLE bills ADD CONSTRAINT bills_discount_reason_check
  CHECK (discount_paise = 0 OR discount_reason IS NOT NULL);
ALTER TABLE bills ADD CONSTRAINT bills_status_check
  CHECK (status = CASE
    WHEN paid_paise = total_paise THEN 'paid'::"BillStatus"
    WHEN paid_paise > 0 THEN 'partly_paid'::"BillStatus"
    ELSE 'due'::"BillStatus" END);
ALTER TABLE bill_items ADD CONSTRAINT bill_items_amount_check
  CHECK (
    quantity BETWEEN 1 AND 99
    AND unit_paise >= 0
    AND amount_paise = unit_paise * quantity
    AND (kind = 'item') = (price_list_item_id IS NOT NULL)
  );
ALTER TABLE payments ADD CONSTRAINT payments_amount_check CHECK (amount_paise > 0);
ALTER TABLE receipt_settings ADD CONSTRAINT receipt_settings_next_number_check
  CHECK (next_number > 0);

-- Row-level security (ADR 0014). Payments are append-only for the app: a recorded
-- payment and its receipt number never change.
ALTER TABLE price_list_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON price_list_items TO dhc_app;
CREATE POLICY tenant_isolation ON price_list_items TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON bills TO dhc_app;
CREATE POLICY tenant_isolation ON bills TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE bill_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON bill_items TO dhc_app;
CREATE POLICY tenant_isolation ON bill_items TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON payments TO dhc_app;
CREATE POLICY tenant_isolation ON payments TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE receipt_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON receipt_settings TO dhc_app;
CREATE POLICY tenant_isolation ON receipt_settings TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

-- A row must belong to the same organisation as the rows it points at (foreign keys do
-- not see RLS). A bill's patient and doctor must be its visit's. Tables are
-- schema-qualified with a fixed search_path so a temporary table cannot stand in.
CREATE FUNCTION bills_same_tenant() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.appointments a
    WHERE a.id = NEW.appointment_id
      AND a.organisation_id = NEW.organisation_id
      AND a.patient_id = NEW.patient_id
      AND a.doctor_user_id = NEW.doctor_user_id
  ) THEN
    RAISE EXCEPTION 'bill does not match its appointment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bills_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, appointment_id, patient_id, doctor_user_id
  ON bills FOR EACH ROW EXECUTE FUNCTION bills_same_tenant();

-- Lines belong to a bill of the same clinic, point only at that clinic's price list, and
-- are fixed once the bill has a payment (receipts must keep matching the bill).
CREATE FUNCTION bill_items_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- Both sides of a change: a line can neither join nor leave a paid bill.
  IF EXISTS (
    SELECT 1 FROM public.bills b
    WHERE b.paid_paise > 0 AND b.id IN (OLD.bill_id, NEW.bill_id)
  ) THEN
    RAISE EXCEPTION 'bill has a payment and can no longer change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.bills b
    WHERE b.id = NEW.bill_id AND b.organisation_id = NEW.organisation_id
  ) OR (NEW.price_list_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.price_list_items p
    WHERE p.id = NEW.price_list_item_id AND p.organisation_id = NEW.organisation_id
  )) THEN
    RAISE EXCEPTION 'bill line does not match its bill' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bill_items_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bill_items
  FOR EACH ROW EXECUTE FUNCTION bill_items_guard();

CREATE FUNCTION payments_same_tenant() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.bills b
    WHERE b.id = NEW.bill_id AND b.organisation_id = NEW.organisation_id
  ) THEN
    RAISE EXCEPTION 'payment does not match its bill' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_same_tenant
  BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION payments_same_tenant();

-- The other side: a billed visit keeps its organisation, patient and doctor.
CREATE FUNCTION appointments_keep_bills() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.organisation_id, NEW.patient_id, NEW.doctor_user_id)
       IS DISTINCT FROM (OLD.organisation_id, OLD.patient_id, OLD.doctor_user_id)
     AND EXISTS (SELECT 1 FROM public.bills b WHERE b.appointment_id = OLD.id) THEN
    RAISE EXCEPTION 'appointment has a bill' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointments_keep_bills
  BEFORE UPDATE OF organisation_id, patient_id, doctor_user_id
  ON appointments FOR EACH ROW EXECUTE FUNCTION appointments_keep_bills();
