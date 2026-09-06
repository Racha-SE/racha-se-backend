ALTER TABLE "branch_order_detail" ADD COLUMN "available" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "head_order_detail" ADD COLUMN "available" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "branch_order_detail" ADD CONSTRAINT "branch_order_detail_available_nonnegative" CHECK ("branch_order_detail"."available" >= 0);--> statement-breakpoint
ALTER TABLE "head_order_detail" ADD CONSTRAINT "head_order_detail_available_nonnegative" CHECK ("head_order_detail"."available" >= 0);
