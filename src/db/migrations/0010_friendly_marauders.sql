CREATE TYPE "public"."notification_type" AS ENUM('expire', 'min_stock');--> statement-breakpoint
CREATE TABLE "notification" (
	"notification_id" serial PRIMARY KEY NOT NULL,
	"type" "notification_type" NOT NULL,
	"branch_id" integer,
	"p_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"lot_id" integer,
	"expired_date" timestamp,
	"is_resolved" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notification_expire_fields_required" CHECK ("notification"."type" <> 'expire' OR ("notification"."lot_id" IS NOT NULL AND "notification"."expired_date" IS NOT NULL)),
	CONSTRAINT "notification_quantity_nonnegative" CHECK ("notification"."quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_branch_id_branch_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("branch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_p_id_product_p_id_fk" FOREIGN KEY ("p_id") REFERENCES "public"."product"("p_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_lot_id_order_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."order"("lot_id") ON DELETE no action ON UPDATE no action;
