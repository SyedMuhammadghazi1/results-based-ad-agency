CREATE TABLE "pending_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_order_id" text NOT NULL,
	"external_refund_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"charged_gross_minor" bigint,
	"currency" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_refund_amount_positive" CHECK ("pending_refunds"."amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "pending_refunds" ADD CONSTRAINT "pending_refunds_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pending_refunds_dedupe_unique" ON "pending_refunds" USING btree ("org_id","source","external_refund_id");--> statement-breakpoint
CREATE INDEX "pending_refunds_order_idx" ON "pending_refunds" USING btree ("org_id","source","external_order_id");--> statement-breakpoint
CREATE INDEX "pending_refunds_received_idx" ON "pending_refunds" USING btree ("received_at");