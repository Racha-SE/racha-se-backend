ALTER TABLE "customer_order_detail" ADD COLUMN "bod_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_order_detail" ADD CONSTRAINT "customer_order_detail_bod_id_branch_order_detail_bod_id_fk" FOREIGN KEY ("bod_id") REFERENCES "public"."branch_order_detail"("bod_id") ON DELETE no action ON UPDATE no action;
