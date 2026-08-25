DROP TABLE "stock_adjustment" CASCADE;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "cost_price" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "received_at" timestamp;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "customer_order_detail" DROP COLUMN "unit_cost";--> statement-breakpoint
ALTER TABLE "head_order_detail" DROP COLUMN "cost_price";--> statement-breakpoint
DROP TYPE "public"."adjustment_type";
